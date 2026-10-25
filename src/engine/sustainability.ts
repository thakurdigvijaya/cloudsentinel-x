// Bonus: estimated energy and carbon reduction from optimization (assumptions §T). ESTIMATES ONLY.
// Method follows the Cloud Carbon Footprint (CCF) compute model:
//   average watts per vCPU = minW + utilisation × (maxW − minW);  energy = watts × vCPU-hours (+ memory) × PUE
// Grid factor: India weighted average 0.727 tCO2/MWh (CEA CO2 Baseline Database, FY 2023-24).
// UTHO publishes no hardware or PUE data, so the coefficients are the CCF AWS averages (illustrative).
import { CONFIG } from './config';
import { round2 } from './pricing';
import type { Recommendation, Size } from './types';

export const ENERGY = {
  minWattsPerVcpu: 0.71, // CCF, AWS average (unknown micro-architecture)
  maxWattsPerVcpu: 3.46, // CCF, AWS average
  memoryWattsPerGb: 0.392, // CCF memory coefficient
  pue: 1.135, // CCF, AWS — Indian data centres are often higher, so this likely UNDERSTATES energy
  gridKgCo2PerKwh: 0.727, // CEA CO2 Baseline Database, India weighted average FY 2023-24
} as const;

/** Average electrical power of a VM (W, including PUE) at a given average CPU utilisation (% of that size). */
export function vmPowerWatts(size: Size, avgCpuPct: number): number {
  const u = Math.min(1, Math.max(0, avgCpuPct / 100));
  const cpuW = size.vcpu * (ENERGY.minWattsPerVcpu + u * (ENERGY.maxWattsPerVcpu - ENERGY.minWattsPerVcpu));
  const memW = size.ramGb * ENERGY.memoryWattsPerGb;
  return (cpuW + memW) * ENERGY.pue;
}

export interface EnergyEstimate {
  kwhBeforePerMonth: number;
  kwhAfterPerMonth: number;
  kwhSavedPerMonth: number;
  kgCo2SavedPerMonth: number;
}

/**
 * Energy before/after one recommendation, per month. Only VMs (volumes/IPs are excluded: storage and IP energy
 * are not modelled). A resize keeps the same work, so utilisation on the smaller size rises by current/target
 * and only the idle (min-watt) part and memory power go away — never "half the VM, half the energy".
 */
export function energyForRecommendation(rec: Recommendation, accepted: readonly ('remove' | 'resize' | 'schedule')[] = rec.steps.map((s) => s.action)): EnergyEstimate | null {
  if (rec.resourceType !== 'vm' || !rec.current.size) return null;
  const hours: number = CONFIG.time.hoursPerMonth;
  const util = rec.evidence.cpu?.mean ?? 0;
  const cur = rec.current.size;
  const before = (vmPowerWatts(cur, util) * hours) / 1000;

  let size = cur;
  let utilAfter = util;
  let hoursOn = hours;
  const set = new Set(accepted);
  for (const step of rec.steps) {
    if (!set.has(step.action)) continue;
    if (step.action === 'remove') hoursOn = 0;
    if (step.action === 'resize' && step.size) {
      utilAfter = (utilAfter * size.vcpu) / step.size.vcpu;
      size = step.size;
    }
    if (step.action === 'schedule') hoursOn = hoursOn * (1 - (step.offFraction ?? 0));
  }
  const after = (vmPowerWatts(size, utilAfter) * hoursOn) / 1000;
  const saved = Math.max(0, before - after);
  return {
    kwhBeforePerMonth: round2(before),
    kwhAfterPerMonth: round2(after),
    kwhSavedPerMonth: round2(saved),
    kgCo2SavedPerMonth: round2(saved * ENERGY.gridKgCo2PerKwh),
  };
}

export interface FleetEnergy {
  recommendations: number;
  kwhSavedPerMonth: number;
  kgCo2SavedPerMonth: number;
  tonnesCo2SavedPerYear: number;
  method: string;
}

/** Sum over a set of recommendations (e.g. all eligible ones, or the approved ones with their accepted steps). */
export function fleetEnergy(recs: readonly Recommendation[], acceptedOf: (r: Recommendation) => readonly ('remove' | 'resize' | 'schedule')[] = (r) => r.steps.map((s) => s.action)): FleetEnergy {
  let kwh = 0;
  let n = 0;
  for (const r of recs) {
    const e = energyForRecommendation(r, acceptedOf(r));
    if (!e || e.kwhSavedPerMonth === 0) continue;
    kwh += e.kwhSavedPerMonth;
    n++;
  }
  const kg = kwh * ENERGY.gridKgCo2PerKwh;
  return {
    recommendations: n,
    kwhSavedPerMonth: round2(kwh),
    kgCo2SavedPerMonth: round2(kg),
    tonnesCo2SavedPerYear: Math.round((kg * 12) / 10) / 100,
    method:
      `Estimate. Cloud Carbon Footprint compute model (${ENERGY.minWattsPerVcpu}–${ENERGY.maxWattsPerVcpu} W per vCPU by utilisation, ` +
      `${ENERGY.memoryWattsPerGb} W per GB RAM, PUE ${ENERGY.pue}) × India grid ${ENERGY.gridKgCo2PerKwh} kg CO₂/kWh (CEA, FY 2023-24). ` +
      'UTHO hardware and PUE are unknown; volumes and IPs are excluded.',
  };
}
