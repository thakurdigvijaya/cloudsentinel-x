// Fleet what-if (UTHO bonus: "what if we shut down all dev VMs from 8 PM to 8 AM?") — preview only.
import { describe, expect, it } from 'vitest';
import { generateDataset } from '../../data/generator';
import { makeSeries } from '../../data/fixtures';
import { aggregate, analyzeAll } from '../index';
import { offHoursFraction, weekendFraction } from '../config';
import { fleetWhatIf } from '../whatif';
import { vmMonthlyCost } from '../pricing';
import { isBusinessSample } from '../time';
import type { Resource } from '../types';

const d = generateDataset();
const pattern = (id: string) => d.patternOf.get(id)!;
const devNights = fleetWhatIf(d.resources, d.series, 'nights', { env: ['dev'] });

describe("The brief's example: all dev VMs off 20:00–08:00", () => {
  it('covers exactly the dev VMs, nothing else', () => {
    const devVms = d.resources.filter((r) => r.type === 'vm' && r.env === 'dev');
    expect(devNights.counts.total).toBe(devVms.length);
    expect(devNights.vms.every((v) => v.env === 'dev')).toBe(true);
  });

  it('off fraction = 12 h of 24, and each saving = VM cost × 0.5', () => {
    expect(devNights.offFraction).toBe(0.5);
    for (const v of devNights.vms) expect(v.savingInr).toBeCloseTo(v.monthlyCostInr * 0.5, 2);
    expect(devNights.savingAllInr).toBeCloseTo(devNights.vms.reduce((a, v) => a + v.savingInr, 0), 2);
  });

  it('separates quiet, busy and unknown VMs by the documented patterns', () => {
    const of = (s: string) => new Set(devNights.vms.filter((v) => v.status === s).map((v) => pattern(v.resourceId)));
    expect(of('quiet')).toEqual(new Set(['office-hours', 'idle', 'oversized-office-hours']));
    expect(of('active')).toEqual(new Set(['steady-low', 'weekend-idle', 'night-traffic'])); // busy at night (CPU or network)
    expect(of('insufficient')).toEqual(new Set(['short-history', 'new-this-week']));
  });

  it('a night-traffic VM is "active" because of its network, with the number in the reason', () => {
    const v = devNights.vms.find((x) => pattern(x.resourceId) === 'night-traffic')!;
    expect(v.status).toBe('active');
    expect(v.reason).toMatch(/network p95 \d+\.\d Mbps/);
  });

  it('defensible saving (quiet only) is smaller than the naive saving, and the summary says both', () => {
    expect(devNights.savingQuietInr).toBeLessThan(devNights.savingAllInr);
    expect(devNights.counts.quiet + devNights.counts.active + devNights.counts.insufficient).toBe(devNights.counts.total);
    expect(devNights.summary).toMatch(/would save about ₹[\d,]+\/month/);
    expect(devNights.summary).toMatch(/Preview only/);
  });
});

describe('Windows and filters', () => {
  it('window fractions match A3 / A3b', () => {
    expect(fleetWhatIf(d.resources, d.series, 'nights-and-weekends', { env: ['dev'] }).offFraction).toBeCloseTo(offHoursFraction(), 10);
    expect(fleetWhatIf(d.resources, d.series, 'weekends', { env: ['dev'] }).offFraction).toBeCloseTo(weekendFraction(), 10);
  });

  it('weekend-idle VMs are busy at night but quiet on weekends', () => {
    const wk = fleetWhatIf(d.resources, d.series, 'weekends', { env: ['dev'] });
    for (const v of wk.vms.filter((x) => pattern(x.resourceId) === 'weekend-idle')) expect(v.status).toBe('quiet');
  });

  it('filters by region and team; an empty match says so', () => {
    const r = fleetWhatIf(d.resources, d.series, 'nights', { env: ['dev'], region: ['noida'] });
    expect(r.vms.every((v) => d.resources.find((x) => x.id === v.resourceId)!.region === 'noida')).toBe(true);
    const none = fleetWhatIf(d.resources, d.series, 'nights', { team: ['no-such-team'] });
    expect(none.counts.total).toBe(0);
    expect(none.savingAllInr).toBe(0);
    expect(none.summary).toBe('No VMs match this filter.');
  });

  it('production VMs are counted and their reason demands a manual review', () => {
    const p = fleetWhatIf(d.resources, d.series, 'nights', { env: ['prod'] });
    expect(p.counts.production).toBe(p.counts.total);
    for (const v of p.vms) expect(v.reason).toMatch(/Production VM: never shut down without a manual review/);
  });

  it('only VMs are included (volumes and IPs are ignored)', () => {
    const all = fleetWhatIf(d.resources, d.series, 'nights');
    expect(all.counts.total).toBe(d.resources.filter((r) => r.type === 'vm').length);
  });
});

describe('Preview Mode: the simulator never changes recommendations or totals', () => {
  it('totals before and after a what-if are identical', () => {
    const a = analyzeAll(d.resources, d.series);
    const before = aggregate(d.resources, a.recommendations, {});
    fleetWhatIf(d.resources, d.series, 'nights', { env: ['dev', 'staging'] });
    expect(aggregate(d.resources, a.recommendations, {})).toEqual(before);
    expect(devNights.preview).toBe(true);
  });

  it('a hand-made VM: quiet at night → quiet; saving = cost × 0.5', () => {
    const res: Resource = { id: 'q', name: 'q', type: 'vm', region: 'mumbai', env: 'dev', team: 't', createdAt: '2025-11-01', pattern: 'test', vcpu: 4, ramGb: 16 };
    const s = makeSeries('q', 3, { cpu: (i) => (isBusinessSample(i) ? 50 : 2), mem: () => 40, net: (i) => (isBusinessSample(i) ? 10 : 0.3) });
    // weekend daytime is outside "business" but inside neither night window: still quiet (CPU 2%)
    const r = fleetWhatIf([res], new Map([['q', s]]), 'nights');
    expect(r.vms[0].status).toBe('quiet');
    expect(r.savingAllInr).toBeCloseTo(vmMonthlyCost({ vcpu: 4, ramGb: 16 }, 'mumbai') * 0.5, 2);
  });
});
