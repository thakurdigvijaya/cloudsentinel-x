// Bonus: 30–90 day forecasting (assumptions §S).
import { describe, expect, it } from 'vitest';
import { makeSeries } from '../../data/fixtures';
import { generateDataset } from '../../data/generator';
import { aggregate, analyzeAll } from '../index';
import { dailySpend } from '../spend';
import { dailyP95, forecastCapacity, forecastSpend } from '../forecast';
import { sampleInfo } from '../time';
import type { Resource } from '../types';

describe('Spend forecast', () => {
  it('flat spend → run-rate = trend = daily × days', () => {
    const f = forecastSpend(new Array(30).fill(1000));
    expect(f.points.map((p) => p.days)).toEqual([30, 60, 90]);
    for (const p of f.points) {
      expect(p.runRateInr).toBe(1000 * p.days);
      expect(p.trendInr).toBeCloseTo(1000 * p.days, 6);
    }
    expect(f.trendSlopeInrPerDay).toBe(0);
  });

  it('rising spend → trend above run-rate, and the method says so', () => {
    const f = forecastSpend(Array.from({ length: 30 }, (_, i) => 1000 + 10 * i)); // last day 1290, +10/day
    const p30 = f.points[0];
    expect(p30.runRateInr).toBe(1290 * 30);
    // trend days 30..59: sum(1000 + 10 d) = 30 × 1000 + 10 × (30+59) × 30/2
    expect(p30.trendInr).toBeCloseTo(30 * 1000 + 10 * ((30 + 59) * 30) / 2, 6);
    expect(p30.trendInr).toBeGreaterThan(p30.runRateInr);
    expect(f.method).toMatch(/Run-rate .* Trend .* not a bill/);
  });

  it('savings: subtracted pro-rata per day and never below zero', () => {
    const f = forecastSpend(new Array(30).fill(1000), 7300); // 7300/month = 240/day
    expect(f.points[0].runRateAfterSavingsInr).toBeCloseTo((1000 - 240) * 30, 6);
    expect(forecastSpend(new Array(30).fill(10), 1e9).points[2].runRateAfterSavingsInr).toBe(0);
  });

  it('a falling trend never forecasts negative spend', () => {
    const f = forecastSpend(Array.from({ length: 30 }, (_, i) => Math.max(0, 300 - 20 * i)));
    for (const p of f.points) expect(p.trendInr).toBeGreaterThanOrEqual(0);
  });

  it('on the dataset: after-eligible-savings < run-rate ≤ trend (growing bill)', () => {
    const d = generateDataset();
    const t = aggregate(d.resources, analyzeAll(d.resources, d.series).recommendations, {});
    const f = forecastSpend(dailySpend(d.resources, d.start, 30), t.eligibleInr);
    for (const p of f.points) {
      expect(p.runRateAfterSavingsInr).toBeLessThan(p.runRateInr);
      expect(p.runRateInr).toBeLessThanOrEqual(p.trendInr);
    }
  });
});

describe('Capacity forecast', () => {
  const vm: Resource = { id: 'c', name: 'c', type: 'vm', region: 'mumbai', env: 'prod', team: 't', createdAt: '2025-11-01', pattern: 'test', vcpu: 4, ramGb: 16 };

  it('daily p95 has one value per day', () => {
    expect(dailyP95(makeSeries('c', 1, { cpu: () => 30, mem: () => 40 }).cpuPct)).toHaveLength(30);
  });

  it('rising CPU (+1 point/day from 40%) reaches 85% in the predicted number of days', () => {
    const s = makeSeries('c', 1, { cpu: (i) => 40 + sampleInfo(i).day, mem: () => 40 });
    const f = forecastCapacity(vm, s)!;
    expect(f.slopePerDay).toBeCloseTo(1, 3);
    expect(f.projected[0].p95).toBeCloseTo(69 + 30, 1);
    expect(f.daysToLimit).toBe(16); // 85 − 69 = 16 days
  });

  it('flat or falling usage → no limit date; memory works the same way', () => {
    const s = makeSeries('c', 1, { cpu: () => 30, mem: (i) => 70 - sampleInfo(i).day });
    expect(forecastCapacity(vm, s)!.daysToLimit).toBeNull();
    expect(forecastCapacity(vm, s, 'memory')!.daysToLimit).toBeNull();
  });

  it('too little history → null (no invented forecast)', () => {
    const s = makeSeries('c', 1, { cpu: () => 30, mem: () => 40, missing: (i) => sampleInfo(i).day < 20 });
    expect(forecastCapacity(vm, s)).toBeNull();
  });

  it('projected values above 100% are reported, not clamped (demand above capacity is visible)', () => {
    const s = makeSeries('c', 1, { cpu: (i) => 40 + 2 * sampleInfo(i).day, mem: () => 40 });
    expect(forecastCapacity(vm, s)!.projected[2].p95).toBeGreaterThan(100);
  });
});
