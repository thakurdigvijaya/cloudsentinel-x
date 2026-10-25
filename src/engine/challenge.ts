// Challenge Lab engine (P1): Closest Call, Safe Alternative, 3-way comparison, break point.
// Pure functions on top of ForeSight. They never change approvals (Preview Mode).
// The Challenge Lab feature is NOT complete until its UI and P1 tests exist (team correction 2).
import { limitsFor } from './config';
import { evaluateSize, type SizeEvaluation, type UsageInput } from './foresight';
import { cheaperCatalogSizes, resizeSaving, sizeLabel, vmMonthlyCost } from './pricing';
import { applyScenario } from './scenarios';
import { formatIst } from './time';
import type { Env, MetricSeries, Region, Resource, ScenarioId, Size } from './types';

// ---------------------------------------------------------------- Closest Call (assumptions §N)

export type ClosestCallResult =
  | {
      kind: 'closest-call';
      index: number;
      at: string;
      metric: 'cpu' | 'memory';
      projectedPct: number;
      limitPct: number;
      headroomPts: number;
    }
  | { kind: 'first-breach'; index: number; at: string; metric: 'cpu' | 'memory'; projectedPct: number; limitPct: number; breachCount: number }
  | { kind: 'no-data' };

/**
 * Replays every historical sample on the target size and compares it with the HARD per-sample limits
 * (CPU: E3 max limit, 100% for every environment; memory: E8 limit, 98%). Returns the moment with
 * the smallest headroom, or the first breach if any sample goes over. Replay of synthetic history — not a prediction.
 */
export function closestCall(usage: UsageInput, startIso: string, current: Size, target: Size, env: Env): ClosestCallResult {
  const cpuLimit = limitsFor(env).cpuMax;
  const memLimit = limitsFor(env).memMax;
  const fc = current.vcpu / target.vcpu;
  const fm = current.ramGb / target.ramGb;
  let best: { index: number; metric: 'cpu' | 'memory'; projected: number; limit: number; headroom: number } | null = null;
  let firstBreach: { index: number; metric: 'cpu' | 'memory'; projected: number; limit: number } | null = null;
  let breachCount = 0;

  for (let i = 0; i < usage.cpuPct.length; i++) {
    const c = usage.cpuPct[i];
    const m = usage.memPct[i];
    const candidates: { metric: 'cpu' | 'memory'; projected: number; limit: number }[] = [];
    if (c !== null) candidates.push({ metric: 'cpu', projected: c * fc, limit: cpuLimit });
    if (m !== null) candidates.push({ metric: 'memory', projected: m * fm, limit: memLimit });
    let breachedHere = false;
    for (const k of candidates) {
      const headroom = k.limit - k.projected;
      if (headroom < 0) {
        breachedHere = true;
        if (!firstBreach) firstBreach = { index: i, ...k };
      } else if (!best || headroom < best.headroom) {
        best = { index: i, ...k, headroom };
      }
    }
    if (breachedHere) breachCount++;
  }

  if (firstBreach) {
    return {
      kind: 'first-breach', index: firstBreach.index, at: formatIst(startIso, firstBreach.index), metric: firstBreach.metric,
      projectedPct: firstBreach.projected, limitPct: firstBreach.limit, breachCount,
    };
  }
  if (!best) return { kind: 'no-data' };
  return {
    kind: 'closest-call', index: best.index, at: formatIst(startIso, best.index), metric: best.metric,
    projectedPct: best.projected, limitPct: best.limit, headroomPts: best.headroom,
  };
}

// ---------------------------------------------------------------- Safe Alternative (assumptions §P)

export interface ConfigOption {
  size: Size;
  monthlyCostInr: number;
  savingInr: number;
  evaluation: SizeEvaluation;
}

/**
 * found                 — a cheaper catalog size passes all checks.
 * keep-current          — no CHEAPER catalog size passes, but the current size passes: keep it (no saving).
 * current-also-fails    — no cheaper size passes and the current size fails too: a LARGER size may be
 *                         needed; larger sizes are not evaluated by this cost tool.
 * insufficient-evidence — the data is not good enough to judge any size.
 * None of these claims that "no safe configuration exists" — only the catalog sizes listed were tested.
 */
export type SafeAlternativeResult =
  | { kind: 'found'; option: ConfigOption; whyOriginalFailed: string[]; message: string }
  | { kind: 'keep-current'; current: ConfigOption; whyOriginalFailed: string[]; message: string }
  | { kind: 'current-also-fails'; current: ConfigOption; whyOriginalFailed: string[]; message: string }
  | { kind: 'insufficient-evidence'; reasons: string[]; whyOriginalFailed: string[]; message: string };

function option(usage: UsageInput, current: Size, size: Size, env: Env, region: Region): ConfigOption {
  return {
    size,
    monthlyCostInr: vmMonthlyCost(size, region),
    savingInr: resizeSaving(current, size, region),
    evaluation: evaluateSize(usage, current, size, env),
  };
}

/**
 * Cheapest catalog size, cheaper than the current one, that passes ALL ForeSight checks
 * (CPU and memory) under the given usage. Never invents a configuration.
 */
export function safeAlternative(usage: UsageInput, current: Size, failedTarget: Size | null, env: Env, region: Region): SafeAlternativeResult {
  const whyOriginalFailed = failedTarget ? evaluateSize(usage, current, failedTarget, env).reasons : [];
  const cur = option(usage, current, current, env, region);
  if (cur.evaluation.verdict === 'INSUFFICIENT_EVIDENCE') {
    return {
      kind: 'insufficient-evidence', reasons: cur.evaluation.reasons, whyOriginalFailed,
      message: 'Not enough data to judge any size (current or cheaper).',
    };
  }
  for (const size of cheaperCatalogSizes(current, region)) {
    const o = option(usage, current, size, env, region);
    if (o.evaluation.verdict === 'PASS_UNDER_TESTED_CONDITIONS') {
      return { kind: 'found', option: o, whyOriginalFailed, message: `Cheaper size that passes all checks: ${sizeLabel(size)}.` };
    }
  }
  if (cur.evaluation.verdict === 'PASS_UNDER_TESTED_CONDITIONS') {
    return {
      kind: 'keep-current', current: cur, whyOriginalFailed,
      message: `No cheaper catalog size passes all checks. The current size (${sizeLabel(current)}) passes — keep it.`,
    };
  }
  return {
    kind: 'current-also-fails', current: cur, whyOriginalFailed,
    message: `No cheaper catalog size passes, and the current size (${sizeLabel(current)}) also fails under these conditions. A larger size may be needed; larger sizes are not evaluated here.`,
  };
}

// ---------------------------------------------------------------- Three-way comparison

export interface Comparison {
  /** scenario id, or a label such as "+45% workload" when built from custom usage */
  scenario: ScenarioId | string;
  current: ConfigOption;
  /** cheapest catalog size cheaper than current, whatever its verdict */
  cheapest: ConfigOption | null;
  /** cheapest size that passes all checks (may equal `cheapest`) */
  cheapestSafe: ConfigOption | null;
}

/** Current vs cheapest vs cheapest-safe, all evaluated by the same engine under one scenario. */
export function compareConfigurations(resource: Resource, series: MetricSeries, scenario: ScenarioId = 'normal'): Comparison {
  return compareForUsage(resource, applyScenario(series, scenario), scenario);
}

/** Same comparison for any usage (e.g. the Challenge Lab slider's custom extra workload). */
export function compareForUsage(resource: Resource, usage: UsageInput, label: ScenarioId | string): Comparison {
  const current: Size = { vcpu: resource.vcpu!, ramGb: resource.ramGb! };
  const cheaper = cheaperCatalogSizes(current, resource.region);
  const alt = safeAlternative(usage, current, null, resource.env, resource.region);
  return {
    scenario: label,
    current: option(usage, current, current, resource.env, resource.region),
    cheapest: cheaper.length ? option(usage, current, cheaper[0], resource.env, resource.region) : null,
    cheapestSafe: alt.kind === 'found' ? alt.option : null,
  };
}

// ---------------------------------------------------------------- Break point (assumptions §P, team correction 3)

export type BreakPointResult =
  | { kind: 'found'; percent: number; lastPassingPercent: number; failingReasons: string[] }
  | { kind: 'already-failing'; reasons: string[] }
  | { kind: 'none-found'; testedUpToPercent: number }
  | { kind: 'insufficient-evidence'; reasons: string[] };

export const BREAK_POINT_MAX_PERCENT = 200;
/** Memory grows 0.4 × the extra workload (same proportional assumption as F2/F3). */
export const BREAK_POINT_MEM_SHARE = 0.4;

export function withExtraWorkload(usage: UsageInput, percent: number): UsageInput {
  const t = percent / 100;
  return {
    start: usage.start, stepMinutes: usage.stepMinutes, analysisTime: usage.analysisTime,
    cpuPct: usage.cpuPct.map((v) => (v === null ? null : v * (1 + t))),
    memPct: usage.memPct.map((v) => (v === null ? null : v * (1 + BREAK_POINT_MEM_SHARE * t))),
  };
}

/**
 * Smallest extra workload (whole %, 0–200) at which `target` stops passing.
 * Never invents a percentage: reports already-failing, none-found or insufficient-evidence instead.
 * Valid because every check rises monotonically with workload.
 */
export function breakPoint(usage: UsageInput, current: Size, target: Size, env: Env): BreakPointResult {
  const at = (p: number) => evaluateSize(withExtraWorkload(usage, p), current, target, env);
  const base = at(0);
  if (base.verdict === 'INSUFFICIENT_EVIDENCE') return { kind: 'insufficient-evidence', reasons: base.reasons };
  if (base.verdict === 'FAIL_SAFETY_CHECKS') return { kind: 'already-failing', reasons: base.reasons };
  if (at(BREAK_POINT_MAX_PERCENT).verdict === 'PASS_UNDER_TESTED_CONDITIONS') {
    return { kind: 'none-found', testedUpToPercent: BREAK_POINT_MAX_PERCENT };
  }
  let lo = 0; // passes
  let hi = BREAK_POINT_MAX_PERCENT; // fails
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (at(mid).verdict === 'PASS_UNDER_TESTED_CONDITIONS') lo = mid;
    else hi = mid;
  }
  return { kind: 'found', percent: hi, lastPassingPercent: lo, failingReasons: at(hi).reasons };
}

export const describeSize = (o: ConfigOption | null) => (o ? `${sizeLabel(o.size)} · ₹${o.monthlyCostInr}/mo` : '—');
