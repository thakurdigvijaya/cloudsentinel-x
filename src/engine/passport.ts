// Evidence Passport (P1, basic): the decision record for one recommendation.
// Built ONLY from real engine outputs — never fabricated scores, certificates or results.
import { breakPoint, closestCall, safeAlternative, type BreakPointResult, type ClosestCallResult, type SafeAlternativeResult } from './challenge';
import type { Decision } from './decisions';
import { allSteps, savingFor } from './plan';
import { sizeLabel } from './pricing';
import { previewRecommendation, SCENARIOS, type PreviewResult } from './scenarios';
import type { MetricSeries, Recommendation, Resource, ScenarioId, Size } from './types';

export const PASSPORT_DISCLAIMER =
  'Synthetic data and illustrative pricing. Verdicts are evidence under the tested conditions listed here, not a guarantee of production safety.';

export interface EvidencePassport {
  resource: { id: string; name: string; type: Resource['type']; region: string; env: string; team: string; size?: Size; pattern: string };
  recommendation: Pick<Recommendation, 'id' | 'action' | 'verdict' | 'risk' | 'dataAdequacyScore' | 'reasons' | 'monthlySavingInr' | 'savingFormula' | 'steps' | 'checks' | 'assumptionIds' | 'requiresHumanReview' | 'eligible'>;
  costs: { currentInr: number; proposedInr: number };
  evidence: Recommendation['evidence'];
  scenarioRuns: Pick<PreviewResult, 'scenario' | 'model' | 'verdict' | 'reasons' | 'projected'>[];
  closestCall: ClosestCallResult | null;
  breakPoint: BreakPointResult | null;
  safeAlternative: SafeAlternativeResult | null;
  approval: { status: Decision['status'] | 'pending'; at?: string; acceptedSteps?: string[]; approvedSavingInr: number };
  disclaimer: string;
}

const RESIZE_ACTIONS = new Set(['resize', 'resize+schedule']);

export function buildPassport(
  resource: Resource,
  series: MetricSeries | undefined,
  rec: Recommendation,
  decision?: Decision,
  scenarios: ScenarioId[] = Object.keys(SCENARIOS) as ScenarioId[],
): EvidencePassport {
  const isVm = resource.type === 'vm' && series !== undefined;
  const current: Size | undefined = isVm ? { vcpu: resource.vcpu!, ramGb: resource.ramGb! } : undefined;
  const target = rec.proposed.size;
  const resizes = isVm && RESIZE_ACTIONS.has(rec.action) && target !== undefined;

  const scenarioRuns = isVm
    ? scenarios.map((s) => {
        const p = previewRecommendation(resource, series!, rec, s);
        return { scenario: p.scenario, model: p.model, verdict: p.verdict, reasons: p.reasons, projected: p.projected };
      })
    : [];

  const approvedSavingInr =
    decision?.status === 'approved' && rec.eligible ? savingFor(rec, decision.acceptedSteps ?? allSteps(rec)) : 0;

  return {
    resource: {
      id: resource.id, name: resource.name, type: resource.type, region: resource.region, env: resource.env,
      team: resource.team, size: current, pattern: resource.pattern,
    },
    recommendation: {
      id: rec.id, action: rec.action, verdict: rec.verdict, risk: rec.risk, dataAdequacyScore: rec.dataAdequacyScore, reasons: rec.reasons,
      monthlySavingInr: rec.monthlySavingInr, savingFormula: rec.savingFormula, steps: rec.steps, checks: rec.checks,
      assumptionIds: rec.assumptionIds, requiresHumanReview: rec.requiresHumanReview, eligible: rec.eligible,
    },
    costs: { currentInr: rec.current.monthlyCostInr, proposedInr: rec.proposed.monthlyCostInr },
    evidence: rec.evidence,
    scenarioRuns,
    closestCall: resizes ? closestCall(series!, series!.start, current!, target!, resource.env) : null,
    breakPoint: resizes ? breakPoint(series!, current!, target!, resource.env) : null,
    safeAlternative:
      resizes && rec.verdict === 'FAIL_SAFETY_CHECKS' ? safeAlternative(series!, current!, target!, resource.env, resource.region) : null,
    approval: {
      status: decision?.status ?? 'pending',
      at: decision?.at,
      acceptedSteps: decision?.acceptedSteps,
      approvedSavingInr,
    },
    disclaimer: PASSPORT_DISCLAIMER,
  };
}

const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n.toFixed(1)}%`);
const verdictText: Record<string, string> = {
  PASS_UNDER_TESTED_CONDITIONS: 'PASS UNDER TESTED CONDITIONS',
  FAIL_SAFETY_CHECKS: 'FAIL SAFETY CHECKS',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT EVIDENCE',
  NO_ACTION: 'NO ACTION',
};

/** Readable, printable report (Markdown). Every value comes from the passport object. */
export function passportToMarkdown(p: EvidencePassport): string {
  const r = p.recommendation;
  const lines: string[] = [];
  lines.push(`# Evidence Passport — ${p.resource.name} (${p.resource.id})`, '');
  lines.push(`**Verdict:** ${verdictText[r.verdict]} · **Risk:** ${r.risk} · **Data adequacy score:** ${(r.dataAdequacyScore * 100).toFixed(0)}% (how complete the data is — not a probability of safety) · **Approval:** ${p.approval.status}`, '');
  lines.push('## Resource');
  lines.push(`${p.resource.type} · ${p.resource.region} · ${p.resource.env} · team ${p.resource.team}${p.resource.size ? ' · ' + sizeLabel(p.resource.size) : ''}`, '');
  lines.push('## Proposed change');
  lines.push(`Action: **${r.action}** · current ${inr(p.costs.currentInr)}/mo → proposed ${inr(p.costs.proposedInr)}/mo · saving **${inr(r.monthlySavingInr)}/mo**`);
  lines.push(`Formula: ${r.savingFormula}`);
  for (const s of r.steps) lines.push(`- ${s.label}: cost after ${inr(s.costAfterInr)} (−${inr(s.marginalSavingInr)})`);
  lines.push('', '## Why');
  for (const reason of r.reasons) lines.push(`- ${reason}`);
  const ev = p.evidence;
  lines.push('', '## Data');
  lines.push(`Coverage ${(ev.coverage * 100).toFixed(0)}% · history ${ev.historyDays.toFixed(1)} days · last sample ${Number.isFinite(ev.lastSampleAgeHours) ? ev.lastSampleAgeHours.toFixed(1) + ' h' : '—'} old`);
  if (ev.cpu) lines.push(`CPU p50 ${pct(ev.cpu.p50)} · p95 ${pct(ev.cpu.p95)} · p99 ${pct(ev.cpu.p99)} · max ${pct(ev.cpu.max)}`);
  if (ev.mem) lines.push(`Memory p50 ${pct(ev.mem.p50)} · p95 ${pct(ev.mem.p95)} · p99 ${pct(ev.mem.p99)} · max ${pct(ev.mem.max)}`);
  if (r.checks.length) {
    lines.push('', '## Safety checks', '| Check | Limit | Actual | Result |', '|---|---|---|---|');
    for (const c of r.checks) {
      const fmt = (v: number | null) => (v === null ? '—' : c.unit === 'ratio' ? `${(v * 100).toFixed(0)}%` : c.unit === '%' ? `${v.toFixed(1)}%` : c.unit === 'count' ? `${v}` : `${v.toFixed(1)} ${c.unit}`);
      lines.push(`| ${c.id} ${c.label} | ${fmt(c.limit)} | ${fmt(c.actual)} | ${c.passed === null ? 'n/a' : c.passed ? 'pass' : 'FAIL'} |`);
    }
  }
  if (p.scenarioRuns.length) {
    lines.push('', '## Scenarios tested', '| Scenario | Model | Result |', '|---|---|---|');
    for (const s of p.scenarioRuns) lines.push(`| ${SCENARIOS[s.scenario].label} | ${s.model} | ${verdictText[s.verdict]} |`);
  }
  if (p.closestCall) {
    const cc = p.closestCall;
    lines.push('', '## Closest call (replay of history on the proposed size)');
    lines.push('Every sample is compared with the HARD limits (CPU max E3, memory 100% E8); the percentile checks above use the stricter p95/p99 limits.');
    if (cc.kind === 'closest-call') lines.push(`${cc.at}: projected ${cc.metric} ${pct(cc.projectedPct)} vs hard limit ${cc.limitPct}% → headroom ${cc.headroomPts.toFixed(1)} points.`);
    else if (cc.kind === 'first-breach') lines.push(`First breach at ${cc.at}: projected ${cc.metric} ${pct(cc.projectedPct)} vs limit ${cc.limitPct}% (${cc.breachCount} samples over).`);
    else lines.push('No samples available.');
  }
  if (p.breakPoint) {
    const b = p.breakPoint;
    lines.push('', '## Break point');
    if (b.kind === 'found') lines.push(`Stops passing at +${b.percent}% extra workload (still passes at +${b.lastPassingPercent}%).`);
    else if (b.kind === 'already-failing') lines.push('Already failing at the current workload.');
    else if (b.kind === 'none-found') lines.push(`No break point found within 0–${b.testedUpToPercent}% extra workload.`);
    else lines.push('Insufficient evidence to compute a break point.');
  }
  if (p.safeAlternative) {
    const a = p.safeAlternative;
    lines.push('', '## Safe alternative');
    lines.push(a.kind === 'found' ? `${sizeLabel(a.option.size)} · ${inr(a.option.monthlyCostInr)}/mo · saving ${inr(a.option.savingInr)}/mo — passes all checks.` : a.message);
    lines.push('Only catalog sizes up to the current one were tested; this is not a claim that no safe configuration exists.');
  }
  lines.push('', '## Approval');
  lines.push(`Status: ${p.approval.status}${p.approval.at ? ' at ' + p.approval.at : ''}${p.approval.acceptedSteps ? ' · steps: ' + p.approval.acceptedSteps.join(', ') : ''} · approved saving ${inr(p.approval.approvedSavingInr)}/mo`);
  lines.push('', `Assumptions: ${r.assumptionIds.join(', ')} (see assumptions.md)`, '', `> ${p.disclaimer}`);
  return lines.join('\n');
}
