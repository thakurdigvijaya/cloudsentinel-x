import { describe, expect, it } from 'vitest';
import type { MetricSeries } from '../types';
import { telemetryQuality, weeklyPulse } from '../workloadInsights';
const samples = (cpu: (number | null)[], mem: (number | null)[], start='2026-09-07T00:00:00+05:30'): MetricSeries => ({
  resourceId:'vm-test',start,stepMinutes:15,cpuPct:cpu,memPct:mem,
  diskPct:cpu.map(()=>0),iops:cpu.map(()=>0),netInMbps:cpu.map(()=>0),netOutMbps:cpu.map(()=>0),
});
describe('Telemetry and heatmap diagnostics', () => {
  it('identifies missing intervals, longest gap and suspect zero memory', () => {
    const s=samples(Array(1440).fill(20),Array(1440).fill(30));
    s.cpuPct[1]=null;s.cpuPct[2]=null;s.memPct[10]=0;
    const q=telemetryQuality(s);
    expect(q.complete).toBe(1438);
    expect(q.longestGapMinutes).toBe(30);
    expect(q.missingCpu).toBe(2);
    expect(q.zeroMemoryPct).toBeCloseTo(100/1438);
    expect(q.status).toBe('good'); // 15 days of near-complete data; ForeSight has independent adequacy checks
  });
  it('buckets samples by real IST day/hour without inventing missing measurements', () => {
    const s=samples([5,15,null,20],[30,40,50,60]);
    const pulse=weeklyPulse(s,'cpu');
    expect(pulse).toHaveLength(168);
    expect(pulse[0].day).toBe(0);
    expect(pulse[0].hour).toBe(0);
    expect(pulse[0].samples).toBe(3);
    expect(pulse[0].expectedSamples).toBe(4);
    expect(pulse[0].value).toBeCloseTo(40/3);
    expect(pulse[1].value).toBeNull();
  });
});
