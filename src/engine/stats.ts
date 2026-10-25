// C1–C3: percentiles, coverage, history, burstiness. Pure functions.
import { CONFIG } from './config';
import type { UsageStats } from './types';

export function nonNull(values: readonly (number | null)[]): number[] {
  const out: number[] = [];
  for (const v of values) if (v !== null) out.push(v);
  return out;
}

/** C1 nearest-rank percentile on an ascending-sorted array. */
export function percentileSorted(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

/** Rearranges buf[0..n) so that buf[k] is the k-th smallest (0-based). Quickselect, Hoare partition, average O(n). */
function selectInPlace(buf: Float64Array, n: number, k: number): number {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const a = buf[lo], b = buf[mid], c = buf[hi];
    const pivot = a < b ? (b < c ? b : a < c ? c : a) : a < c ? a : b < c ? c : b; // median of three
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (buf[i] < pivot) i++;
      while (buf[j] > pivot) j--;
      if (i <= j) {
        const t = buf[i];
        buf[i] = buf[j];
        buf[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return buf[k];
  }
  return buf[k];
}

/** Nearest-rank percentile of each block of `perDay` samples (one value per day that has samples). One buffer, no sort. */
export function dailyPercentile(values: readonly (number | null)[], perDay: number, p: number): number[] {
  const buf = new Float64Array(perDay);
  const out: number[] = [];
  for (let d = 0; d * perDay < values.length; d++) {
    let n = 0;
    const end = Math.min(values.length, (d + 1) * perDay);
    for (let i = d * perDay; i < end; i++) {
      const v = values[i];
      if (v !== null) buf[n++] = v;
    }
    if (n > 0) out.push(selectInPlace(buf, n, rankIndex(p, n)));
  }
  return out;
}

const rankIndex = (p: number, n: number) => Math.min(Math.max(1, Math.ceil((p / 100) * n)), n) - 1;

/**
 * Nearest-rank percentile of the non-null values for which `keep(i)` is true, WITHOUT sorting.
 * Same result as percentileSorted on the sorted values. null when no value is kept.
 */
export function percentileWhere(values: readonly (number | null)[], p: number, keep?: (i: number) => boolean): number | null {
  const buf = new Float64Array(values.length);
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== null && (!keep || keep(i))) buf[n++] = v;
  }
  if (n === 0) return null;
  return selectInPlace(buf, n, rankIndex(p, n));
}

// Series arrays are never mutated, so stats can be cached per array (performance: avoids re-sorting).
const statsCache = new WeakMap<readonly (number | null)[], UsageStats | null>();

export function summarize(values: readonly (number | null)[]): UsageStats | null {
  const cached = statsCache.get(values);
  if (cached !== undefined) return cached;
  // One pass for count / sum / max, then three quickselects on the same buffer (no full sort).
  const buf = new Float64Array(values.length);
  let n = 0;
  let sum = 0;
  let max = -Infinity;
  for (const x of values) {
    if (x === null) continue;
    buf[n++] = x;
    sum += x;
    if (x > max) max = x;
  }
  let out: UsageStats | null = null;
  if (n > 0) {
    const p99 = selectInPlace(buf, n, rankIndex(99, n));
    const p95 = selectInPlace(buf, n, rankIndex(95, n));
    const p50 = selectInPlace(buf, n, rankIndex(50, n));
    out = { p50, p95, p99, max, mean: sum / n, count: n };
  }
  statsCache.set(values, out);
  return out;
}

/**
 * Stats of (every sample × factor), for factor > 0. Multiplying by a positive constant keeps the
 * order of samples, so each nearest-rank percentile is simply multiplied too — no re-sort needed.
 */
export function scaleStats(s: UsageStats | null, factor: number): UsageStats | null {
  if (!s) return null;
  return { p50: s.p50 * factor, p95: s.p95 * factor, p99: s.p99 * factor, max: s.max * factor, mean: s.mean * factor, count: s.count };
}

/** C2 coverage = non-null samples / expected samples (expected = series length). */
export function coverage(values: readonly (number | null)[]): number {
  if (values.length === 0) return 0;
  let n = 0;
  for (const v of values) if (v !== null) n++;
  return n / values.length;
}

/** Days between first and last non-null sample (inclusive). */
export function historyDays(values: readonly (number | null)[]): number {
  let first = -1;
  let last = -1;
  values.forEach((v, i) => {
    if (v !== null) {
      if (first === -1) first = i;
      last = i;
    }
  });
  if (first === -1) return 0;
  return (last - first + 1) / CONFIG.time.samplesPerDay;
}

/** Hours between the last non-null sample and the end of the series. */
export function lastSampleAgeHours(values: readonly (number | null)[]): number {
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== null) return ((values.length - 1 - i) * CONFIG.time.stepMinutes) / 60;
  }
  return Infinity;
}

/** C3 burstiness = p99 / max(p50, 1). */
export function burstiness(stats: UsageStats | null): number | null {
  if (!stats) return null;
  return stats.p99 / Math.max(stats.p50, 1);
}

/** Least-squares slope and intercept for y over x = 0..n-1. */
export function linearFit(ys: readonly number[]): { slope: number; intercept: number } {
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0 };
  const xMean = (n - 1) / 2;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  ys.forEach((y, x) => {
    num += (x - xMean) * (y - yMean);
    den += (x - xMean) ** 2;
  });
  const slope = den === 0 ? 0 : num / den;
  return { slope, intercept: yMean - slope * xMean };
}
