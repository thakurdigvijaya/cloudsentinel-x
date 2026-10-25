// P1 engine tests: 14–15 Closest Call, 19 Safe Alternative, 20 break point (+ edge cases), 3-way comparison, Passport.
import { describe, expect, it } from 'vitest';
import { buildFixtures } from '../../data/fixtures';
import { analyzeAll } from '../index';
import { limitsFor } from '../config';
import { breakPoint, closestCall, compareConfigurations, safeAlternative, withExtraWorkload } from '../challenge';
import { evaluateSize } from '../foresight';
import { approve } from '../decisions';
import { buildPassport, passportToMarkdown, PASSPORT_DISCLAIMER } from '../passport';
import { cheaperCatalogSizes } from '../pricing';
import { applyScenario } from '../scenarios';
import type { Size } from '../types';

const { resources, series } = buildFixtures();
const { recommendations } = analyzeAll(resources, series);
const rec = (id: string) => recommendations.find((r) => r.resourceId === id)!;
const res = (id: string) => resources.find((r) => r.id === id)!;
const sizeOf = (id: string): Size => ({ vcpu: res(id).vcpu!, ramGb: res(id).ramGb! });
const PASS = 'PASS_UNDER_TESTED_CONDITIONS';

describe('E8 — memory must fit (no RAM exhaustion)', () => {
  it('applies the configured 98% memory reserve and blocks the memory-heavy VM', () => {
    const r = rec('vm-prod-memheavy');
    const e8 = r.checks.find((c) => c.id === 'E8')!;
    expect(e8.limit).toBe(limitsFor('prod').memMax);
    expect(e8.limit).toBe(98); // current E8 policy, not the legacy 100% exhaustion limit
    expect(e8.passed).toBe(false);
  });
});

describe('Test 14 — Closest Call on a passing resize', () => {
  const id = 'vm-dev-underutil';
  const s = series.get(id)!;
  const target = rec(id).proposed.size!;
  const cc = closestCall(s, s.start, sizeOf(id), target, 'dev');

  it('is the sample with the smallest headroom to the hard limits (checked by brute force)', () => {
    expect(cc.kind).toBe('closest-call');
    if (cc.kind !== 'closest-call') return;
    const fc = sizeOf(id).vcpu / target.vcpu;
    const fm = sizeOf(id).ramGb / target.ramGb;
    let min = Infinity;
    s.cpuPct.forEach((c, i) => {
      if (c !== null) min = Math.min(min, limitsFor('dev').cpuMax - c * fc);
      const m = s.memPct[i];
      if (m !== null) min = Math.min(min, limitsFor('dev').memMax - m * fm);
    });
    expect(cc.headroomPts).toBeCloseTo(min, 6);
    expect(cc.headroomPts).toBeCloseTo(cc.limitPct - cc.projectedPct, 6);
    expect(cc.at).toMatch(/^2026-(09|10)-\d\d \d\d:\d\d IST$/);
  });
});

describe('Test 15 — Closest Call on a failing resize shows the first breach', () => {
  it('bursty prod and memory-heavy prod → first-breach, never "closest-call"', () => {
    for (const id of ['vm-prod-bursty', 'vm-prod-memheavy']) {
      const s = series.get(id)!;
      const cc = closestCall(s, s.start, sizeOf(id), rec(id).proposed.size!, 'prod');
      expect(cc.kind).toBe('first-breach');
      if (cc.kind === 'first-breach') expect(cc.projectedPct).toBeGreaterThan(cc.limitPct);
    }
  });
});

describe('Test 19 — Safe Alternative', () => {
  it('under +60% the 4/16 resize fails; the alternative is the cheapest size passing ALL checks (brute force)', () => {
    const id = 'vm-dev-underutil';
    const usage = applyScenario(series.get(id)!, 'traffic60');
    const alt = safeAlternative(usage, sizeOf(id), { vcpu: 4, ramGb: 16 }, 'dev', 'bengaluru');
    const expected = cheaperCatalogSizes(sizeOf(id), 'bengaluru').find((sz) => evaluateSize(usage, sizeOf(id), sz, 'dev').verdict === PASS);
    expect(alt.whyOriginalFailed.length).toBeGreaterThan(0);
    if (expected) {
      expect(alt.kind).toBe('found');
      if (alt.kind === 'found') {
        expect(alt.option.size).toEqual(expected);
        expect(alt.option.evaluation.verdict).toBe(PASS);
        expect(alt.option.savingInr).toBeGreaterThan(0);
      }
    } else {
      expect(alt.kind).not.toBe('found'); // never invents a size
    }
  });
  it('bursty prod VM → no cheaper safe size, current size passes → "keep-current" (never invents one)', () => {
    const id = 'vm-prod-bursty';
    const alt = safeAlternative(series.get(id)!, sizeOf(id), rec(id).proposed.size!, 'prod', 'mumbai');
    expect(alt.kind).toBe('keep-current');
    if (alt.kind === 'keep-current') {
      expect(alt.current.evaluation.verdict).toBe(PASS);
      expect(alt.message).toMatch(/No cheaper catalog size passes/);
    }
  });
});

describe('Test 20 — break point and its edge cases', () => {
  it('found: passes at lastPassing%, fails at percent (verified directly)', () => {
    const id = 'vm-dev-underutil';
    const s = series.get(id)!;
    const target = rec(id).proposed.size!;
    const b = breakPoint(s, sizeOf(id), target, 'dev');
    expect(b.kind).toBe('found');
    if (b.kind !== 'found') return;
    expect(b.percent).toBe(b.lastPassingPercent + 1);
    expect(evaluateSize(withExtraWorkload(s, b.lastPassingPercent), sizeOf(id), target, 'dev').verdict).toBe(PASS);
    expect(evaluateSize(withExtraWorkload(s, b.percent), sizeOf(id), target, 'dev').verdict).toBe('FAIL_SAFETY_CHECKS');
    expect(b.percent).toBeLessThanOrEqual(60); // consistent with test 10 (fails at +60%)
  });
  it('already failing → says so, no percentage', () => {
    const id = 'vm-prod-bursty';
    const b = breakPoint(series.get(id)!, sizeOf(id), rec(id).proposed.size!, 'prod');
    expect(b.kind).toBe('already-failing');
    expect('percent' in b).toBe(false);
  });
  it('no crossing within 0–200% → "none-found"', () => {
    const id = 'vm-dev-underutil';
    const b = breakPoint(series.get(id)!, sizeOf(id), sizeOf(id), 'dev'); // keep the current 8/32 size
    expect(b).toEqual({ kind: 'none-found', testedUpToPercent: 200 });
  });
  it('insufficient evidence → no percentage', () => {
    const id = 'vm-stg-gappy';
    const b = breakPoint(series.get(id)!, sizeOf(id), { vcpu: 4, ramGb: 16 }, 'staging');
    expect(b.kind).toBe('insufficient-evidence');
  });
});

describe('Three-way comparison: current vs cheapest vs cheapest safe', () => {
  it('the cheapest size is not always acceptable', () => {
    const c = compareConfigurations(res('vm-dev-underutil'), series.get('vm-dev-underutil')!, 'normal');
    expect(c.current.evaluation.verdict).toBe(PASS);
    expect(c.cheapest!.size).toEqual({ vcpu: 1, ramGb: 2 });
    expect(c.cheapest!.evaluation.verdict).toBe('FAIL_SAFETY_CHECKS');
    expect(c.cheapestSafe!.size).toEqual(rec('vm-dev-underutil').proposed.size);
    expect(c.cheapestSafe!.monthlyCostInr).toBeGreaterThan(c.cheapest!.monthlyCostInr);
  });
  it('changing the scenario changes the answer (same engine)', () => {
    const normal = compareConfigurations(res('vm-dev-underutil'), series.get('vm-dev-underutil')!, 'normal');
    const heavy = compareConfigurations(res('vm-dev-underutil'), series.get('vm-dev-underutil')!, 'traffic60');
    expect(heavy.cheapestSafe?.size).not.toEqual(normal.cheapestSafe?.size);
  });
});

describe('Evidence Passport', () => {
  it('passing resize: numbers equal the recommendation, 6 scenarios run, closest call + break point present', () => {
    const r = rec('vm-dev-underutil');
    const d = approve({}, r, '2026-10-24T10:00:00Z').decisions[r.id];
    const p = buildPassport(res('vm-dev-underutil'), series.get('vm-dev-underutil'), r, d);
    expect(p.recommendation.monthlySavingInr).toBe(r.monthlySavingInr);
    expect(p.costs.currentInr).toBe(r.current.monthlyCostInr);
    expect(p.scenarioRuns).toHaveLength(6);
    expect(p.scenarioRuns.find((s) => s.scenario === 'traffic60')!.verdict).toBe('FAIL_SAFETY_CHECKS');
    expect(p.closestCall?.kind).toBe('closest-call');
    expect(p.breakPoint?.kind).toBe('found');
    expect(p.safeAlternative).toBeNull();
    expect(p.approval.status).toBe('approved');
    expect(p.approval.approvedSavingInr).toBeCloseTo(r.monthlySavingInr, 2);
    expect(p.disclaimer).toBe(PASSPORT_DISCLAIMER);
  });
  it('failing resize: never claims PASS, includes the safe-alternative search result', () => {
    const r = rec('vm-prod-bursty');
    const p = buildPassport(res('vm-prod-bursty'), series.get('vm-prod-bursty'), r);
    expect(p.recommendation.verdict).toBe('FAIL_SAFETY_CHECKS');
    expect(p.safeAlternative).not.toBeNull();
    expect(p.approval.approvedSavingInr).toBe(0);
    const md = passportToMarkdown(p);
    expect(md).toContain('FAIL SAFETY CHECKS');
    expect(md).not.toContain('PASS UNDER TESTED CONDITIONS · **Risk');
    expect(md).toContain('Already failing at the current workload');
  });
  it('non-VM resources get a minimal passport (no invented scenarios)', () => {
    const p = buildPassport(res('vol-orphan'), undefined, rec('vol-orphan'));
    expect(p.scenarioRuns).toHaveLength(0);
    expect(p.closestCall).toBeNull();
    expect(passportToMarkdown(p)).toContain('Delete volume');
  });
});
