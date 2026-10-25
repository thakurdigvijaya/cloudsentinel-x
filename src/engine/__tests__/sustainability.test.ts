// Bonus: energy and carbon estimate (assumptions §T).
import { describe, expect, it } from 'vitest';
import { buildFixtures } from '../../data/fixtures';
import { analyzeAll } from '../index';
import { ENERGY, energyForRecommendation, fleetEnergy, vmPowerWatts } from '../sustainability';
import { offHoursFraction } from '../config';

const { resources, series } = buildFixtures();
const recs = analyzeAll(resources, series).recommendations;
const rec = (id: string) => recs.find((r) => r.resourceId === id)!;

describe('Power model (CCF)', () => {
  it('idle vs full load per vCPU, plus memory, times PUE', () => {
    expect(vmPowerWatts({ vcpu: 1, ramGb: 0 }, 0)).toBeCloseTo(ENERGY.minWattsPerVcpu * ENERGY.pue, 10);
    expect(vmPowerWatts({ vcpu: 1, ramGb: 0 }, 100)).toBeCloseTo(ENERGY.maxWattsPerVcpu * ENERGY.pue, 10);
    expect(vmPowerWatts({ vcpu: 0, ramGb: 10 }, 50)).toBeCloseTo(10 * ENERGY.memoryWattsPerGb * ENERGY.pue, 10);
  });
  it('documented coefficients (sources in assumptions §T)', () => {
    expect(ENERGY.gridKgCo2PerKwh).toBe(0.727);
    expect(ENERGY.pue).toBe(1.135);
  });
});

describe('Per recommendation', () => {
  it('stop saves all of the VM energy', () => {
    const e = energyForRecommendation(rec('vm-dev-idle'))!;
    expect(e.kwhAfterPerMonth).toBe(0);
    expect(e.kwhSavedPerMonth).toBeCloseTo(e.kwhBeforePerMonth, 2);
    expect(e.kgCo2SavedPerMonth).toBeCloseTo(e.kwhSavedPerMonth * 0.727, 1);
  });
  it('schedule saves the off-hours share of the energy', () => {
    const e = energyForRecommendation(rec('vm-dev-officehours'))!;
    expect(e.kwhSavedPerMonth / e.kwhBeforePerMonth).toBeCloseTo(offHoursFraction(), 2);
  });
  it('resize keeps the same work: saving < proportional to the size cut (only idle + memory power goes)', () => {
    const r = rec('vm-dev-underutil');
    const e = energyForRecommendation(r)!;
    const cut = 1 - r.proposed.size!.vcpu / r.current.size!.vcpu;
    expect(e.kwhSavedPerMonth).toBeGreaterThan(0);
    expect(e.kwhSavedPerMonth / e.kwhBeforePerMonth).toBeLessThan(cut);
  });
  it('partial: schedule-only of a resize+schedule saves less than both steps', () => {
    const r = rec('vm-stg-conflict');
    expect(energyForRecommendation(r, ['schedule'])!.kwhSavedPerMonth).toBeLessThan(energyForRecommendation(r)!.kwhSavedPerMonth);
  });
  it('volumes and IPs are excluded (null), none/no-action saves 0', () => {
    expect(energyForRecommendation(rec('vol-orphan'))).toBeNull();
    expect(energyForRecommendation(rec('ip-unused'))).toBeNull();
    const none = recs.find((r) => r.resourceType === 'vm' && r.action === 'none')!;
    expect(energyForRecommendation(none)!.kwhSavedPerMonth).toBe(0);
  });
});

describe('Fleet total', () => {
  it('sums only recommendations that save energy and states its method', () => {
    const f = fleetEnergy(recs.filter((r) => r.eligible));
    expect(f.kwhSavedPerMonth).toBeGreaterThan(0);
    expect(f.kgCo2SavedPerMonth).toBeCloseTo(f.kwhSavedPerMonth * 0.727, 1);
    expect(f.tonnesCo2SavedPerYear).toBeCloseTo((f.kgCo2SavedPerMonth * 12) / 1000, 1);
    expect(f.method).toMatch(/Estimate.*CEA/);
    expect(fleetEnergy([]).kwhSavedPerMonth).toBe(0);
  });
});
