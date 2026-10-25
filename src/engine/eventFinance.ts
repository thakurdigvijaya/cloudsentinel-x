// Make the time dimension of Utsav-delayed savings explicit without altering
// baseline safety verdicts or the user's historical planning approvals.
import { approvedSaving, type Decisions } from './decisions';
import { eligibleSteps, savingFor } from './plan';
import { round2 } from './pricing';
import type { Recommendation, StepAction } from './types';

export interface EventTimingSummary {
  eligiblePlannedInr: number;
  eligibleNowInr: number;
  deferredEligibleInr: number;
  approvedPlannedInr: number;
  approvedNowInr: number;
  deferredApprovedInr: number;
}

/** An event hold blocks immediate execution of the resize, not a safe independent schedule step. */
export function executableStepsNow(rec: Recommendation, steps: readonly StepAction[]): StepAction[] {
  return steps.filter((step) => !(rec.holdUntil && step === 'resize'));
}

export function eventTimingSummary(recs: readonly Recommendation[], decisions: Decisions): EventTimingSummary {
  let eligiblePlannedInr = 0;
  let eligibleNowInr = 0;
  let approvedPlannedInr = 0;
  let approvedNowInr = 0;
  for (const rec of recs) {
    const eligible = eligibleSteps(rec);
    eligiblePlannedInr += savingFor(rec, eligible);
    eligibleNowInr += savingFor(rec, executableStepsNow(rec, eligible));
    const approved = approvedSaving(rec, decisions);
    approvedPlannedInr += approved;
    if (approved > 0) {
      const choice = decisions[rec.id]?.acceptedSteps ?? rec.steps.map((s) => s.action);
      approvedNowInr += savingFor(rec, executableStepsNow(rec, choice));
    }
  }
  return {
    eligiblePlannedInr: round2(eligiblePlannedInr), eligibleNowInr: round2(eligibleNowInr),
    deferredEligibleInr: round2(eligiblePlannedInr - eligibleNowInr),
    approvedPlannedInr: round2(approvedPlannedInr), approvedNowInr: round2(approvedNowInr),
    deferredApprovedInr: round2(approvedPlannedInr - approvedNowInr),
  };
}
