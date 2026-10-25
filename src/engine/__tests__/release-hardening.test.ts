import { describe, expect, it } from 'vitest';
import { generateDataset } from '../../data/generator';
import { analyzeAll } from '../index';
import { approvedSaving, recheckApprovedEvidence, recheckHeldApprovals, type Decisions } from '../decisions';
import { eventTimingSummary } from '../eventFinance';
import { applyUtsav, utsavCheck } from '../utsav';

const dataset = generateDataset();
const recs = analyzeAll(dataset.resources, dataset.series).recommendations;
const testAt = '2026-10-25T00:00:00.000Z';

describe('Utsav approval revalidation after applying new evidence', () => {
  it('holds a previously-approved resize and never counts it as immediately executable saving', () => {
    const rec = recs.find((r) => r.eligible && r.steps.some((s) => s.action === 'resize'))!;
    expect(rec).toBeDefined();
    const decisions: Decisions = { [rec.id]: { recommendationId: rec.id, status: 'approved', acceptedSteps: ['resize'], at: testAt } };
    const held = { ...rec, holdUntil: '2026-11-11' };
    expect(approvedSaving(rec, decisions)).toBeGreaterThan(0);
    expect(approvedSaving(held, decisions)).toBe(0);
    const rechecked = recheckHeldApprovals(decisions, [held], testAt);
    expect(rechecked[rec.id].status).toBe('needs-review');
    expect(rechecked[rec.id].note).toMatch(/held until 2026-11-11/);
    expect(approvedSaving(held, rechecked)).toBe(0);
  });

  it('flags an old approval when renewed metrics no longer justify the approved step', () => {
    const rec = recs.find((r) => r.eligible && r.steps.some((step) => step.action === 'resize'))!;
    const decisions: Decisions = { [rec.id]: { recommendationId: rec.id, status: 'approved', acceptedSteps: ['resize'], at: testAt } };
    expect(recheckApprovedEvidence(decisions, [rec], testAt)).toBe(decisions);
    const invalid = { ...rec, eligible: false, validSteps: [] };
    const reviewed = recheckApprovedEvidence(decisions, [invalid], testAt);
    expect(reviewed[rec.id].status).toBe('needs-review');
    expect(approvedSaving(invalid, reviewed)).toBe(0);
  });

  it('keeps a separately eligible scheduling-only approval when resize is held', () => {
    const rec = recs.find((r) => r.eligible && r.action === 'resize+schedule')!;
    expect(rec).toBeDefined();
    const decision: Decisions = { [rec.id]: { recommendationId: rec.id, status: 'approved', acceptedSteps: ['schedule'], at: testAt } };
    const held = { ...rec, holdUntil: '2026-11-11' };
    expect(recheckHeldApprovals(decision, [held], testAt)).toBe(decision);
    expect(approvedSaving(held, decision)).toBeGreaterThan(0);
  });

  it('separates planned-after-event and immediate opportunities without changing baseline pricing', () => {
    const report = utsavCheck(dataset.resources, dataset.series, recs, [{
      id: 'diwali-test', name: 'Diwali test', start: '2026-11-05', end: '2026-11-10', loadMultiplier: 2,
    }], '2026-10-25');
    expect(report.errors).toHaveLength(0);
    const held = applyUtsav(recs, report);
    const timing = eventTimingSummary(held, {});
    expect(timing.deferredEligibleInr).toBeGreaterThan(0);
    expect(timing.eligiblePlannedInr).toBeCloseTo(timing.eligibleNowInr + timing.deferredEligibleInr, 2);
  });
});
