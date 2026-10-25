// Phase 2a: the full synthetic dataset and spend alerts (I2, I4).
import { describe, expect, it } from 'vitest';
import { DATASET_SEED, MIX, generateDataset } from '../../data/generator';
import { buildFixtures } from '../../data/fixtures';
import { aggregate, analyzeAll } from '../index';
import { dailySpend, detectBudgetOverrun, detectSpendIncrease, dayIndex } from '../spend';
import { resourceMonthlyCost } from '../pricing';

const d = generateDataset();
const a = analyzeAll(d.resources, d.series);
const vms = d.resources.filter((r) => r.type === 'vm');
const byPattern = (p: string) => a.recommendations.filter((r) => d.patternOf.get(r.resourceId) === p);

describe('Dataset shape (assumptions.md §K)', () => {
  it('~90 VMs, 20 volumes, 12 IPs; all 3 regions and environments', () => {
    expect(vms).toHaveLength(90);
    expect(d.resources.filter((r) => r.type === 'volume')).toHaveLength(20);
    expect(d.resources.filter((r) => r.type === 'ip')).toHaveLength(12);
    expect(new Set(vms.map((r) => r.region))).toEqual(new Set(['noida', 'bengaluru', 'mumbai']));
    expect(new Set(vms.map((r) => r.env))).toEqual(new Set(['prod', 'staging', 'dev']));
  });
  it('every VM lists a disk size (brief inventory), and it does not change the VM price (B7: compute only)', () => {
    for (const v of vms) {
      expect(v.diskGb).toBeGreaterThan(0);
      expect(resourceMonthlyCost(v)).toBe(resourceMonthlyCost({ ...v, diskGb: undefined }));
    }
    for (const r of buildFixtures().resources.filter((x) => x.type === 'vm')) expect(r.diskGb).toBeGreaterThan(0);
  });
  it('30 days × 15-min samples for every VM, and every input is valid', () => {
    for (const v of vms) expect(d.series.get(v.id)!.cpuPct).toHaveLength(2880);
    expect(a.invalid).toHaveLength(0);
  });
  it('every documented pattern is present in the stated amounts', () => {
    for (const env of Object.keys(MIX) as (keyof typeof MIX)[]) {
      for (const [p, n] of Object.entries(MIX[env])) {
        expect(vms.filter((v) => v.env === env && v.pattern === p)).toHaveLength(n!);
      }
    }
  });
  it('is reproducible: same seed → identical data; different seed → different data', () => {
    const again = generateDataset(DATASET_SEED);
    expect(again.resources).toEqual(d.resources);
    expect(again.series.get('vm-001')).toEqual(d.series.get('vm-001'));
    expect(generateDataset(7).series.get('vm-001')).not.toEqual(d.series.get('vm-001'));
  });
});

describe('Engine behaviour on the full dataset matches the intended patterns', () => {
  it('bursty and memory-heavy prod VMs are never approved for downsizing', () => {
    for (const r of [...byPattern('bursty-prod'), ...byPattern('memory-heavy')]) expect(r.eligible).toBe(false);
  });
  it('idle → stop, office-hours → schedule, orphans → removed, all PASS', () => {
    // every idle VM is proposed to stop; the one a prod API depends on is blocked by the Dependency Shield (§X)
    for (const r of byPattern('idle')) {
      expect(r.action).toBe('stop');
      const g1 = r.checks.find((c) => c.id === 'G1');
      expect(r.verdict).toBe(g1 ? 'FAIL_SAFETY_CHECKS' : 'PASS_UNDER_TESTED_CONDITIONS');
    }
    expect(byPattern('idle').filter((r) => r.checks.some((c) => c.id === 'G1'))).toHaveLength(1);
    for (const r of byPattern('office-hours')) expect(r.action).toBe('schedule');
    for (const r of byPattern('orphaned-volume')) expect(r.action).toBe('delete-volume');
    for (const r of byPattern('unused-ip')) expect(r.action).toBe('release-ip');
  });
  it('new, short-history and data-gap VMs are never eligible', () => {
    for (const p of ['new-this-week', 'short-history', 'data-gap']) {
      for (const r of byPattern(p)) {
        expect(r.eligible).toBe(false);
        expect(r.verdict).not.toBe('PASS_UNDER_TESTED_CONDITIONS');
      }
    }
  });
  it('oversized office-hours VMs get ONE multi-step plan (resize + schedule) so partial approval can be demoed', () => {
    const recs = byPattern('oversized-office-hours');
    expect(recs.length).toBe(4);
    for (const r of recs) {
      expect(r.action).toBe('resize+schedule');
      expect(r.steps.map((s) => s.action)).toEqual(['resize', 'schedule']);
      expect(r.requiresHumanReview).toBe(true);
    }
  });
  it('night-traffic VMs (CPU idle at night, network busy) are NOT scheduled, and say why (D3)', () => {
    const recs = byPattern('night-traffic');
    expect(recs.length).toBe(2);
    for (const r of recs) {
      expect(r.action).toBe('none');
      expect(r.monthlySavingInr).toBe(0);
      expect(r.evidence.offHoursNetP95Mbps!).toBeGreaterThanOrEqual(1);
      expect(r.reasons.join(' ')).toMatch(/Not scheduled: CPU is idle off-hours but network traffic continues/);
    }
  });
  it('healthy busy prod VMs are left alone', () => {
    for (const r of byPattern('healthy-busy')) expect(r.action).toBe('none');
  });
  it('totals reconcile and eligible savings are a fraction of the bill', () => {
    const t = aggregate(d.resources, a.recommendations, {});
    expect(t.originalInr).toBeCloseTo(d.resources.reduce((s, r) => s + resourceMonthlyCost(r), 0), 1);
    expect(t.eligibleInr).toBeGreaterThan(0);
    expect(t.eligibleInr).toBeLessThan(t.candidateInr);
    expect(t.candidateInr).toBeLessThan(t.originalInr);
  });
});

describe('Spend alerts I2 and I4', () => {
  const daily = dailySpend(d.resources, d.start, 30);

  it('new VMs only cost money from their creation day', () => {
    const newVm = vms.find((v) => v.pattern === 'new-this-week')!;
    const created = dayIndex(newVm.createdAt, d.start);
    expect(created).toBeGreaterThanOrEqual(23);
    const without = dailySpend(d.resources.filter((r) => r.id !== newVm.id), d.start, 30);
    expect(daily[created - 1]).toBeCloseTo(without[created - 1], 1);
    expect(daily[created]).toBeGreaterThan(without[created]);
  });

  it('I2 fires with a reason naming the new resources', () => {
    const alert = detectSpendIncrease(daily, d.resources, d.start);
    expect(alert).not.toBeNull();
    expect(alert!.why).toMatch(/created in the last 14 days/);
    expect(a.alerts.some((x) => x.type === 'spend-increase')).toBe(true);
  });

  it('I4 fires only when the projected month exceeds the budget', () => {
    expect(detectBudgetOverrun(daily, 600000)).not.toBeNull();
    expect(detectBudgetOverrun(daily, 10_000_000)).toBeNull();
  });

  it('no spend alerts on the flat fixture inventory (no false alarms)', () => {
    const f = buildFixtures();
    const fa = analyzeAll(f.resources, f.series);
    expect(fa.alerts.filter((x) => x.type === 'spend-increase')).toHaveLength(0);
  });
});
