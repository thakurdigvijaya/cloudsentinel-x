// Sections D and H: detect waste and build ONE final plan per resource.
import { CONFIG, scheduleOffFraction, type ScheduleWindow } from './config';
import { dataChecks, evaluateSize, type SizeEvaluation } from './foresight';
import { buildSteps } from './plan';
import {
  cheaperCatalogSizes,
  ipMonthlyCost,
  resizeSaving,
  resizeScheduleSaving,
  resourceMonthlyCost,
  scheduleSaving,
  sizeLabel,
  stopSaving,
  vmMonthlyCost,
  volumeMonthlyCost,
} from './pricing';
import { burstiness, percentileWhere, summarize } from './stats';
import { isBusinessSample, isWeekendSample, slotOffset } from './time';
import type { AnalysisResult, Evidence, MetricSeries, Recommendation, Resource, Size } from './types';
import { validateResource, validateSeries } from './validate';

const HOURS = CONFIG.time.hoursPerMonth;

function baseRecommendation(r: Resource, evidence: Evidence): Omit<Recommendation, 'action' | 'proposed' | 'monthlySavingInr' | 'savingFormula' | 'steps' | 'checks' | 'verdict' | 'risk' | 'dataAdequacyScore' | 'reasons' | 'assumptionIds' | 'requiresHumanReview' | 'eligible'> {
  const cost = resourceMonthlyCost(r);
  const size = r.type === 'vm' ? { vcpu: r.vcpu!, ramGb: r.ramGb! } : undefined;
  return {
    id: `rec-${r.id}`,
    resourceId: r.id,
    resourceName: r.name,
    resourceType: r.type,
    env: r.env,
    region: r.region,
    team: r.team,
    current: { size, hoursOnPerMonth: HOURS, monthlyCostInr: cost },
    evidence,
  };
}

function finalize(rec: Omit<Recommendation, 'eligible' | 'steps'>): Recommendation {
  return {
    ...rec,
    steps: buildSteps(rec),
    eligible: rec.verdict === 'PASS_UNDER_TESTED_CONDITIONS' && rec.monthlySavingInr > 0,
  };
}

/**
 * Review finding 4: CPU inactivity is evidence, not proof, that a VM can be shut down.
 * Every stop / schedule recommendation states this and requires a human to confirm.
 */
export const SHUTDOWN_ASSUMPTION =
  'Assumes nothing depends on this VM while it is off (cron or batch jobs, inbound requests, replicas, other services, on-call access). Low CPU and network are evidence, not proof — confirm with the owning team before approving.';

/**
 * D3: CPU idle off-hours is not enough to schedule a shutdown — network must be quiet too.
 * Returns the reason scheduling is blocked, or null when off-hours network is quiet.
 */
function offHoursNetBlock(ev: Evidence): string | null {
  const n = ev.offHoursNetP95Mbps;
  const limit = CONFIG.detection.offHoursNetP95Mbps;
  if (n === null) return 'Not scheduled: CPU is idle off-hours but there is no off-hours network data to confirm nothing depends on this VM.';
  if (n < limit) return null;
  return `Not scheduled: CPU is idle off-hours but network traffic continues (p95 ${n.toFixed(1)} Mbps ≥ ${limit} Mbps) — something may still depend on this VM at night or on weekends.`;
}

const emptyEvidence: Evidence = {
  cpu: null, mem: null, netP95Mbps: null, offHoursCpuP95: null, offHoursNetP95Mbps: null,
  coverage: 1, historyDays: 0, lastSampleAgeHours: 0, burstiness: null,
};

/** "Naive" one-size-down proposal shown when no cheaper size passes: half vCPU and half RAM if in catalog. */
function naiveTarget(current: Size, candidates: Size[]): Size | null {
  const half = candidates.find((s) => s.vcpu === current.vcpu / 2 && s.ramGb === current.ramGb / 2);
  return half ?? candidates[candidates.length - 1] ?? null;
}

export function analyzeResource(r: Resource, series?: MetricSeries): AnalysisResult {
  const errors = validateResource(r);
  if (r.type === 'vm') {
    if (!series) errors.push({ field: 'series', message: 'A VM needs a metric series.' });
    else errors.push(...validateSeries(series));
  }
  if (errors.length > 0) return { ok: false, resourceId: r.id, errors };

  if (r.type === 'volume') return { ok: true, recommendation: analyzeVolume(r) };
  if (r.type === 'ip') return { ok: true, recommendation: analyzeIp(r) };
  return { ok: true, recommendation: analyzeVm(r, series!) };
}

function analyzeVolume(r: Resource): Recommendation {
  const base = baseRecommendation(r, emptyEvidence);
  const orphan = r.attachedTo == null && (r.detachedDays ?? 0) >= CONFIG.detection.orphanMinDays;
  if (!orphan) {
    return finalize({ ...base, action: 'none', proposed: base.current, monthlySavingInr: 0, savingFormula: '—', checks: [], verdict: 'NO_ACTION', risk: 'low', dataAdequacyScore: 1, reasons: ['Volume is attached or recently detached.'], assumptionIds: ['D4'], requiresHumanReview: false });
  }
  const saving = volumeMonthlyCost(r.diskGb!);
  return finalize({
    ...base,
    action: 'delete-volume',
    proposed: { hoursOnPerMonth: 0, monthlyCostInr: 0 },
    monthlySavingInr: saving,
    savingFormula: `H5: ${r.diskGb} GB × ₹${CONFIG.pricing.perGbDiskInr} = ₹${saving}`,
    checks: [],
    verdict: 'PASS_UNDER_TESTED_CONDITIONS',
    risk: 'low',
    dataAdequacyScore: 1,
    reasons: [`Unattached for ${r.detachedDays} days (threshold ${CONFIG.detection.orphanMinDays}). Take a snapshot before deleting.`],
    assumptionIds: ['D4', 'B4', 'H5'],
    requiresHumanReview: true,
  });
}

function analyzeIp(r: Resource): Recommendation {
  const base = baseRecommendation(r, emptyEvidence);
  if (r.attachedTo != null) {
    return finalize({ ...base, action: 'none', proposed: base.current, monthlySavingInr: 0, savingFormula: '—', checks: [], verdict: 'NO_ACTION', risk: 'low', dataAdequacyScore: 1, reasons: ['IP is attached to a running VM.'], assumptionIds: ['D5'], requiresHumanReview: false });
  }
  const saving = ipMonthlyCost();
  return finalize({
    ...base,
    action: 'release-ip',
    proposed: { hoursOnPerMonth: 0, monthlyCostInr: 0 },
    monthlySavingInr: saving,
    savingFormula: `H5: public IP ₹${saving}/month`,
    checks: [],
    verdict: 'PASS_UNDER_TESTED_CONDITIONS',
    risk: 'low',
    dataAdequacyScore: 1,
    reasons: [`Not attached to any VM for ${r.detachedDays ?? 0} days.`],
    assumptionIds: ['D5', 'B5', 'H5'],
    requiresHumanReview: true,
  });
}

// network in + out per sample; cached per series (series are never mutated)
const netCache = new WeakMap<MetricSeries, (number | null)[]>();
function totalNet(s: MetricSeries): (number | null)[] {
  let t = netCache.get(s);
  if (!t) {
    t = s.netInMbps.map((v, i) => (v === null || s.netOutMbps[i] === null ? null : v + s.netOutMbps[i]!));
    netCache.set(s, t);
  }
  return t;
}

export function vmEvidence(series: MetricSeries, env: Resource['env']): Evidence {
  const cpu = summarize(series.cpuPct);
  const mem = summarize(series.memPct);
  // Window p95s via quickselect (no sort); same nearest-rank values as summarize().p95.
  const netTotal = totalNet(series);
  const o = slotOffset(series.start);
  const offHours = (i: number) => !isBusinessSample(i + o);
  const weekendI = (i: number) => isWeekendSample(i + o);
  const net = percentileWhere(netTotal, 95);
  const off = percentileWhere(series.cpuPct, 95, offHours);
  const offNet = percentileWhere(netTotal, 95, offHours);
  const wkCpu = percentileWhere(series.cpuPct, 95, weekendI);
  const wkNet = percentileWhere(netTotal, 95, weekendI);
  const d = dataChecks(series, env);
  return {
    cpu,
    mem,
    netP95Mbps: net,
    offHoursCpuP95: off,
    offHoursNetP95Mbps: offNet,
    weekendCpuP95: wkCpu,
    weekendNetP95Mbps: wkNet,
    coverage: d.coverage,
    historyDays: d.historyDays,
    lastSampleAgeHours: d.lastSampleAgeHours,
    burstiness: burstiness(cpu),
  };
}

function analyzeVm(r: Resource, series: MetricSeries): Recommendation {
  const current: Size = { vcpu: r.vcpu!, ramGb: r.ramGb! };
  const ev = vmEvidence(series, r.env);
  const base = baseRecommendation(r, ev);
  const det = CONFIG.detection;
  const data = dataChecks(series, r.env);
  const dataAdequacyScore = data.coverage * Math.min(1, data.historyDays / 30);
  const currentCost = base.current.monthlyCostInr;

  const cpuP95 = ev.cpu?.p95 ?? Infinity;
  const memP95 = ev.mem?.p95 ?? Infinity;
  const isIdle = cpuP95 < det.idleCpuP95 && (ev.netP95Mbps ?? Infinity) < det.idleNetP95Mbps;
  const quietCpuOffHours = r.env !== 'prod' && (ev.offHoursCpuP95 ?? Infinity) < det.offHoursCpuP95;
  const scheduleBlock = quietCpuOffHours ? offHoursNetBlock(ev) : null;
  const nightsCandidate = quietCpuOffHours && scheduleBlock === null;
  // D3b: weekend-only schedule when nights are busy but Saturday + Sunday are quiet (CPU and network).
  const quietCpuWeekends = r.env !== 'prod' && !quietCpuOffHours && (ev.weekendCpuP95 ?? Infinity) < det.weekendCpuP95;
  const weekendNet = ev.weekendNetP95Mbps ?? null;
  const weekendBlock = !quietCpuWeekends
    ? null
    : weekendNet === null
      ? 'Not scheduled for weekends: CPU is idle on weekends but there is no weekend network data to confirm nothing depends on this VM.'
      : weekendNet >= det.weekendNetP95Mbps
        ? `Not scheduled for weekends: CPU is idle on weekends but network traffic continues (p95 ${weekendNet.toFixed(1)} Mbps ≥ ${det.weekendNetP95Mbps} Mbps).`
        : null;
  const weekendsCandidate = quietCpuWeekends && weekendBlock === null;
  const offHoursCandidate = nightsCandidate || weekendsCandidate;
  const window: ScheduleWindow = nightsCandidate ? 'nights-and-weekends' : 'weekends';
  const offFrac = scheduleOffFraction(window);
  const scheduleNote = scheduleBlock ?? weekendBlock;
  const windowText = window === 'weekends'
    ? `idle on weekends (weekend CPU p95 ${ev.weekendCpuP95?.toFixed(1)}%, network p95 ${ev.weekendNetP95Mbps?.toFixed(2)} Mbps) — shut down Saturday 00:00 to Monday 00:00`
    : `off-hours CPU p95 ${ev.offHoursCpuP95?.toFixed(1)}% and network p95 ${ev.offHoursNetP95Mbps?.toFixed(2)} Mbps — shut down 20:00–08:00 and weekends`;
  const scheduleIds = window === 'weekends' ? ['A3b', 'D3b'] : ['A3', 'D3'];
  const oversized = cpuP95 < det.oversizedCpuP95 && memP95 < det.oversizedMemP95;

  // Verdict for actions that do not change size: only data sufficiency matters.
  const dataVerdict = data.ok ? 'PASS_UNDER_TESTED_CONDITIONS' : 'INSUFFICIENT_EVIDENCE';

  // D1 idle
  if (isIdle) {
    if (r.env === 'prod') {
      return finalize({ ...base, action: 'none', proposed: base.current, monthlySavingInr: 0, savingFormula: '—', checks: data.checks, verdict: 'NO_ACTION', risk: 'high', dataAdequacyScore, reasons: ['Production VM looks idle — flagged for manual review, never auto-recommended to stop.'], assumptionIds: ['D1'], requiresHumanReview: true });
    }
    const saving = stopSaving(current, r.region);
    return finalize({
      ...base,
      action: 'stop',
      proposed: { size: current, hoursOnPerMonth: 0, monthlyCostInr: 0 },
      monthlySavingInr: saving,
      savingFormula: `H4: full compute price ₹${saving}`,
      checks: data.checks,
      verdict: dataVerdict,
      risk: data.ok ? 'low' : 'high',
      dataAdequacyScore,
      reasons: data.ok
        ? [`CPU p95 ${cpuP95.toFixed(1)}% and network p95 ${ev.netP95Mbps!.toFixed(2)} Mbps over ${ev.historyDays.toFixed(0)} days — idle.`, SHUTDOWN_ASSUMPTION]
        : data.reasons,
      assumptionIds: ['D1', 'H4', 'L'],
      requiresHumanReview: true,
    });
  }

  // D2 oversized → cheapest catalog size that passes ForeSight.
  let resizeEval: SizeEvaluation | null = null;
  let resizeTarget: Size | null = null;
  if (oversized) {
    const candidates = cheaperCatalogSizes(current, r.region);
    for (const c of candidates) {
      const e = evaluateSize(series, current, c, r.env);
      if (e.verdict === 'PASS_UNDER_TESTED_CONDITIONS') {
        resizeEval = e;
        resizeTarget = c;
        break;
      }
    }
    if (!resizeTarget) {
      // Nothing cheaper is safe: show the naive one-size-down proposal and WHY it is blocked.
      const naive = naiveTarget(current, candidates); // candidates are sorted cheapest → most expensive
      if (naive) {
        const e = evaluateSize(series, current, naive, r.env);
        if (!offHoursCandidate || e.verdict === 'INSUFFICIENT_EVIDENCE') {
          const saving = resizeSaving(current, naive, r.region);
          return finalize({
            ...base,
            action: 'resize',
            proposed: { size: naive, hoursOnPerMonth: HOURS, monthlyCostInr: vmMonthlyCost(naive, r.region) },
            monthlySavingInr: saving,
            savingFormula: `H1: ₹${currentCost} − ₹${vmMonthlyCost(naive, r.region)} = ₹${saving}`,
            checks: e.checks,
            verdict: e.verdict,
            risk: e.risk,
            dataAdequacyScore: e.dataAdequacyScore,
            reasons: e.verdict === 'FAIL_SAFETY_CHECKS'
              ? [`Not downsized: no cheaper size passes the safety checks.`, ...e.reasons]
              : e.reasons,
            assumptionIds: ['D2', 'E', 'H1'],
            requiresHumanReview: false,
          });
        }
      }
    }
  }

  // D6 conflict: resize + schedule as ONE final plan.

  if (resizeTarget && resizeEval && offHoursCandidate) {
    const saving = resizeScheduleSaving(current, resizeTarget, r.region, offFrac);
    const newCost = vmMonthlyCost(resizeTarget, r.region);
    return finalize({
      ...base,
      action: 'resize+schedule',
      scheduleWindow: window,
      proposed: { size: resizeTarget, hoursOnPerMonth: HOURS * (1 - offFrac), monthlyCostInr: currentCost - saving },
      monthlySavingInr: saving,
      savingFormula: `H3: ₹${currentCost} − ₹${newCost} × (1 − ${offFrac.toFixed(4)}) = ₹${saving}`,
      checks: resizeEval.checks,
      verdict: resizeEval.verdict,
      risk: resizeEval.risk,
      dataAdequacyScore: resizeEval.dataAdequacyScore,
      reasons: [
        `Oversized (CPU p95 ${cpuP95.toFixed(1)}%, memory p95 ${memP95.toFixed(1)}%) and ${windowText}.`,
        ...resizeEval.reasons,
        SHUTDOWN_ASSUMPTION,
      ],
      assumptionIds: ['D2', ...scheduleIds, 'D6', 'E', 'H3', 'L'],
      requiresHumanReview: true,
    });
  }

  if (resizeTarget && resizeEval) {
    const saving = resizeSaving(current, resizeTarget, r.region);
    return finalize({
      ...base,
      action: 'resize',
      proposed: { size: resizeTarget, hoursOnPerMonth: HOURS, monthlyCostInr: vmMonthlyCost(resizeTarget, r.region) },
      monthlySavingInr: saving,
      savingFormula: `H1: ₹${currentCost} − ₹${vmMonthlyCost(resizeTarget, r.region)} = ₹${saving}`,
      checks: resizeEval.checks,
      verdict: resizeEval.verdict,
      risk: resizeEval.risk,
      dataAdequacyScore: resizeEval.dataAdequacyScore,
      reasons: [
        `Oversized: CPU p95 ${cpuP95.toFixed(1)}%, memory p95 ${memP95.toFixed(1)}% → ${sizeLabel(resizeTarget)}.`,
        ...resizeEval.reasons,
        ...(scheduleNote ? [scheduleNote] : []),
      ],
      assumptionIds: ['D2', 'E', 'H1'],
      requiresHumanReview: false,
    });
  }

  // D3 off-hours scheduling.
  if (offHoursCandidate) {
    const saving = scheduleSaving(current, r.region, offFrac);
    return finalize({
      ...base,
      action: 'schedule',
      scheduleWindow: window,
      proposed: { size: current, hoursOnPerMonth: HOURS * (1 - offFrac), monthlyCostInr: currentCost - saving },
      monthlySavingInr: saving,
      savingFormula: `H2: ₹${currentCost} × ${offFrac.toFixed(4)} = ₹${saving}`,
      checks: data.checks,
      verdict: dataVerdict,
      risk: data.ok ? 'low' : 'high',
      dataAdequacyScore,
      reasons: data.ok
        ? [
            `${r.env} VM: ${windowText}.`,
            SHUTDOWN_ASSUMPTION,
          ]
        : data.reasons,
      assumptionIds: [...scheduleIds, 'H2', 'L'],
      requiresHumanReview: true,
    });
  }

  // No action.
  return finalize({
    ...base,
    action: 'none',
    proposed: base.current,
    monthlySavingInr: 0,
    savingFormula: '—',
    checks: data.checks,
    verdict: data.ok ? 'NO_ACTION' : 'INSUFFICIENT_EVIDENCE',
    risk: 'low',
    dataAdequacyScore,
    reasons: data.ok
      ? scheduleNote
        ? [scheduleNote]
        : [`Well utilised: CPU p95 ${cpuP95.toFixed(1)}%, memory p95 ${memP95.toFixed(1)}%. No change recommended.`]
      : data.reasons,
    assumptionIds: ['D'],
    requiresHumanReview: false,
  });
}
