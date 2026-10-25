import { describe, expect, it } from 'vitest';
import { generateDataset } from '../../data/generator';
import { approve, approveCoordinated, recheckApprovedDependencies, aggregate } from '../decisions';
import { analyzeAll } from '../index';
import { approvalDependencyConflicts } from '../dependencies';
import { buildPortfolio } from '../portfolio';
import { dataChecks, evaluateSize } from '../foresight';
import { applyScenario } from '../scenarios';
import { withExtraWorkload } from '../challenge';
import { importJsonDataset } from '../importer';

const data = generateDataset();
const analysis = analyzeAll(data.resources, data.series);
const context = { resources: data.resources, recommendations: analysis.recommendations };
const rec = (id: string) => analysis.recommendations.find(r => r.resourceId === id)!;

describe('Dependency-aware real approval and portfolio', () => {
  it('rejects provider shutdown if dependent is merely eligible, not approved', () => {
    const r = approve({}, rec('vm-057'), 'now', ['schedule'], context);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/vm-056/);
  });
  it('allows compatible cycle only as a coordinated atomic approval', () => {
    const result = approveCoordinated({}, [
      { rec: rec('vm-056'), steps: ['schedule'] },
      { rec: rec('vm-057'), steps: ['schedule'] },
    ], 'now', context);
    expect(result.ok).toBe(true);
    expect(approvalDependencyConflicts(data.resources, analysis.recommendations, result.decisions)).toHaveLength(0);
  });
  it('does not save a half-approved bundle when one selected action fails', () => {
    const result = approveCoordinated({}, [
      { rec: rec('vm-056'), steps: ['schedule'] },
      { rec: rec('vm-057'), steps: ['resize'] },
    ], 'now', context);
    expect(result.ok).toBe(false);
    expect(Object.keys(result.decisions)).toHaveLength(0);
  });
  it('marks provider needs-review if dependent approval is undone', () => {
    const done = approveCoordinated({}, [
      { rec: rec('vm-056'), steps: ['schedule'] },
      { rec: rec('vm-057'), steps: ['schedule'] },
    ], 'now', context);
    expect(done.ok).toBe(true);
    const removed = { ...done.decisions };
    delete removed[rec('vm-056').id];
    const reviewed = recheckApprovedDependencies(removed, context, 'later');
    expect(reviewed[rec('vm-057').id].status).toBe('needs-review');
    expect(aggregate(data.resources, analysis.recommendations, reviewed).needsReview).toContain(rec('vm-057').id);
  });
  it('portfolio plans are dependency safe at every risk appetite', () => {
    for (const budget of [20, 60, 150, 999]) {
      const portfolio = buildPortfolio(analysis.recommendations, budget, data.resources);
      const bundle = approveCoordinated({}, portfolio.choice.chosen.map(item => ({
        rec: rec(item.resourceId), steps: item.steps as ('remove' | 'resize' | 'schedule')[],
      })), 'now', context);
      // 0/1 candidate cases can use no changes; all positive budgets here have multiple selected candidates.
      expect(bundle.ok).toBe(true);
      expect(approvalDependencyConflicts(data.resources, analysis.recommendations, bundle.decisions)).toHaveLength(0);
    }
  });
});

describe('Explicit timestamp freshness for live/imported data', () => {
  const raw = data.series.get('vm-001')!;
  it('preserves historical synthetic replay while not claiming it is live', () => {
    expect(dataChecks(raw, 'dev').checks.find(c => c.id === 'E7')?.passed).toBe(true);
  });
  it('marks old imported telemetry stale relative to the actual analysis clock', () => {
    const s = { ...raw, analysisTime: '2026-10-25T00:00:00+05:30' };
    const e = dataChecks(s, 'dev');
    expect(e.checks.find(c => c.id === 'E7')?.passed).toBe(false);
    expect(e.lastSampleAgeHours).toBeGreaterThan(24);
    expect(evaluateSize(s, { vcpu: 8, ramGb: 32 }, { vcpu: 8, ramGb: 32 }, 'dev').verdict).not.toBe('PASS_UNDER_TESTED_CONDITIONS');
  });
  it('does not treat future-dated readings as fresh', () => {
    const s = { ...raw, analysisTime: '2026-09-01T00:00:00+05:30' };
    expect(dataChecks(s, 'dev').checks.find(c => c.id === 'E7')?.passed).toBe(false);
  });
  it('retains freshness context during workload simulation and slider changes', () => {
    const s = { ...raw, analysisTime: '2026-10-25T00:00:00+05:30' };
    expect(dataChecks(applyScenario(s, 'traffic60'), 'dev').ok).toBe(false);
    expect(dataChecks(withExtraWorkload(s, 25), 'dev').ok).toBe(false);
  });
});

describe('Defensive JSON import', () => {
  it('rejects duplicate resource ids and duplicate series without mixing approvals', () => {
    const r = data.resources.find(x => x.type === 'vm')!;
    const s = data.series.get(r.id)!;
    expect(importJsonDataset(JSON.stringify({ resources: [r, r], series: [s] })).ok).toBe(false);
    expect(importJsonDataset(JSON.stringify({ resources: [r], series: [s, s] })).ok).toBe(false);
  });
  it('rejects malformed timestamps, missing arrays and unknown dependencies', () => {
    const r = data.resources.find(x => x.type === 'vm')!;
    const s = data.series.get(r.id)!;
    expect(importJsonDataset(JSON.stringify({ resources: [r], series: [{ ...s, start: 'bogus' }] })).ok).toBe(false);
    expect(importJsonDataset(JSON.stringify({ resources: [r], series: [{ ...s, memPct: null }] })).ok).toBe(false);
    expect(importJsonDataset(JSON.stringify({ resources: [{ ...r, dependsOn: ['ghost'] }], series: [s] })).ok).toBe(false);
  });
});

describe('ProofGate explains decisions without claiming production safety', () => {
  it('keeps recorded shutdown dependencies in the human-review gate', async () => {
    const { evaluateProofGate } = await import('../proofgate');
    const gate = evaluateProofGate(rec('vm-057'), data.resources, analysis.recommendations);
    expect(gate.verdict).toBe('requires-review');
    expect(gate.gates.find(g => g.name === 'Dependency safety')?.state).toBe('review');
  });
  it('reconciles the money directly from the shared pricing engine', async () => {
    const { evaluateProofGate } = await import('../proofgate');
    const r = rec('vm-057');
    expect(evaluateProofGate(r, data.resources, analysis.recommendations).gates.find(g => g.name === 'Financial verification')?.state).toBe('pass');
    expect(evaluateProofGate({ ...r, monthlySavingInr: r.monthlySavingInr + 1000 }, data.resources, analysis.recommendations)
      .gates.find(g => g.name === 'Financial verification')?.state).toBe('blocked');
  });
});
