// Alerts & insights (section I). Every alert explains why it was raised.
// Spend-increase (I2) and budget-overrun (I4) need billing history: added with the full dataset in Phase 2.
import { CONFIG } from './config';
import { dataChecks } from './foresight';
import { dailyPercentile, linearFit, percentileWhere } from './stats';
import { formatIst, isWeekendSample, slotOffset } from './time';
import type { Alert, MetricSeries, Resource } from './types';

/** I1: sample > same-hour mean + 3σ of the previous 7 days AND at least 20 points above that mean. CPU and memory. */
export function detectSpike(r: Resource, s: MetricSeries, metric: 'cpu' | 'memory' = 'cpu'): Alert | null {
  const A = CONFIG.alerts;
  const perDay = CONFIG.time.samplesPerDay;
  const cpu = metric === 'cpu' ? s.cpuPct : s.memPct;
  const label = metric === 'cpu' ? 'CPU' : 'Memory';
  let first = -1;
  let count = 0;
  let worst = { value: 0, mean: 0, threshold: 0 };
  for (let i = A.baselineDays * perDay; i < cpu.length; i++) {
    const v = cpu[i];
    if (v === null) continue;
    // same-hour baseline over the previous days, computed without allocating arrays
    let n = 0;
    let sum = 0;
    let sumSq = 0;
    for (let d = 1; d <= A.baselineDays; d++) {
      const b = cpu[i - d * perDay];
      if (b !== null) {
        n++;
        sum += b;
        sumSq += b * b;
      }
    }
    if (n < 3) continue;
    const mean = sum / n;
    const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
    const threshold = Math.max(mean + A.spikeSigma * sd, mean + A.spikeMinJumpPts);
    if (v > threshold) {
      if (first === -1) {
        first = i;
        worst = { value: v, mean, threshold };
      }
      count++;
    }
  }
  if (first === -1) return null;
  return {
    id: metric === 'cpu' ? `alert-spike-${r.id}` : `alert-spike-mem-${r.id}`,
    type: 'usage-spike',
    severity: r.env === 'prod' ? 'critical' : 'warning',
    resourceId: r.id,
    title: `Unusual ${metric === 'cpu' ? 'CPU' : 'memory'} spike on ${r.name}`,
    why: `At ${formatIst(s.start, first)} ${label} was ${worst.value.toFixed(1)}%, above the threshold of ${worst.threshold.toFixed(1)}% (same-hour average of the previous ${A.baselineDays} days was ${worst.mean.toFixed(1)}%). ${count} samples exceeded the threshold.`,
    firstSeen: formatIst(s.start, first),
    synthetic: true,
  };
}

/** I3: linear fit of daily CPU p95 reaches the capacity limit within the horizon (or is already above it). */
export function detectCapacityTrend(r: Resource, s: MetricSeries): Alert | null {
  const A = CONFIG.alerts;
  const daily = dailyPercentile(s.cpuPct, CONFIG.time.samplesPerDay, 95);
  if (daily.length < CONFIG.foresight.minHistoryDays) return null;
  const { slope, intercept } = linearFit(daily);
  const last = daily[daily.length - 1];
  const lastFit = intercept + slope * (daily.length - 1);
  if (last >= A.capacityLimitPct) {
    // A VM that has run at its limit EVERY day, flat and steady (e.g. a nightly batch), is a known pattern, not news:
    // keep it visible as "info" with a clear title instead of a critical alert every day (alert-noise fix, §I3).
    const mean = daily.reduce((a, b) => a + b, 0) / daily.length;
    const sd = Math.sqrt(daily.reduce((a, b) => a + (b - mean) ** 2, 0) / daily.length);
    const min = Math.min(...daily);
    if (min >= A.capacityLimitPct - A.recurringBandPts && Math.abs(slope) <= A.recurringMaxSlope && sd <= A.recurringMaxSd) {
      return {
        id: `alert-capacity-${r.id}`, type: 'capacity-trend', severity: 'warning', resourceId: r.id,
        title: `${r.name} runs at its capacity limit every day (steady pattern)`,
        why: `Daily CPU p95 has been ${min.toFixed(1)}–${Math.max(...daily).toFixed(1)}% on all ${daily.length} days, with no upward trend (${slope.toFixed(2)} points/day). ` +
          'Recurring saturation is not a new incident, but sustained high usage still requires capacity review; it is not proof of safe headroom. Not downsized.',
        synthetic: true,
      };
    }
    return {
      id: `alert-capacity-${r.id}`, type: 'capacity-trend', severity: 'critical', resourceId: r.id,
      title: `${r.name} is at its capacity limit`,
      why: `Latest daily CPU p95 is ${last.toFixed(1)}%, at or above the ${A.capacityLimitPct}% capacity limit.`,
      synthetic: true,
    };
  }
  if (slope <= 0) return null;
  const daysToLimit = (A.capacityLimitPct - lastFit) / slope;
  if (daysToLimit > A.capacityHorizonDays) return null;
  return {
    id: `alert-capacity-${r.id}`, type: 'capacity-trend', severity: 'warning', resourceId: r.id,
    title: `${r.name} is trending toward its capacity limit`,
    why: `Daily CPU p95 is rising ${slope.toFixed(2)} points/day; at this linear trend it reaches ${A.capacityLimitPct}% in about ${Math.ceil(daysToLimit)} days.`,
    synthetic: true,
  };
}

/**
 * I5: unexpected pattern — a production VM busier on weekends than on weekdays (weekend p95 CPU > 1.5 × weekday p95
 * and ≥ 20%). For a B2B SaaS that is unusual: a forgotten load test, a runaway job, or traffic nobody expected.
 */
export function detectWeekendSurge(r: Resource, s: MetricSeries): Alert | null {
  if (r.env !== 'prod') return null;
  const A = CONFIG.alerts;
  const o = slotOffset(s.start);
  const wk = percentileWhere(s.cpuPct, 95, (i) => isWeekendSample(i + o));
  const wd = percentileWhere(s.cpuPct, 95, (i) => !isWeekendSample(i + o));
  if (wk === null || wd === null) return null;
  if (wk < A.weekendMinP95 || wk <= A.weekendRatio * wd) return null;
  return {
    id: `alert-pattern-${r.id}`, type: 'unexpected-pattern', severity: 'warning', resourceId: r.id,
    title: `${r.name} is busier on weekends than on weekdays`,
    why: `Weekend CPU p95 is ${wk.toFixed(1)}% vs ${wd.toFixed(1)}% on weekdays (more than ${A.weekendRatio}×). Unusual for a production service — check for a forgotten load test, a runaway job or unexpected traffic.`,
    synthetic: true,
  };
}

/** I6: not enough data to judge safely. */
export function detectInsufficientData(r: Resource, s: MetricSeries): Alert | null {
  const d = dataChecks(s, r.env);
  if (d.ok) return null;
  return {
    id: `alert-data-${r.id}`, type: 'insufficient-data', severity: 'warning', resourceId: r.id,
    title: `Insufficient monitoring data for ${r.name}`,
    why: d.reasons.join(' '),
    synthetic: true,
  };
}

export function generateAlerts(resources: readonly Resource[], series: ReadonlyMap<string, MetricSeries>): Alert[] {
  const out: Alert[] = [];
  for (const r of resources) {
    const s = series.get(r.id);
    if (r.type !== 'vm' || !s) continue;
    for (const a of [detectSpike(r, s), detectSpike(r, s, 'memory'), detectCapacityTrend(r, s), detectWeekendSurge(r, s), detectInsufficientData(r, s)]) if (a) out.push(a);
  }
  return out;
}
