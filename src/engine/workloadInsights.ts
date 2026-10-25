// Deterministic workload visualizations and telemetry adequacy diagnostics.
// These are explanations of the observed dataset, not safety approvals or a trained ML model.
import type { MetricSeries } from './types';

export interface TelemetryQuality {
  samples: number;
  complete: number;
  coverage: number;
  missingCpu: number;
  missingMemory: number;
  zeroMemoryPct: number;
  longestGapMinutes: number;
  /** Descriptive state only: ForeSight remains the authority for PASS/FAIL/INSUFFICIENT. */
  status: 'good' | 'review' | 'insufficient';
}

export function telemetryQuality(series: MetricSeries): TelemetryQuality {
  const samples = Math.max(series.cpuPct.length, series.memPct.length);
  let missingCpu = 0;
  let missingMemory = 0;
  let complete = 0;
  let zeroMemory = 0;
  let longestGap = 0;
  let currentGap = 0;
  for (let i = 0; i < samples; i++) {
    const cpu = series.cpuPct[i];
    const mem = series.memPct[i];
    const validCpu = cpu !== null && cpu !== undefined && Number.isFinite(cpu);
    const validMem = mem !== null && mem !== undefined && Number.isFinite(mem);
    if (!validCpu) missingCpu++;
    if (!validMem) missingMemory++;
    if (validCpu && validMem) {
      complete++;
      currentGap = 0;
      if (mem === 0) zeroMemory++;
    } else {
      currentGap++;
      if (currentGap > longestGap) longestGap = currentGap;
    }
  }
  const coverage = samples ? complete / samples : 0;
  const zeroMemoryPct = complete ? (100 * zeroMemory) / complete : 0;
  const durationDays = samples * series.stepMinutes / 1440;
  const status = coverage < 0.75 || durationDays < 14 || zeroMemoryPct > 1
    ? 'insufficient'
    : coverage < 0.95 || longestGap * series.stepMinutes > 60
      ? 'review'
      : 'good';
  return {
    samples, complete, coverage, missingCpu, missingMemory, zeroMemoryPct,
    longestGapMinutes: longestGap * series.stepMinutes, status,
  };
}

export interface PulseBucket {
  day: number; // Monday=0 ... Sunday=6, IST
  hour: number;
  value: number | null;
  samples: number;
  expectedSamples: number;
}

/** Aggregate observed CPU or memory into a Monday–Sunday × 00:00–23:00 IST heatmap. */
export function weeklyPulse(series: MetricSeries, metric: 'cpu' | 'memory'): PulseBucket[] {
  const values = metric === 'cpu' ? series.cpuPct : series.memPct;
  const buckets = Array.from({ length: 168 }, (_, i) => ({
    day: Math.floor(i / 24), hour: i % 24, sum: 0, samples: 0, expectedSamples: 0,
  }));
  const start = Date.parse(series.start);
  if (!Number.isFinite(start)) return buckets.map(({ day, hour }) => ({ day, hour, value: null, samples: 0, expectedSamples: 0 }));
  const IST_OFFSET = 330 * 60_000;
  const stepMs = series.stepMinutes * 60_000;
  for (let i = 0; i < values.length; i++) {
    const date = new Date(start + i * stepMs + IST_OFFSET);
    const day = (date.getUTCDay() + 6) % 7;
    const hour = date.getUTCHours();
    const bucket = buckets[day * 24 + hour];
    bucket.expectedSamples++;
    const v = values[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) {
      bucket.sum += v;
      bucket.samples++;
    }
  }
  return buckets.map(({ day, hour, sum, samples, expectedSamples }) => ({
    day, hour, value: samples ? sum / samples : null, samples, expectedSamples,
  }));
}
