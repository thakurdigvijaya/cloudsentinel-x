// Section H6 — conflict-free costing when a resource has more than one possible change.
// Fixed order of operations: 1) remove (stop / delete / release) → cost 0, nothing else applies
//                            2) resize → cost = new plan price
//                            3) schedule → cost = cost so far × on-hours fraction
// A partial acceptance is always recomputed from scratch from the accepted set (no running totals).
import { offHoursFraction, scheduleOffFraction } from './config';
import { round2, vmMonthlyCost } from './pricing';
import type { PlanStep, Recommendation, StepAction } from './types';

const ORDER: StepAction[] = ['remove', 'resize', 'schedule'];

/** Builds the ordered step breakdown for a recommendation. */
export function buildSteps(rec: Pick<Recommendation, 'action' | 'current' | 'proposed' | 'region' | 'scheduleWindow'>): PlanStep[] {
  const current = rec.current.monthlyCostInr;
  const offFrac = scheduleOffFraction(rec.scheduleWindow);
  const onFrac = 1 - offFrac;
  const label = rec.scheduleWindow === 'weekends' ? 'weekends' : 'off-hours';
  switch (rec.action) {
    case 'stop':
      return [{ action: 'remove', label: 'Stop VM', costAfterInr: 0, marginalSavingInr: current }];
    case 'delete-volume':
      return [{ action: 'remove', label: 'Delete volume (after snapshot)', costAfterInr: 0, marginalSavingInr: current }];
    case 'release-ip':
      return [{ action: 'remove', label: 'Release public IP', costAfterInr: 0, marginalSavingInr: current }];
    case 'resize': {
      const after = vmMonthlyCost(rec.proposed.size!, rec.region);
      return [{ action: 'resize', label: 'Resize', costAfterInr: after, marginalSavingInr: round2(current - after), size: rec.proposed.size }];
    }
    case 'schedule': {
      const after = round2(current * onFrac);
      return [{ action: 'schedule', label: `Schedule ${label}`, costAfterInr: after, marginalSavingInr: round2(current - after), offFraction: offFrac }];
    }
    case 'resize+schedule': {
      const afterResize = vmMonthlyCost(rec.proposed.size!, rec.region);
      const afterSchedule = round2(afterResize * onFrac);
      return [
        { action: 'resize', label: 'Resize', costAfterInr: afterResize, marginalSavingInr: round2(current - afterResize), size: rec.proposed.size },
        { action: 'schedule', label: `Then schedule ${label}`, costAfterInr: afterSchedule, marginalSavingInr: round2(afterResize - afterSchedule), offFraction: offFrac },
      ];
    }
    case 'none':
      return [];
  }
}

/**
 * Projected monthly cost when only `accepted` steps are applied, in the fixed order.
 * Example (8/32 → 4/16 + schedule): only resize → new plan price; only schedule → original × on-hours;
 * both → new plan price × on-hours. Never below 0, never a saving larger than the bill.
 */
export function projectedCost(rec: Pick<Recommendation, 'current' | 'steps' | 'region'>, accepted: readonly StepAction[]): number {
  const set = new Set(accepted);
  let cost = rec.current.monthlyCostInr;
  for (const action of ORDER) {
    if (!set.has(action)) continue;
    const step = rec.steps.find((s) => s.action === action);
    if (!step) continue;
    if (action === 'remove') return 0;
    if (action === 'resize') cost = vmMonthlyCost(step.size!, rec.region);
    if (action === 'schedule') cost = cost * (1 - (step.offFraction ?? offHoursFraction()));
  }
  return round2(Math.max(0, cost));
}

export function savingFor(rec: Pick<Recommendation, 'current' | 'steps' | 'region'>, accepted: readonly StepAction[]): number {
  return round2(rec.current.monthlyCostInr - projectedCost(rec, accepted));
}

export const allSteps = (rec: Pick<Recommendation, 'steps'>): StepAction[] => rec.steps.map((s) => s.action);

/** Steps that may be approved / counted: all when eligible; after revalidation, only those that still pass. */
export function eligibleSteps(rec: Pick<Recommendation, 'steps' | 'eligible' | 'validSteps'>): StepAction[] {
  if (rec.eligible) return allSteps(rec);
  return (rec.validSteps ?? []).filter((s) => rec.steps.some((p) => p.action === s));
}
