// ForeSight — section E. Decides PASS UNDER TESTED CONDITIONS / FAIL SAFETY CHECKS / INSUFFICIENT EVIDENCE.
import { CONFIG, limitsFor } from './config';
import { sizeLabel } from './pricing';
import { burstiness, coverage, historyDays, lastSampleAgeHours, scaleStats, summarize } from './stats';
import type { CheckResult, Env, Risk, Size, Verdict } from './types';

export interface UsageInput {
  start?: string;
  stepMinutes?: number;
  /** Explicit wall-clock analysis time. When absent, data is historical replay, not live monitoring. */
  analysisTime?: string;
  cpuPct: readonly (number | null)[];
  memPct: readonly (number | null)[];
}

export interface DataCheckResult {
  ok: boolean;
  checks: CheckResult[];
  coverage: number;
  historyDays: number;
  lastSampleAgeHours: number;
  reasons: string[];
}

// Same arrays + same env always give the same answer; cache it (series are never mutated).
const dataCache = new WeakMap<object, WeakMap<object, Map<Env, DataCheckResult>>>();

/**
 * E9 helper: share of reported memory samples that are exactly 0%. A running VM always uses some RAM,
 * so 0% means the monitoring agent is broken or reporting placeholders — those samples are not evidence of idleness.
 */
export function implausibleFraction(memPct: readonly (number | null)[]): number {
  let reported = 0;
  let zero = 0;
  for (const m of memPct) {
    if (m === null) continue;
    reported++;
    if (m === 0) zero++;
  }
  return reported === 0 ? 0 : zero / reported;
}

/** E5–E7 + E9: is there enough recent, plausible data to judge at all? */
export function dataChecks(input: UsageInput, env: Env): DataCheckResult {
  let byMem = dataCache.get(input.cpuPct);
  if (!byMem) dataCache.set(input.cpuPct, (byMem = new WeakMap()));
  let byEnv = byMem.get(input.memPct);
  if (!byEnv) byMem.set(input.memPct, (byEnv = new Map()));
  const hit = byEnv.get(env);
  if (hit && input.analysisTime === undefined) return hit;
  const result = computeDataChecks(input, env);
  if (input.analysisTime === undefined) byEnv.set(env, result);
  return result;
}

function computeDataChecks(input: UsageInput, env: Env): DataCheckResult {
  const L = limitsFor(env);
  const cov = Math.min(coverage(input.cpuPct), coverage(input.memPct));
  const hist = Math.min(historyDays(input.cpuPct), historyDays(input.memPct));
  let age = Math.max(lastSampleAgeHours(input.cpuPct), lastSampleAgeHours(input.memPct));
  if (input.analysisTime !== undefined) {
    const start = input.start === undefined ? NaN : Date.parse(input.start);
    const at = Date.parse(input.analysisTime);
    const step = input.stepMinutes ?? 15;
    const lastObserved = (values: readonly (number | null)[]): number => {
      for (let i = values.length - 1; i >= 0; i--) {
        if (values[i] !== null) return start + i * step * 60000;
      }
      return NaN;
    };
    if (!Number.isFinite(start) || !Number.isFinite(at) || !Number.isFinite(step) || step <= 0) age = Infinity;
    else {
      const cpuAge = (at - lastObserved(input.cpuPct)) / 3600000;
      const memAge = (at - lastObserved(input.memPct)) / 3600000;
      age = cpuAge < 0 || memAge < 0 ? Infinity : Math.max(cpuAge, memAge);
    }
    // A future-dated sample is not fresh evidence either.
    if (!Number.isFinite(age) || age < 0) age = Infinity;
  }
  const minDays = CONFIG.foresight.minHistoryDays;
  const maxAge = CONFIG.foresight.maxSampleAgeHours;
  const maxBad = CONFIG.foresight.maxImplausibleFraction;
  const bad = implausibleFraction(input.memPct);

  const checks: CheckResult[] = [
    { id: 'E5', label: 'Data coverage', limit: L.coverage, actual: cov, passed: cov >= L.coverage, unit: 'ratio' },
    { id: 'E6', label: 'History length', limit: minDays, actual: hist, passed: hist >= minDays, unit: 'days' },
    { id: 'E7', label: 'Last sample age', limit: maxAge, actual: Number.isFinite(age) ? age : null, passed: age <= maxAge, unit: 'h' },
    { id: 'E9', label: 'Implausible samples (0% memory)', limit: maxBad, actual: bad, passed: bad <= maxBad, unit: 'ratio' },
  ];
  const reasons: string[] = [];
  if (!checks[0].passed) reasons.push(`Only ${(cov * 100).toFixed(0)}% of expected samples exist (need ${(L.coverage * 100).toFixed(0)}%).`);
  if (!checks[1].passed) reasons.push(`Only ${hist.toFixed(1)} days of history (need ${minDays}).`);
  if (!checks[2].passed) reasons.push(`Latest sample is ${Number.isFinite(age) ? age.toFixed(1) + ' h' : 'missing'} old (max ${maxAge} h).`);
  if (!checks[3].passed) {
    reasons.push(`${(bad * 100).toFixed(0)}% of samples report 0% memory, which a running VM cannot do — the monitoring agent may be broken, so low usage is not evidence of idleness (max ${(maxBad * 100).toFixed(0)}%).`);
  }
  return { ok: reasons.length === 0, checks, coverage: cov, historyDays: hist, lastSampleAgeHours: age, reasons };
}

export interface SizeEvaluation {
  verdict: Exclude<Verdict, 'NO_ACTION'>;
  checks: CheckResult[];
  reasons: string[];
  risk: Risk;
  dataAdequacyScore: number;
  projected: { cpuP95: number; cpuP99: number; cpuMax: number; memP99: number } | null;
  bursty: boolean;
}

/**
 * Evaluate running this workload on `target` (E1–E9). Never returns PASS when data is insufficient.
 * Precedence: any capacity check fails → FAIL (data flags kept); else data insufficient → INSUFFICIENT; else PASS.
 */
export function evaluateSize(input: UsageInput, current: Size, target: Size, env: Env): SizeEvaluation {
  const L = limitsFor(env);
  const data = dataChecks(input, env);
  // C4/C5: projected % = current % × current/target (see capacity.ts). Equivalent to projecting every sample.
  const cpuStats = summarize(input.cpuPct);
  const pc = scaleStats(cpuStats, current.vcpu / target.vcpu);
  const pm = scaleStats(summarize(input.memPct), current.ramGb / target.ramGb);
  const burst = burstiness(cpuStats);
  const bursty = burst !== null && burst > CONFIG.detection.burstinessBursty;
  const dataAdequacyScore = data.coverage * Math.min(1, data.historyDays / 30);
  const t = sizeLabel(target);

  if (!pc || !pm) {
    return {
      verdict: 'INSUFFICIENT_EVIDENCE',
      checks: data.checks,
      reasons: ['No CPU or memory samples available.', ...data.reasons],
      risk: 'high',
      dataAdequacyScore: 0,
      projected: null,
      bursty,
    };
  }

  const cap: CheckResult[] = [
    { id: 'E1', label: 'Projected CPU p95', limit: L.cpuP95, actual: pc.p95, passed: pc.p95 <= L.cpuP95, unit: '%' },
    { id: 'E2', label: 'Projected CPU p99', limit: L.cpuP99, actual: pc.p99, passed: pc.p99 <= L.cpuP99, unit: '%' },
    { id: 'E3', label: 'Projected CPU max', limit: L.cpuMax, actual: pc.max, passed: pc.max <= L.cpuMax, unit: '%' },
    { id: 'E4', label: 'Projected memory p99', limit: L.memP99, actual: pm.p99, passed: pm.p99 <= L.memP99, unit: '%' },
    // E8: every sample must stay below the memory headroom limit of the target's RAM.
    { id: 'E8', label: 'Projected memory max', limit: L.memMax, actual: pm.max, passed: pm.max <= L.memMax, unit: '%' },
  ];
  const capReasons = cap
    .filter((c) => !c.passed)
    .map((c) => {
      const name = c.label.replace('Projected ', '');
      return `${name[0].toUpperCase()}${name.slice(1)} would be ${c.actual!.toFixed(1)}% on ${t} (limit ${c.limit}%).`;
    });

  const projected = { cpuP95: pc.p95, cpuP99: pc.p99, cpuMax: pc.max, memP99: pm.p99 };
  const checks = [...cap, ...data.checks];

  // A demonstrated capacity failure wins over missing evidence (V6 safety contract): show FAIL and keep the data flags.
  if (capReasons.length > 0) {
    const dataFlags = data.reasons.map((r) => `Evidence is also incomplete: ${r}`);
    return { verdict: 'FAIL_SAFETY_CHECKS', checks, reasons: [...capReasons, ...dataFlags], risk: 'high', dataAdequacyScore, projected, bursty };
  }
  if (!data.ok) {
    return { verdict: 'INSUFFICIENT_EVIDENCE', checks, reasons: data.reasons, risk: 'high', dataAdequacyScore, projected, bursty };
  }

  // Risk from the smallest remaining margin (section E).
  const margin = Math.min(L.cpuP95 - pc.p95, L.cpuP99 - pc.p99, L.memP99 - pm.p99);
  let risk: Risk;
  if (margin < CONFIG.risk.mediumMarginPts || (env === 'prod' && bursty)) risk = 'high';
  else if (margin < CONFIG.risk.lowMarginPts || bursty) risk = 'medium';
  else risk = 'low';

  return {
    verdict: 'PASS_UNDER_TESTED_CONDITIONS',
    checks,
    reasons: [`All checks pass on ${t}; smallest margin to the p95/p99 limits: ${margin.toFixed(1)} points.`],
    risk,
    dataAdequacyScore,
    projected,
    bursty,
  };
}
