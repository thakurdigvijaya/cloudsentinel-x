// Dependency Shield (assumptions §X): never switch off something another running resource needs.
import { describe, expect, it } from 'vitest';
import { makeSeries, type Shape } from '../../data/fixtures';
import { generateDataset } from '../../data/generator';
import { aggregate, analyzeAll } from '../index';
import { approve, adoptPlanningAssumptions } from '../decisions';
import { directDependents, transitiveDependents } from '../dependencies';
import { previewRecommendation, revalidate } from '../scenarios';
import { savingFor } from '../plan';
import { isBusinessSample, sampleInfo } from '../time';
import type { Resource } from '../types';

const vm = (id: string, env: Resource['env'], dependsOn?: string[], size = { vcpu: 4, ramGb: 16 }): Resource => ({
  id, name: id, type: 'vm', region: 'mumbai', env, team: 't', createdAt: '2025-11-01', pattern: 'test', ...size, ...(dependsOn ? { dependsOn } : {}),
});
const IDLE: Shape = { cpu: () => 1.5, mem: () => 20, net: () => 0.3 };
const OFFICE: Shape = { cpu: (i) => (isBusinessSample(i) ? 50 : 2), mem: () => 60, net: (i) => (isBusinessSample(i) ? 15 : 0.4) };
const BUSY: Shape = { cpu: () => 60, mem: () => 60, net: () => 20 };
const NIGHT_BATCH: Shape = { cpu: (i) => (sampleInfo(i).hour < 6 ? 90 : 10), mem: () => 50, net: () => 5 };
const run = (list: [Resource, Shape][]) =>
  analyzeAll(list.map(([r]) => r), new Map(list.map(([r, s], k) => [r.id, makeSeries(r.id, 50 + k, s)])));
const recOf = (a: ReturnType<typeof run>, id: string) => a.recommendations.find((r) => r.resourceId === id)!;

describe('Graph helpers', () => {
  it('direct and transitive dependents; cycles terminate; self-edges ignored', () => {
    const rs = [vm('a', 'dev', ['b']), vm('b', 'dev', ['c']), vm('c', 'dev', ['a', 'c']), vm('d', 'dev', ['c'])];
    const d = directDependents(rs);
    expect(d.get('c')).toEqual(['b', 'd']);
    expect(transitiveDependents('c', d).sort()).toEqual(['a', 'b', 'd']);
    expect(transitiveDependents('a', d)).not.toContain('a');
  });
});

describe('Gate decisions', () => {
  it('idle VM that a running prod VM depends on → stop BLOCKED (FAIL, G1 names the dependent), saving not eligible', () => {
    const a = run([[vm('licence', 'dev'), IDLE], [vm('api', 'prod', ['licence']), BUSY]]);
    const r = recOf(a, 'licence');
    expect(r.action).toBe('stop');
    expect(r.verdict).toBe('FAIL_SAFETY_CHECKS');
    expect(r.eligible).toBe(false);
    expect(r.checks.find((c) => c.id === 'G1')).toMatchObject({ passed: false, actual: 1 });
    expect(r.reasons[0]).toMatch(/Blocked by Dependency Shield: api \(prod\) depends on this VM/);
    expect(approve({}, r, 'now').ok).toBe(false);
  });

  it('transitive: prod → app → idle db; the db stop is blocked through the chain', () => {
    const a = run([[vm('db', 'dev'), IDLE], [vm('app', 'staging', ['db']), BUSY], [vm('api', 'prod', ['app']), BUSY]]);
    expect(recOf(a, 'db').reasons[0]).toMatch(/app \(staging\), api \(prod\)/);
  });

  it('night batch depends on an office-hours VM → its night schedule is BLOCKED', () => {
    const a = run([[vm('svc', 'staging'), OFFICE], [vm('batch', 'staging', ['svc']), NIGHT_BATCH]]);
    const r = recOf(a, 'svc');
    expect(r.action).toBe('schedule');
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toMatch(/would keep running while it is off/);
  });

  it('dependents that are off at the same times → ALLOWED (cycle of two office-hours VMs), with a note', () => {
    const a = run([[vm('x', 'dev', ['y']), OFFICE], [vm('y', 'dev', ['x']), OFFICE]]);
    for (const id of ['x', 'y']) {
      const r = recOf(a, id);
      expect(r.eligible).toBe(true);
      expect(r.reasons.join(' ')).toMatch(/Dependency Shield: all 1 recorded dependent\(s\)/);
    }
  });

  it('a dependent that is stopped too → the provider may stop; a weekends-only dependent does NOT cover a nights schedule', () => {
    const a = run([[vm('p', 'dev'), IDLE], [vm('q', 'dev', ['p']), IDLE]]);
    expect(recOf(a, 'p').eligible).toBe(true);
    const WEEKEND_IDLE: Shape = { cpu: (i) => (sampleInfo(i).weekday < 5 ? 40 : 2), mem: () => 60, net: (i) => (sampleInfo(i).weekday < 5 ? 12 : 0.4) };
    const b = run([[vm('p2', 'dev'), OFFICE], [vm('q2', 'dev', ['p2']), WEEKEND_IDLE]]);
    expect(recOf(b, 'q2').scheduleWindow).toBe('weekends');
    expect(recOf(b, 'p2').eligible).toBe(false); // p2 would be off on weeknights while q2 runs
  });

  it('resize+schedule with a blocked schedule: the resize can still be approved on its own; money counts only the resize', () => {
    const big = { vcpu: 8, ramGb: 32 };
    const OVERSIZED_OFFICE: Shape = { cpu: (i) => (isBusinessSample(i) ? 18 : 2), mem: () => 30, net: (i) => (isBusinessSample(i) ? 12 : 0.4) };
    const list: [Resource, Shape][] = [[vm('o', 'staging', undefined, big), OVERSIZED_OFFICE], [vm('n', 'staging', ['o']), NIGHT_BATCH]];
    const a = run(list);
    const r = recOf(a, 'o');
    expect(r.action).toBe('resize+schedule');
    expect(r.blockedSteps).toEqual(['schedule']);
    expect(r.validSteps).toEqual(['resize']);
    expect(r.reasons[0]).toMatch(/The resize step can still be approved on its own/);
    expect(approve({}, r, 'now', ['schedule']).ok).toBe(false);
    const ok = approve({}, r, 'now', ['resize']);
    expect(ok.ok).toBe(true);
    const t = aggregate(list.map(([x]) => x), a.recommendations, ok.decisions);
    expect(t.approvedInr).toBeCloseTo(savingFor(r, ['resize']), 2);
    expect(t.byResource['o'].eligibleInr).toBeCloseTo(savingFor(r, ['resize']), 2);
    // a Challenge Lab preview / adopt never re-enables the blocked schedule
    const p = previewRecommendation(list[0][0], makeSeries('o', 50, OVERSIZED_OFFICE), r, 'normal');
    expect(p.eligible).toBe(false);
    expect(p.validSteps).not.toContain('schedule');
    const adopted = adoptPlanningAssumptions(a.recommendations, ok.decisions, [revalidate(r, p)], 'now');
    expect(adopted.decisions[r.id].status).toBe('approved'); // resize-only approval stays valid
  });

  it('no dependency data at all → nothing changes (shutdowns still need a human)', () => {
    const a = run([[vm('solo', 'dev'), IDLE]]);
    const r = recOf(a, 'solo');
    expect(r.eligible).toBe(true);
    expect(r.requiresHumanReview).toBe(true);
    expect(r.checks.some((c) => c.id === 'G1')).toBe(false);
  });
});

describe('On the dataset', () => {
  const d = generateDataset();
  const a = analyzeAll(d.resources, d.series);
  it('exactly the two documented blocks happen, and the cycle is allowed', () => {
    const blocked = a.recommendations.filter((r) => r.checks.some((c) => c.id === 'G1'));
    expect(blocked.map((r) => d.patternOf.get(r.resourceId)).sort()).toEqual(['idle', 'office-hours']);
    const cyc = d.resources.filter((r) => r.env === 'dev' && r.pattern === 'office-hours').slice(0, 2);
    for (const r of cyc) expect(a.recommendations.find((x) => x.resourceId === r.id)!.eligible).toBe(true);
  });
});
