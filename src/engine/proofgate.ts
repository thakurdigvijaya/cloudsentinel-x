// ProofGate: human-readable evidence summary, not a replacement for ForeSight or approval validation.
// Uses recorded checks and the same financial formula as the rest of the engine.
import { approvalDependencyConflicts, directDependents, transitiveDependents } from './dependencies';
import { savingFor, allSteps } from './plan';
import type { Decisions } from './decisions';
import type { Recommendation, Resource } from './types';

export type GateState = 'pass' | 'blocked' | 'insufficient' | 'review' | 'not-applicable';
export interface ProofGateCheck { name: string; state: GateState; explanation: string }
export interface ProofGateSummary {
  gates: ProofGateCheck[];
  verdict: 'blocked' | 'insufficient' | 'requires-review' | 'checks-passed';
  caveat: string;
}

export function evaluateProofGate(
  rec: Recommendation, resources: readonly Resource[], recs: readonly Recommendation[], decisions: Decisions = {},
): ProofGateSummary {
  const vm = rec.resourceType === 'vm';
  const data = rec.checks.filter(c => ['E5', 'E6', 'E7', 'E9'].includes(c.id));
  const dataFailed = data.some(c => c.passed === false);
  const cap = rec.checks.filter(c => ['E1', 'E2', 'E3', 'E4', 'E8'].includes(c.id));
  const capFailed = cap.some(c => c.passed === false);
  const transientOvercapacity = cap.some(c => c.id === 'E3' && c.actual !== null && c.actual > 100 && c.passed === true);
  const known = new Set(resources.map(r => r.id));
  const dependencyIds = resources.find(r => r.id === rec.resourceId)?.dependsOn ?? [];
  const missingRefs = dependencyIds.filter(id => !known.has(id));
  const dependents = transitiveDependents(rec.resourceId, directDependents(resources));
  const shutdown = rec.steps.some(s => s.action === 'remove' || s.action === 'schedule') && vm;
  const g1Failed = rec.checks.some(c => c.id === 'G1' && c.passed === false);
  const activeConflict = approvalDependencyConflicts(resources, recs, decisions)
    .find(c => c.providerId === rec.resourceId);
  const financialActual = savingFor(rec, allSteps(rec));
  const moneyOk = Number.isFinite(financialActual) && Math.abs(financialActual - rec.monthlySavingInr) <= 0.02 &&
    rec.monthlySavingInr >= -0.001 && rec.monthlySavingInr <= rec.current.monthlyCostInr + 0.02;
  const gates: ProofGateCheck[] = [
    {
      name: 'Data integrity', state: !vm ? 'not-applicable' : !data.length || dataFailed ? 'insufficient' : 'pass',
      explanation: !vm ? 'Inventory evidence applies; CPU and RAM history not relevant to this resource type.'
        : dataFailed ? 'Monitoring coverage, duration, plausibility or freshness is insufficient.'
          : data.length ? 'Recorded monitoring checks pass in this dataset; validate imported telemetry dates.' : 'No monitoring checks available.',
    },
    {
      name: 'Capacity safety', state: !vm || !rec.steps.some(s => s.action === 'resize') ? 'not-applicable' :
        capFailed ? 'blocked' : dataFailed || !cap.length ? 'insufficient' : transientOvercapacity ? 'review' : 'pass',
      explanation: !vm || !rec.steps.some(s => s.action === 'resize') ? 'This action does not change VM capacity.'
        : capFailed ? 'One or more observed CPU/RAM thresholds are exceeded.'
          : transientOvercapacity ? 'Transient CPU demand exceeds 100% of proposed capacity; non-production policy tolerates throttling. Human performance review required.'
          : 'CPU/RAM checks passed under the recorded scenarios; I/O performance and future growth are not guaranteed.',
    },
    {
      name: 'Dependency safety',
      state: missingRefs.length || g1Failed || activeConflict ? 'blocked' : shutdown ? 'review' : 'not-applicable',
      explanation: missingRefs.length ? `Unknown referenced resource(s): ${missingRefs.join(', ')}.`
        : g1Failed ? 'Recorded dependents require this resource to keep running.'
          : activeConflict ? `Approved plan conflicts with ${activeConflict.dependentIds.join(', ')}.`
            : shutdown ? `Recorded dependents: ${dependents.length}; coordinated approval and owner confirmation required before execution.`
              : 'No resource shutdown is requested.',
    },
    {
      name: 'Financial verification', state: moneyOk ? 'pass' : 'blocked',
      explanation: moneyOk ? 'Proposed saving reconciles with the engine cost formula; boot disk and unmodeled charges remain excluded.'
        : 'Proposed savings do not reconcile with the engine pricing formula.',
    },
  ];
  const verdict = gates.some(g => g.state === 'blocked') ? 'blocked'
    : gates.some(g => g.state === 'insufficient') ? 'insufficient'
      : gates.some(g => g.state === 'review') || rec.requiresHumanReview ? 'requires-review' : 'checks-passed';
  return {
    gates, verdict,
    caveat: 'Synthetic/historical decision-support checks only. No production safety guarantee or live infrastructure change.',
  };
}
