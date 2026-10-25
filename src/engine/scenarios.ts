// ChaosPilot demand models (section F) and Challenge Lab PREVIEW MODE.
// Preview functions are pure: they never change approvals, approved savings or decision history.
import { CONFIG } from './config';
import { dataChecks, evaluateSize } from './foresight';
import { summarize } from './stats';
import { sampleInfo, slotOffset } from './time';
import type { CheckResult, MetricSeries, Recommendation, Resource, Risk, ScenarioId, Size, StepAction, Verdict } from './types';

export const SCENARIOS: Record<ScenarioId, { label: string; model: string }> = {
  normal: { label: 'Normal historical demand', model: 'F1: historical series unchanged' },
  traffic25: { label: '+25% workload', model: 'F2: CPU demand × 1.25, memory × 1.10' },
  traffic60: { label: '+60% workload', model: 'F3: CPU demand × 1.60, memory × 1.25' },
  cpuBurst: { label: 'Sudden CPU burst', model: 'F4: each weekday 10:00–12:00 at 2 × historical CPU p99' },
  memPressure: { label: 'Memory pressure', model: 'F5: memory × 1.35, CPU unchanged' },
  missingData: { label: 'Missing monitoring records', model: 'F6: 40% of samples removed (seeded)' },
};

/** Deterministic PRNG (mulberry32) so scenario F6 is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const scale = (arr: readonly (number | null)[], f: number) => arr.map((v) => (v === null ? null : v * f));

/** Returns CPU and memory (as % of the CURRENT size; may exceed 100) under a scenario. */
export function applyScenario(series: MetricSeries, scenario: ScenarioId) {
  // Preserve sampling metadata so an old imported dataset does not become 'fresh'
  // merely because a scenario copied its CPU/RAM arrays.
  const stamped = (s: { cpuPct: (number | null)[]; memPct: (number | null)[] }) =>
    ({ ...s, start: series.start, stepMinutes: series.stepMinutes, analysisTime: series.analysisTime });
  const S = CONFIG.scenarios;
  const cpu = series.cpuPct;
  const mem = series.memPct;
  switch (scenario) {
    case 'normal':
      return stamped({ cpuPct: [...cpu], memPct: [...mem] });
    case 'traffic25':
      return stamped({ cpuPct: scale(cpu, S.traffic25.cpu), memPct: scale(mem, S.traffic25.mem) });
    case 'traffic60':
      return stamped({ cpuPct: scale(cpu, S.traffic60.cpu), memPct: scale(mem, S.traffic60.mem) });
    case 'memPressure':
      return stamped({ cpuPct: [...cpu], memPct: scale(mem, S.memPressure.mem) });
    case 'cpuBurst': {
      const p99 = summarize(cpu)?.p99 ?? 0;
      const burst = S.cpuBurst.multiplierOfP99 * p99;
      const o = slotOffset(series.start);
      const out = cpu.map((v, i) => {
        const { weekday, hour } = sampleInfo(i + o);
        const inBlock = weekday < 5 && hour >= S.cpuBurst.startHour && hour < S.cpuBurst.startHour + S.cpuBurst.hours;
        return inBlock && v !== null ? Math.max(v, burst) : v;
      });
      return stamped({ cpuPct: out, memPct: [...mem] });
    }
    case 'missingData': {
      const rand = mulberry32(S.missingData.seed);
      const drop = cpu.map(() => rand() < S.missingData.dropFraction);
      return stamped({
        cpuPct: cpu.map((v, i) => (drop[i] ? null : v)),
        memPct: mem.map((v, i) => (drop[i] ? null : v)),
      });
    }
  }
}

export interface PreviewResult {
  scenario: ScenarioId;
  model: string;
  verdict: Verdict;
  risk: Risk;
  checks: CheckResult[];
  reasons: string[];
  projected: { cpuP95: number; cpuP99: number; cpuMax: number; memP99: number } | null;
  /** would this recommendation be eligible for approval under the scenario? */
  eligible: boolean;
  /** steps that still pass on their own under the scenario (resize needs ForeSight PASS; schedule/remove need sufficient data) */
  validSteps: StepAction[];
  /** Preview Mode: nothing global was changed */
  preview: true;
}

/**
 * Challenge Lab — PREVIEW MODE. Re-evaluates one recommendation under a scenario with the real engine.
 * Pure: approvals, approved savings and decision history are untouched.
 */
export function previewRecommendation(
  resource: Resource,
  series: MetricSeries,
  rec: Recommendation,
  scenario: ScenarioId,
): PreviewResult {
  const usage = applyScenario(series, scenario);
  const model = SCENARIOS[scenario].model;
  const current: Size = { vcpu: resource.vcpu!, ramGb: resource.ramGb! };

  if ((rec.action === 'resize' || rec.action === 'resize+schedule') && rec.proposed.size) {
    const e = evaluateSize(usage, current, rec.proposed.size, resource.env);
    // Dependency Shield blocks are not workload questions: a preview never re-enables a blocked step.
    const blocked = rec.blockedSteps ?? [];
    const g1 = rec.checks.filter((c) => c.id === 'G1');
    const eligible = e.verdict === 'PASS_UNDER_TESTED_CONDITIONS' && rec.monthlySavingInr > 0 && blocked.length === 0;
    const dataOk = dataChecks(usage, resource.env).ok;
    const validSteps = rec.steps
      .map((s) => s.action)
      .filter((s) => !blocked.includes(s))
      .filter((s) => (s === 'resize' ? e.verdict === 'PASS_UNDER_TESTED_CONDITIONS' : dataOk && rec.verdict === 'PASS_UNDER_TESTED_CONDITIONS'));
    return {
      scenario, model,
      verdict: blocked.length && e.verdict === 'PASS_UNDER_TESTED_CONDITIONS' ? 'FAIL_SAFETY_CHECKS' : e.verdict,
      risk: blocked.length ? 'high' : e.risk,
      checks: [...e.checks, ...g1],
      reasons: blocked.length ? [rec.reasons[0], ...e.reasons] : e.reasons,
      projected: e.projected,
      eligible, validSteps: eligible ? rec.steps.map((s) => s.action) : validSteps, preview: true,
    };
  }

  // stop / schedule / none keep the current size; only evidence sufficiency can change.
  const d = dataChecks(usage, resource.env);
  const verdict: Verdict = !d.ok ? 'INSUFFICIENT_EVIDENCE' : rec.verdict;
  const eligible = verdict === 'PASS_UNDER_TESTED_CONDITIONS' && rec.monthlySavingInr > 0;
  return {
    scenario, model, verdict, risk: d.ok ? rec.risk : 'high', checks: d.checks,
    reasons: d.ok ? ['Size does not change for this action; evidence remains sufficient.'] : d.reasons,
    projected: null,
    eligible, validSteps: eligible ? rec.steps.map((s) => s.action) : [], preview: true,
  };
}

/** Builds the re-validated recommendation used when a team explicitly ADOPTS new planning assumptions. */
export function revalidate(rec: Recommendation, preview: PreviewResult): Recommendation {
  return {
    ...rec,
    verdict: preview.verdict,
    risk: preview.risk,
    checks: preview.checks,
    reasons: [`Revalidated under "${SCENARIOS[preview.scenario].label}".`, ...preview.reasons],
    eligible: preview.eligible,
    validSteps: preview.validSteps,
  };
}
