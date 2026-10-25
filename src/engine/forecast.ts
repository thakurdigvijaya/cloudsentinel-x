// Bonus: cost and usage forecasting for the next 30–90 days (UTHO bonus feature). Section S of assumptions.md.
// Simple, explainable models only (no ML). Every forecast states its method; spend is a RANGE, not one number.
import { CONFIG } from './config';
import { round2 } from './pricing';
import { dailyPercentile, linearFit } from './stats';
import type { MetricSeries, Resource } from './types';

export const FORECAST_HORIZONS = [30, 60, 90] as const;

export interface SpendForecastPoint {
  days: number;
  /** today's daily run-rate × days — assumes no new resources and no changes */
  runRateInr: number;
  /** linear trend of the observed daily spend, extended — assumes growth continues like the last window */
  trendInr: number;
  /** run-rate minus the given monthly savings (e.g. eligible or approved), pro-rated per day */
  runRateAfterSavingsInr: number;
}

export interface SpendForecast {
  points: SpendForecastPoint[];
  dailyRunRateInr: number;
  trendSlopeInrPerDay: number;
  method: string;
}

/**
 * @param daily estimated daily spend (from `dailySpend`)
 * @param monthlySavingsInr monthly savings to subtract for the "after savings" line (0 = none)
 */
export function forecastSpend(daily: readonly number[], monthlySavingsInr = 0): SpendForecast {
  const n = daily.length;
  const last = daily[n - 1] ?? 0;
  const { slope, intercept } = linearFit(daily);
  const perDaySaving = (monthlySavingsInr * 24) / CONFIG.time.hoursPerMonth;
  const points = FORECAST_HORIZONS.map((days) => {
    // sum of the trend line for days n .. n+days-1, never below 0 per day
    let trend = 0;
    for (let d = 0; d < days; d++) trend += Math.max(0, intercept + slope * (n + d));
    return {
      days,
      runRateInr: round2(last * days),
      trendInr: round2(trend),
      runRateAfterSavingsInr: round2(Math.max(0, last - perDaySaving) * days),
    };
  });
  return {
    points,
    dailyRunRateInr: round2(last),
    trendSlopeInrPerDay: round2(slope),
    method:
      `Run-rate = last day's estimated spend × days (no new resources). Trend = straight line fitted to ${n} days of estimated spend, extended ` +
      `(${slope >= 0 ? '+' : ''}₹${Math.round(slope).toLocaleString('en-IN')}/day). The real future is likely between the two. ` +
      'Estimated from inventory with illustrative prices — not a bill.',
  };
}

export interface CapacityForecast {
  resourceId: string;
  metric: 'cpu' | 'memory';
  currentDailyP95: number;
  slopePerDay: number;
  /** projected daily p95 (% of the CURRENT size) at each horizon; may exceed 100% = demand above capacity */
  projected: { days: number; p95: number }[];
  /** days until the projected daily p95 reaches the capacity limit (I3, 85%); null = not within 90 days or not rising */
  daysToLimit: number | null;
  method: string;
}

/** Daily p95 of a metric (one value per day with any samples). */
export function dailyP95(values: readonly (number | null)[]): number[] {
  return dailyPercentile(values, CONFIG.time.samplesPerDay, 95);
}

/** Linear trend of daily p95, extended 30/60/90 days. Returns null when there is too little history (< E6 days). */
export function forecastCapacity(r: Resource, s: MetricSeries, metric: 'cpu' | 'memory' = 'cpu'): CapacityForecast | null {
  const daily = dailyP95(metric === 'cpu' ? s.cpuPct : s.memPct);
  if (daily.length < CONFIG.foresight.minHistoryDays) return null;
  const { slope, intercept } = linearFit(daily);
  const n = daily.length;
  const at = (days: number) => intercept + slope * (n - 1 + days);
  const limit = CONFIG.alerts.capacityLimitPct;
  const current = daily[n - 1];
  let daysToLimit: number | null = null;
  const fittedNow = at(0);
  if (fittedNow >= limit) daysToLimit = 0;
  else if (slope > 0) {
    const d = Math.ceil((limit - fittedNow) / slope);
    if (d <= FORECAST_HORIZONS[FORECAST_HORIZONS.length - 1]) daysToLimit = d;
  }
  return {
    resourceId: r.id,
    metric,
    currentDailyP95: round2(current),
    slopePerDay: Math.round(slope * 1000) / 1000,
    projected: FORECAST_HORIZONS.map((days) => ({ days, p95: round2(at(days)) })),
    daysToLimit,
    method: `Straight line fitted to ${n} daily ${metric === 'cpu' ? 'CPU' : 'memory'} p95 values, extended. A trend, not a promise: one-off jumps (anomalies) distort it.`,
  };
}
