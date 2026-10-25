// I1 on memory, and I5 unexpected pattern (prod busier on weekends). Added 24 Oct.
import { describe, expect, it } from 'vitest';
import { makeSeries, type Shape } from '../../data/fixtures';
import { generateDataset } from '../../data/generator';
import { buildFixtures } from '../../data/fixtures';
import { analyzeAll } from '../index';
import { detectCapacityTrend, detectSpike, detectWeekendSurge } from '../alerts';
import { sampleInfo } from '../time';
import type { Resource } from '../types';

const vm = (id: string, env: Resource['env'] = 'prod'): Resource => ({
  id, name: id, type: 'vm', region: 'mumbai', env, team: 't', createdAt: '2025-11-01', pattern: 'test', vcpu: 8, ramGb: 16,
});
const series = (shape: Shape) => makeSeries('x', 4, shape);
const weekend = (i: number) => sampleInfo(i).weekday >= 5;

describe('I1 memory spike', () => {
  it('fires on a memory jump with time, threshold and baseline in the reason', () => {
    const s = series({ cpu: () => 30, mem: (i) => (sampleInfo(i).day >= 20 ? 85 : 45) });
    const a = detectSpike(vm('m'), s, 'memory')!;
    expect(a).not.toBeNull();
    expect(a.id).toBe('alert-spike-mem-m');
    expect(a.title).toBe('Unusual memory spike on m');
    expect(a.why).toMatch(/Memory was 85\.0%, above the threshold of \d+\.\d%/);
    expect(a.why).toMatch(/2026-09-27/); // day 20 after the Monday 7 Sep start
  });
  it('does not fire on flat memory, and a CPU-only jump does not raise a memory alert', () => {
    const s = series({ cpu: (i) => (sampleInfo(i).day >= 20 ? 90 : 30), mem: () => 45 });
    expect(detectSpike(vm('m'), s, 'memory')).toBeNull();
    expect(detectSpike(vm('m'), s, 'cpu')).not.toBeNull();
  });
  it('guard: a jump smaller than 20 points does not fire even if it is many σ', () => {
    const s = series({ cpu: () => 30, mem: (i) => (sampleInfo(i).day >= 20 ? 60 : 45) });
    expect(detectSpike(vm('m'), s, 'memory')).toBeNull();
  });
});

describe('I5 unexpected pattern: production busier on weekends', () => {
  it('fires when weekend p95 > 1.5 × weekday p95 and ≥ 20%', () => {
    const a = detectWeekendSurge(vm('w'), series({ cpu: (i) => (weekend(i) ? 60 : 25), mem: () => 40 }))!;
    expect(a.type).toBe('unexpected-pattern');
    expect(a.why).toMatch(/Weekend CPU p95 is 60\.0% vs 25\.0% on weekdays/);
  });
  it('boundary: exactly 1.5× does not fire; tiny absolute numbers do not fire', () => {
    expect(detectWeekendSurge(vm('w'), series({ cpu: (i) => (weekend(i) ? 30 : 20), mem: () => 40 }))).toBeNull();
    expect(detectWeekendSurge(vm('w'), series({ cpu: (i) => (weekend(i) ? 15 : 3), mem: () => 40 }))).toBeNull();
  });
  it('only production: the same pattern on dev is not alerted', () => {
    expect(detectWeekendSurge(vm('w', 'dev'), series({ cpu: (i) => (weekend(i) ? 60 : 25), mem: () => 40 }))).toBeNull();
  });
});

describe('On the datasets', () => {
  const d = generateDataset();
  const a = analyzeAll(d.resources, d.series);
  const byPattern = (p: string) => d.resources.filter((r) => d.patternOf.get(r.id) === p).map((r) => r.id);

  it('the anomaly VM raises both a CPU and a memory spike', () => {
    const [id] = byPattern('anomaly');
    expect(a.alerts.some((x) => x.id === `alert-spike-${id}`)).toBe(true);
    expect(a.alerts.some((x) => x.id === `alert-spike-mem-${id}`)).toBe(true);
  });
  it('I5 fires exactly for the weekend-surge VM and nothing else', () => {
    const fired = a.alerts.filter((x) => x.type === 'unexpected-pattern').map((x) => x.resourceId);
    expect(fired).toEqual(byPattern('weekend-surge'));
  });
  it('fixtures raise no I5 and no memory spike (no false alarms)', () => {
    const f = buildFixtures();
    const fa = analyzeAll(f.resources, f.series).alerts;
    expect(fa.filter((x) => x.type === 'unexpected-pattern')).toHaveLength(0);
    expect(fa.filter((x) => x.id.startsWith('alert-spike-mem-'))).toHaveLength(0);
  });
  it('every alert explains why', () => {
    for (const x of a.alerts) expect(x.why.length).toBeGreaterThan(20);
  });
});

describe('I3 alert noise: steady at-limit pattern stays warning; new or rising saturation stays critical', () => {
  it('every day at ~88% (nightly batch) → info with "steady pattern" title', () => {
    const s = series({ cpu: (i) => (sampleInfo(i).hour < 4 ? 92 : 20), mem: () => 40 }); // 4 h/day at 92% → daily p95 ≈ 92
    const a = detectCapacityTrend(vm('b', 'staging'), s)!;
    expect(a.severity).toBe('warning');
    expect(a.title).toMatch(/every day \(steady pattern\)/);
    expect(a.why).toMatch(/no upward trend/);
  });
  it('limit reached only recently (jump) → critical', () => {
    const s = series({ cpu: (i) => (sampleInfo(i).day >= 22 ? 95 : 45), mem: () => 40 });
    expect(detectCapacityTrend(vm('j', 'staging'), s)!.severity).toBe('critical');
  });
  it('at the limit but still climbing → critical', () => {
    const s = series({ cpu: (i) => 80 + sampleInfo(i).day * 0.5, mem: () => 40 }); // 80 → 94.5, +0.5/day
    expect(detectCapacityTrend(vm('c', 'staging'), s)!.severity).toBe('critical');
  });
  it('dataset: batch VMs are info, the anomaly VM is critical', () => {
    const d = generateDataset();
    const a = analyzeAll(d.resources, d.series);
    for (const x of a.alerts.filter((y) => y.type === 'capacity-trend')) {
      expect(x.severity).toBe(d.patternOf.get(x.resourceId!) === 'batch-nightly' ? 'warning' : 'critical');
    }
  });
});
