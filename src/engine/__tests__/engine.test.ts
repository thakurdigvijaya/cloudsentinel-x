// Mandatory tests 1–12 (phases.md). First four = ChatGPT tests A–D:
// A safe → test 1/10 · B unsafe → tests 2–4 · C missing evidence → test 5/12 · D money → test 6.
import { describe, expect, it } from 'vitest';
import { buildFixtures } from '../../data/fixtures';
import { analyzeAll } from '../index';
import { analyzeResource } from '../recommend';
import { offHoursFraction } from '../config';
import { resizeSaving, resizeScheduleSaving, scheduleSaving, vmMonthlyCost } from '../pricing';
import { aggregate, approve, reject } from '../decisions';
import { previewRecommendation } from '../scenarios';
import type { MetricSeries, Recommendation, Resource } from '../types';

const { resources, series } = buildFixtures();
const analysis = analyzeAll(resources, series);
const rec = (id: string): Recommendation => {
  const found = analysis.recommendations.find((r) => r.resourceId === id);
  if (!found) throw new Error(`no recommendation for ${id}`);
  return found;
};
const res = (id: string) => resources.find((r) => r.id === id)!;

describe('Test 1 — idle and wasteful resources are identified', () => {
  it('idle dev VM → stop, PASS, needs human review', () => {
    const r = rec('vm-dev-idle');
    expect(r.action).toBe('stop');
    expect(r.verdict).toBe('PASS_UNDER_TESTED_CONDITIONS');
    expect(r.requiresHumanReview).toBe(true);
  });
  it('orphaned volume → delete-volume; unused IP → release-ip', () => {
    expect(rec('vol-orphan').action).toBe('delete-volume');
    expect(rec('ip-unused').action).toBe('release-ip');
  });
  it('(test A) genuinely underutilized dev VM → justified resize that PASSes', () => {
    const r = rec('vm-dev-underutil');
    expect(r.action).toBe('resize');
    expect(r.proposed.size).toEqual({ vcpu: 4, ramGb: 16 });
    expect(r.verdict).toBe('PASS_UNDER_TESTED_CONDITIONS');
    expect(r.eligible).toBe(true);
  });
  it('healthy busy prod VM and nightly batch VM → no action', () => {
    expect(rec('vm-prod-healthy').action).toBe('none');
    expect(rec('vm-stg-batch').action).toBe('none');
  });
});

describe('Test 2 — bursty production workload is detected', () => {
  it('burstiness > 3 and risk is not low', () => {
    const r = rec('vm-prod-bursty');
    expect(r.evidence.burstiness!).toBeGreaterThan(3);
    expect(r.risk).not.toBe('low');
  });
});

describe('Test 3 — (test B) unsafe CPU resize is blocked', () => {
  it('bursty prod VM is not downsized: FAIL SAFETY CHECKS naming CPU p99', () => {
    const r = rec('vm-prod-bursty');
    expect(r.verdict).toBe('FAIL_SAFETY_CHECKS');
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/CPU p99/);
    // its average is low — a naive average-based tool would have shrunk it
    expect(r.evidence.cpu!.mean).toBeLessThan(15);
  });
});

describe('Test 4 — unsafe memory resize is blocked', () => {
  it('memory-heavy VM with low CPU → FAIL naming memory, not CPU', () => {
    const r = rec('vm-prod-memheavy');
    expect(r.verdict).toBe('FAIL_SAFETY_CHECKS');
    expect(r.reasons.join(' ')).toMatch(/Memory p99/);
    expect(r.reasons.join(' ')).not.toMatch(/CPU p99/);
  });
});

describe('Test 5 — (test C) missing data is never marked safe', () => {
  it('~60% coverage → INSUFFICIENT EVIDENCE, not eligible', () => {
    const r = rec('vm-stg-gappy');
    expect(r.evidence.coverage).toBeLessThan(0.85);
    expect(r.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(r.eligible).toBe(false);
  });
});

describe('Test 6 — (test D) cost calculations follow assumptions.md', () => {
  it('B1/B2 prices', () => {
    expect(vmMonthlyCost({ vcpu: 8, ramGb: 32 }, 'mumbai')).toBe(11360);
    expect(vmMonthlyCost({ vcpu: 4, ramGb: 8 }, 'noida')).toBe(4028);
  });
  it('H1 resize saving', () => {
    expect(rec('vm-dev-underutil').monthlySavingInr).toBe(11360 - 5680);
  });
  it('H2 schedule saving = price × off-hours fraction (≈0.6433)', () => {
    expect(offHoursFraction()).toBeCloseTo(0.6433, 4);
    const r = rec('vm-dev-officehours');
    expect(r.action).toBe('schedule');
    expect(r.monthlySavingInr).toBeCloseTo(4028 * offHoursFraction(), 1);
  });
  it('H5 volume and IP savings', () => {
    expect(rec('vol-orphan').monthlySavingInr).toBe(500 * 8);
    expect(rec('ip-unused').monthlySavingInr).toBe(300);
  });
});

describe('Test 7 — accept / reject recalculates totals', () => {
  it('approving adds exactly that saving; rejecting removes it', () => {
    const r = rec('vm-dev-underutil');
    const before = aggregate(resources, analysis.recommendations, {});
    const a = approve({}, r, '2026-10-24T10:00:00Z');
    expect(a.ok).toBe(true);
    const after = aggregate(resources, analysis.recommendations, a.decisions);
    expect(after.approvedInr - before.approvedInr).toBeCloseTo(r.monthlySavingInr, 2);
    expect(before.projectedInr - after.projectedInr).toBeCloseTo(r.monthlySavingInr, 2);
    const back = reject(a.decisions, r, '2026-10-24T10:05:00Z');
    expect(aggregate(resources, analysis.recommendations, back.decisions).approvedInr).toBe(before.approvedInr);
  });
});

describe('Test 8 — no duplicate savings for conflicting actions', () => {
  it('resize + schedule counted once on the final state', () => {
    const r = rec('vm-stg-conflict');
    expect(r.action).toBe('resize+schedule');
    const cur = { vcpu: 8, ramGb: 32 };
    const prop = r.proposed.size!;
    const finalState = resizeScheduleSaving(cur, prop, 'mumbai');
    const naiveSum = resizeSaving(cur, prop, 'mumbai') + scheduleSaving(cur, 'mumbai');
    expect(r.monthlySavingInr).toBeCloseTo(finalState, 2);
    expect(r.monthlySavingInr).toBeLessThan(naiveSum);
    expect(analysis.recommendations.filter((x) => x.resourceId === 'vm-stg-conflict')).toHaveLength(1);
  });
});

describe('Test 9 — anomalous usage triggers an alert', () => {
  it('spike alert with an explanation', () => {
    const a = analysis.alerts.find((x) => x.type === 'usage-spike' && x.resourceId === 'vm-stg-anomaly');
    expect(a).toBeDefined();
    expect(a!.why).toMatch(/above the threshold/);
    expect(a!.firstSeen).toMatch(/^2026-09-29/); // day 22 after a Monday 7 Sep start
  });
  it('no spike alert on steady or regularly-peaking servers', () => {
    const spiky = analysis.alerts.filter((x) => x.type === 'usage-spike').map((x) => x.resourceId);
    expect(spiky).toEqual(['vm-stg-anomaly']);
  });
});

describe('Test 10 — changing the workload scenario changes the verdict', () => {
  it('same recommendation: PASS under normal, FAIL under +60%', () => {
    const r = rec('vm-dev-underutil');
    const normal = previewRecommendation(res('vm-dev-underutil'), series.get('vm-dev-underutil')!, r, 'normal');
    const heavy = previewRecommendation(res('vm-dev-underutil'), series.get('vm-dev-underutil')!, r, 'traffic60');
    expect(normal.verdict).toBe('PASS_UNDER_TESTED_CONDITIONS');
    expect(heavy.verdict).toBe('FAIL_SAFETY_CHECKS');
    expect(heavy.reasons.join(' ')).toMatch(/would be/);
  });
  it('missing-data scenario → INSUFFICIENT EVIDENCE', () => {
    const r = rec('vm-dev-underutil');
    const p = previewRecommendation(res('vm-dev-underutil'), series.get('vm-dev-underutil')!, r, 'missingData');
    expect(p.verdict).toBe('INSUFFICIENT_EVIDENCE');
  });
});

describe('Test 11 — invalid configurations are rejected', () => {
  const base = res('vm-dev-underutil');
  const s = series.get('vm-dev-underutil')!;
  const bad = (r: Partial<Resource>, ser: MetricSeries = s) => analyzeResource({ ...base, ...r }, ser);
  it('zero vCPU', () => expect(bad({ vcpu: 0 }).ok).toBe(false));
  it('non-catalog size', () => expect(bad({ vcpu: 3, ramGb: 7 }).ok).toBe(false));
  it('CPU above 100%', () => expect(bad({}, { ...s, cpuPct: [120, ...s.cpuPct.slice(1)] }).ok).toBe(false));
  it('NaN sample', () => expect(bad({}, { ...s, memPct: [NaN, ...s.memPct.slice(1)] }).ok).toBe(false));
  it('mismatched series length', () => expect(bad({}, { ...s, iops: s.iops.slice(1) }).ok).toBe(false));
  it('invalid input produces errors, not a recommendation', () => {
    const out = bad({ vcpu: -2 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors[0].field).toBe('vcpu');
  });
});

describe('Test 12 — incomplete history', () => {
  it('< 14 days of data → INSUFFICIENT EVIDENCE naming history', () => {
    const r = rec('vm-dev-newbie');
    expect(r.evidence.historyDays).toBeLessThan(14);
    expect(r.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(r.reasons.join(' ')).toMatch(/days of history/);
  });
});

describe('Reproducibility', () => {
  it('same seed → identical recommendations', () => {
    const again = buildFixtures();
    const second = analyzeAll(again.resources, again.series);
    expect(second.recommendations).toEqual(analysis.recommendations);
  });
});
