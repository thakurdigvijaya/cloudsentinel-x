/** Fleet-wide what-if challenge. Reuses the same ForeSight evaluation, accounting and event rules as the workspace.
 * Pure, deterministic preview: never writes data, approvals or planning assumptions.
 * Only resize capacity is revalidated under this CPU/RAM stress model. Scheduling, dependency
 * and orphan-resource conclusions remain at their existing verdicts; the UI labels that scope.
 */
import { withExtraWorkload } from './challenge';
import { aggregate } from './decisions';
import { dataChecks, evaluateSize } from './foresight';
import { executableStepsNow } from './eventFinance';
import { eligibleSteps, savingFor } from './plan';
import { round2 } from './pricing';
import type { MetricSeries, Recommendation, Resource, Size, StepAction } from './types';

export interface FleetChallengeInput {
  resources: readonly Resource[];
  series: ReadonlyMap<string, MetricSeries>;
  recommendations: readonly Recommendation[];
}
export interface ChallengedResource {
  id: string;
  name: string;
  recommendationId: string;
  originalSavingInr: number;
  nowSavingInr: number;
  deltaInr: number;
  verdict: Recommendation['verdict'];
  reason: string;
}
export interface FleetChallengeResult {
  percent: number;
  baselineEligibleInr: number;
  stressedEligibleInr: number;
  baselineActionableInr: number;
  stressedActionableInr: number;
  lostSavingInr: number;
  lostActionableInr: number;
  baselineEligibleCount: number;
  remainingEligibleCount: number;
  lostEligibility: ChallengedResource[];
  reducedSaving: ChallengedResource[];
  eligibleIds: Set<string>;
}

const amountNow = (r: Recommendation) => savingFor(r, executableStepsNow(r, eligibleSteps(r)));

export function challengeFleet(input: FleetChallengeInput, percent: number): FleetChallengeResult {
  if (!Number.isInteger(percent) || percent < 0 || percent > 200) throw new Error('Workload stress must be an integer from 0 to 200%.');
  const before = input.recommendations;
  const resourceById = new Map(input.resources.map((r) => [r.id, r]));
  const stressed = percent === 0 ? before : before.map((rec): Recommendation => {
    if (!rec.eligible || !rec.proposed.size || (rec.action !== 'resize' && rec.action !== 'resize+schedule')) return rec;
    const resource = resourceById.get(rec.resourceId);
    const s = input.series.get(rec.resourceId);
    if (!resource || !s || !resource.vcpu || !resource.ramGb) return {
      ...rec, eligible: false, validSteps: [], verdict: 'INSUFFICIENT_EVIDENCE', risk: 'high',
      reasons: ['Stress preview blocked: current resource sizing or telemetry is missing.'],
    };
    const workload = withExtraWorkload(s, percent);
    const current: Size = { vcpu: resource.vcpu, ramGb: resource.ramGb };
    const e = evaluateSize(workload, current, rec.proposed.size, resource.env);
    const pass = e.verdict === 'PASS_UNDER_TESTED_CONDITIONS';
    // Scheduling remains a *separate, previously validated action* when resizing fails.
    const dataOk = dataChecks(workload, resource.env).ok;
    const validSteps: StepAction[] = pass ? rec.steps.map((step) => step.action)
      : rec.steps.filter((step) => step.action === 'schedule' && dataOk && !(rec.blockedSteps ?? []).includes('schedule')).map((step) => step.action);
    return {
      ...rec, eligible: pass && rec.eligible,
      validSteps: pass ? rec.validSteps : validSteps,
      verdict: e.verdict, risk: e.risk,
      checks: [...e.checks, ...rec.checks.filter((c) => c.id === 'G1')],
      evidence: { ...rec.evidence, projected: e.projected ?? undefined },
      reasons: [`Preview: +${percent}% CPU demand and +${Math.round(percent * 0.4)}% memory demand.`, ...e.reasons],
    };
  });
  const baseTotal = aggregate(input.resources, before, {});
  const stressedTotal = aggregate(input.resources, stressed, {});
  const baselineActionableInr = round2(before.reduce((n, rec) => n + amountNow(rec), 0));
  const stressedActionableInr = round2(stressed.reduce((n, rec) => n + amountNow(rec), 0));
  const lostEligibility: ChallengedResource[] = [];
  const reducedSaving: ChallengedResource[] = [];
  const eligibleIds = new Set<string>();
  stressed.forEach((rec, i) => {
    if (rec.eligible) eligibleIds.add(rec.resourceId);
    const old = before[i];
    const originalSavingInr = amountNow(old);
    const nowSavingInr = amountNow(rec);
    const deltaInr = round2(originalSavingInr - nowSavingInr);
    if (deltaInr <= 0) return;
    const change: ChallengedResource = {
      id: rec.resourceId, name: rec.resourceName, recommendationId: rec.id,
      originalSavingInr, nowSavingInr, deltaInr, verdict: rec.verdict,
      reason: rec.reasons.find((r) => /exceed|limit|fail|insufficient|peak|p99|p95|memory|cpu|capacity/i.test(r)) ?? rec.reasons.join(' '),
    };
    reducedSaving.push(change);
    if (old.eligible && !rec.eligible) lostEligibility.push(change);
  });
  const biggestFirst = (a: ChallengedResource, b: ChallengedResource) => b.deltaInr - a.deltaInr;
  lostEligibility.sort(biggestFirst);
  reducedSaving.sort(biggestFirst);
  return {
    percent,
    baselineEligibleInr: baseTotal.eligibleInr,
    stressedEligibleInr: stressedTotal.eligibleInr,
    baselineActionableInr,
    stressedActionableInr,
    lostSavingInr: round2(Math.max(0, baseTotal.eligibleInr - stressedTotal.eligibleInr)),
    lostActionableInr: round2(Math.max(0, baselineActionableInr - stressedActionableInr)),
    baselineEligibleCount: before.filter((rec) => rec.eligible).length,
    remainingEligibleCount: stressed.filter((rec) => rec.eligible).length,
    lostEligibility,
    reducedSaving,
    eligibleIds,
  };
}
