// Phase 1: hand-built representative resources (SYNTHETIC). Each one has an intentional pattern
// so the engine's safe / unsafe / insufficient-evidence behaviour can be tested.
import { sampleInfo, isBusinessSample } from '../engine/time';
import type { MetricSeries, Resource } from '../engine/types';
import { mulberry32, uniform } from './random';

export const SERIES_START = '2026-09-07T00:00:00+05:30'; // a Monday, 00:00 IST
export const DAYS = 30;
const N = DAYS * 96;

const clamp = (v: number) => Math.min(100, Math.max(0, v));

export interface Shape {
  cpu: (i: number) => number;
  mem: (i: number) => number;
  net?: (i: number) => number;
  /** return true to make sample i missing */
  missing?: (i: number, rand: () => number) => boolean;
}

export function makeSeries(resourceId: string, seed: number, shape: Shape): MetricSeries {
  const rand = mulberry32(seed);
  const cpuPct: (number | null)[] = [];
  const memPct: (number | null)[] = [];
  const diskPct: (number | null)[] = [];
  const iops: (number | null)[] = [];
  const netInMbps: (number | null)[] = [];
  const netOutMbps: (number | null)[] = [];
  for (let i = 0; i < N; i++) {
    const cpu = clamp(shape.cpu(i));
    const mem = clamp(shape.mem(i));
    const net = Math.max(0, (shape.net ?? (() => 10 + uniform(rand, 4)))(i));
    const miss = shape.missing?.(i, rand) ?? false;
    cpuPct.push(miss ? null : Math.round(cpu * 100) / 100);
    memPct.push(miss ? null : Math.round(mem * 100) / 100);
    diskPct.push(miss ? null : Math.round(clamp(40 + uniform(rand, 2)) * 100) / 100);
    iops.push(miss ? null : Math.round(Math.max(0, cpu * 6 + uniform(rand, 20))));
    netInMbps.push(miss ? null : Math.round(net * 0.6 * 100) / 100);
    netOutMbps.push(miss ? null : Math.round(net * 0.4 * 100) / 100);
  }
  return { resourceId, start: SERIES_START, stepMinutes: 15, cpuPct, memPct, diskPct, iops, netInMbps, netOutMbps };
}

const r = (seed: number) => mulberry32(seed);

/** Synthetic boot disk per VM size (inventory field required by the brief; not priced — assumptions B7). */
export function bootDiskGb(size: { vcpu: number; ramGb: number }): number {
  if (size.ramGb <= 8) return 50;
  if (size.ramGb <= 32) return 100;
  return 200;
}

export function buildFixtures(): { resources: Resource[]; series: Map<string, MetricSeries> } {
  const resources: Resource[] = [];
  const series = new Map<string, MetricSeries>();
  const vm = (res: Omit<Resource, 'type' | 'createdAt'>, seed: number, shape: (rand: () => number) => Shape) => {
    const full: Resource = { ...res, type: 'vm', createdAt: '2025-11-01', diskGb: bootDiskGb({ vcpu: res.vcpu!, ramGb: res.ramGb! }) };
    resources.push(full);
    series.set(full.id, makeSeries(full.id, seed, shape(r(seed + 1))));
  };

  // 1. Underutilized dev VM → safe resize (PASS). Memory ~36% so +60% workload breaks the smaller size.
  vm({ id: 'vm-dev-underutil', name: 'search-dev-01', region: 'bengaluru', env: 'dev', team: 'search', vcpu: 8, ramGb: 32, pattern: 'steady-low' }, 101,
    (n) => ({ cpu: () => 12 + uniform(n, 3), mem: () => 36 + uniform(n, 2) }));

  // 2. Bursty prod VM: low average, short daily peak 10:00–10:45 → must NOT be downsized.
  vm({ id: 'vm-prod-bursty', name: 'payments-api-01', region: 'mumbai', env: 'prod', team: 'payments', vcpu: 8, ramGb: 32, pattern: 'bursty-prod' }, 202,
    (n) => ({
      cpu: (i) => { const { hour } = sampleInfo(i); return hour >= 10 && hour < 10.75 ? 70 + uniform(n, 5) : 8 + uniform(n, 2); },
      mem: () => 40 + uniform(n, 3),
    }));

  // 3. Healthy busy prod VM → no action.
  vm({ id: 'vm-prod-healthy', name: 'platform-core-01', region: 'noida', env: 'prod', team: 'platform', vcpu: 4, ramGb: 16, pattern: 'healthy-busy' }, 303,
    (n) => ({ cpu: (i) => (isBusinessSample(i) ? 60 : 40) + uniform(n, 8), mem: () => 60 + uniform(n, 5) }));

  // 4. Memory-heavy prod VM: CPU low, memory spikes to ~78% for 1 h daily → resize blocked by memory.
  vm({ id: 'vm-prod-memheavy', name: 'data-cache-01', region: 'bengaluru', env: 'prod', team: 'data', vcpu: 8, ramGb: 32, pattern: 'memory-heavy' }, 404,
    (n) => ({
      cpu: () => 10 + uniform(n, 3),
      mem: (i) => { const { hour } = sampleInfo(i); return hour >= 14 && hour < 15 ? 78 + uniform(n, 2) : 42 + uniform(n, 3); },
    }));

  // 5. Idle dev VM → stop.
  vm({ id: 'vm-dev-idle', name: 'growth-sandbox-01', region: 'mumbai', env: 'dev', team: 'growth', vcpu: 4, ramGb: 16, pattern: 'idle' }, 505,
    (n) => ({ cpu: () => 1.5 + uniform(n, 1), mem: () => 20 + uniform(n, 2), net: () => 0.3 + uniform(n, 0.2) }));

  // 6. Office-hours dev VM: busy 08–20 Mon–Fri, idle nights and weekends → schedule.
  vm({ id: 'vm-dev-officehours', name: 'search-dev-02', region: 'noida', env: 'dev', team: 'search', vcpu: 4, ramGb: 8, pattern: 'dev-idle-nights-weekends' }, 606,
    (n) => ({
      cpu: (i) => (isBusinessSample(i) ? 60 + uniform(n, 10) : 2 + uniform(n, 1)),
      mem: (i) => (isBusinessSample(i) ? 55 + uniform(n, 5) : 30 + uniform(n, 3)),
      net: (i) => (isBusinessSample(i) ? 20 + uniform(n, 5) : 0.5 + uniform(n, 0.3)),
    }));

  // 7. Nightly batch VM (01:00–03:00 at ~90%) → no action: the peak is real.
  vm({ id: 'vm-stg-batch', name: 'data-etl-01', region: 'mumbai', env: 'staging', team: 'data', vcpu: 4, ramGb: 16, pattern: 'batch-nightly' }, 707,
    (n) => ({ cpu: (i) => { const { hour } = sampleInfo(i); return hour >= 1 && hour < 3 ? 90 + uniform(n, 5) : 3 + uniform(n, 1); }, mem: () => 30 + uniform(n, 3) }));

  // 8. Staging VM with ~40% of samples missing → INSUFFICIENT EVIDENCE.
  vm({ id: 'vm-stg-gappy', name: 'platform-stg-01', region: 'bengaluru', env: 'staging', team: 'platform', vcpu: 8, ramGb: 32, pattern: 'data-gap' }, 808,
    (n) => ({ cpu: () => 15 + uniform(n, 3), mem: () => 30 + uniform(n, 3), missing: (_i, rand) => rand() < 0.4 }));

  // 9. Oversized staging VM that is ALSO idle off-hours → resize + schedule as ONE plan (conflict case).
  vm({ id: 'vm-stg-conflict', name: 'payments-stg-01', region: 'mumbai', env: 'staging', team: 'payments', vcpu: 8, ramGb: 32, pattern: 'oversized+off-hours' }, 909,
    (n) => ({
      cpu: (i) => (isBusinessSample(i) ? 18 + uniform(n, 3) : 2 + uniform(n, 1)),
      mem: () => 30 + uniform(n, 2),
      net: (i) => (isBusinessSample(i) ? 12 : 0.5), // quiet at night, so scheduling is allowed (D3)
    }));

  // 10. Anomaly: staging VM jumps from ~45% to ~95% CPU from day 22 → spike alert.
  vm({ id: 'vm-stg-anomaly', name: 'growth-stg-01', region: 'noida', env: 'staging', team: 'growth', vcpu: 4, ramGb: 16, pattern: 'anomaly-day-22' }, 1010,
    (n) => ({ cpu: (i) => (sampleInfo(i).day >= 22 ? 95 + uniform(n, 3) : 45 + uniform(n, 5)), mem: () => 50 + uniform(n, 4) }));

  // 11. New dev VM with only 9 days of history → INSUFFICIENT EVIDENCE.
  vm({ id: 'vm-dev-newbie', name: 'search-dev-03', region: 'bengaluru', env: 'dev', team: 'search', vcpu: 2, ramGb: 4, pattern: 'short-history' }, 1111,
    (n) => ({ cpu: () => 10 + uniform(n, 2), mem: () => 30 + uniform(n, 2), missing: (i) => sampleInfo(i).day < DAYS - 9 }));

  // 12. Orphaned volume (unattached 40 days).
  resources.push({ id: 'vol-orphan', name: 'growth-old-disk', type: 'volume', region: 'mumbai', env: 'dev', team: 'growth', createdAt: '2025-06-01', diskGb: 500, attachedTo: null, detachedDays: 40, pattern: 'orphaned-volume' });

  // 13. Unused public IP.
  resources.push({ id: 'ip-unused', name: 'search-old-ip', type: 'ip', region: 'noida', env: 'dev', team: 'search', createdAt: '2025-07-01', attachedTo: null, detachedDays: 20, pattern: 'unused-ip' });

  return { resources, series };
}
