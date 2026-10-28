// Phase 2: seeded synthetic dataset for the full UTHO scenario (assumptions.md §K).
// ~90 VMs + volumes + public IPs across Noida / Bengaluru / Mumbai and prod / staging / dev.
// SYNTHETIC: every pattern below is intentional and documented.
import { isBusinessSample, sampleInfo } from '../engine/time';
import type { Env, MetricSeries, Region, Resource, Size } from '../engine/types';
import { DAYS, SERIES_START, bootDiskGb, makeSeries, type Shape } from './fixtures';
import { mulberry32, uniform } from './random';

export const DATASET_SEED = 2026;

export type Pattern =
  | 'steady-low'
  | 'healthy-busy'
  | 'bursty-prod'
  | 'daily-peak'
  | 'memory-heavy'
  | 'batch-nightly'
  | 'weekend-idle'
  | 'office-hours'
  | 'idle'
  | 'anomaly'
  | 'data-gap'
  | 'short-history'
  | 'new-this-week'
  | 'oversized-office-hours'
  | 'night-traffic'
  | 'weekend-surge';

/** How many VMs of each pattern per environment. Total = 90. */
export const MIX: Record<Env, Partial<Record<Pattern, number>>> = {
  prod: { 'healthy-busy': 9, 'bursty-prod': 6, 'daily-peak': 5, 'steady-low': 3, 'memory-heavy': 2, 'new-this-week': 4, 'weekend-surge': 1 },
  staging: { 'steady-low': 6, 'oversized-office-hours': 2, 'batch-nightly': 4, 'weekend-idle': 4, 'office-hours': 4, anomaly: 1, 'data-gap': 1, 'new-this-week': 2, 'night-traffic': 1 },
  dev: { 'office-hours': 14, idle: 6, 'steady-low': 6, 'oversized-office-hours': 2, 'weekend-idle': 4, 'short-history': 1, 'new-this-week': 1, 'night-traffic': 1 },
};

const REGIONS: Region[] = ['noida', 'bengaluru', 'mumbai'];
const TEAMS = ['payments', 'search', 'platform', 'growth', 'data'];
const SIZES_BY_PATTERN: Record<Pattern, Size[]> = {
  'steady-low': [{ vcpu: 8, ramGb: 32 }, { vcpu: 4, ramGb: 16 }, { vcpu: 8, ramGb: 16 }],
  'oversized-office-hours': [{ vcpu: 8, ramGb: 32 }, { vcpu: 16, ramGb: 64 }],
  'healthy-busy': [{ vcpu: 4, ramGb: 16 }, { vcpu: 8, ramGb: 16 }, { vcpu: 8, ramGb: 32 }],
  'bursty-prod': [{ vcpu: 8, ramGb: 32 }, { vcpu: 16, ramGb: 32 }],
  'daily-peak': [{ vcpu: 4, ramGb: 16 }, { vcpu: 8, ramGb: 16 }],
  'memory-heavy': [{ vcpu: 8, ramGb: 32 }, { vcpu: 16, ramGb: 64 }],
  'batch-nightly': [{ vcpu: 4, ramGb: 16 }, { vcpu: 8, ramGb: 16 }],
  'weekend-idle': [{ vcpu: 4, ramGb: 8 }, { vcpu: 4, ramGb: 16 }],
  'office-hours': [{ vcpu: 2, ramGb: 8 }, { vcpu: 4, ramGb: 8 }, { vcpu: 4, ramGb: 16 }],
  'night-traffic': [{ vcpu: 4, ramGb: 8 }, { vcpu: 4, ramGb: 16 }],
  'weekend-surge': [{ vcpu: 8, ramGb: 16 }],
  idle: [{ vcpu: 2, ramGb: 4 }, { vcpu: 4, ramGb: 16 }],
  anomaly: [{ vcpu: 4, ramGb: 16 }],
  'data-gap': [{ vcpu: 8, ramGb: 32 }],
  'short-history': [{ vcpu: 2, ramGb: 4 }],
  'new-this-week': [{ vcpu: 16, ramGb: 64 }, { vcpu: 16, ramGb: 32 }],
};

/** New VMs are created on these days of the 30-day window (drives the spend-increase alert). */
const NEW_VM_DAYS = [23, 23, 23, 24, 24, 25, 25];

function shapeFor(p: Pattern, n: () => number, k: () => number, createdDay: number): Shape {
  const level = (lo: number, hi: number) => lo + k() * (hi - lo); // per-VM level, fixed for the VM
  switch (p) {
    case 'oversized-office-hours': {
      // Too big even at its busiest AND idle nights/weekends → resize + schedule (multi-step plan).
      const c = level(14, 22);
      return {
        cpu: (i) => (isBusinessSample(i) ? c + uniform(n, 3) : 2 + uniform(n, 1)),
        mem: () => 30 + uniform(n, 2),
        net: (i) => (isBusinessSample(i) ? 15 + uniform(n, 4) : 0.4 + uniform(n, 0.2)),
      };
    }
    case 'steady-low': {
      const c = level(8, 18), m = level(20, 40);
      return { cpu: () => c + uniform(n, 3), mem: () => m + uniform(n, 3) };
    }
    case 'healthy-busy': {
      const c = level(55, 65), m = level(55, 70);
      return { cpu: (i) => (isBusinessSample(i) ? c : c - 20) + uniform(n, 8), mem: () => m + uniform(n, 5) };
    }
    case 'bursty-prod': {
      const startHour = [9, 10, 11, 18][Math.floor(k() * 4)];
      const base = level(6, 10), peak = level(65, 80), m = level(35, 45);
      return {
        cpu: (i) => { const { hour } = sampleInfo(i); return hour >= startHour && hour < startHour + 0.75 ? peak + uniform(n, 5) : base + uniform(n, 2); },
        mem: () => m + uniform(n, 3),
      };
    }
    case 'daily-peak': {
      const peak = level(70, 85), m = level(40, 55);
      return {
        cpu: (i) => { const { hour } = sampleInfo(i); const d = Math.abs(hour - 13); return Math.max(10, peak - d * 7) + uniform(n, 4); },
        mem: () => m + uniform(n, 4),
      };
    }
    case 'memory-heavy': {
      const spike = level(76, 82);
      return {
        cpu: () => 10 + uniform(n, 3),
        mem: (i) => { const { hour } = sampleInfo(i); return hour >= 14 && hour < 15 ? spike + uniform(n, 2) : 42 + uniform(n, 3); },
      };
    }
    case 'batch-nightly':
      return { cpu: (i) => { const { hour } = sampleInfo(i); return hour >= 1 && hour < 3 ? 90 + uniform(n, 5) : 3 + uniform(n, 1); }, mem: () => 30 + uniform(n, 3) };
    case 'weekend-idle': {
      const c = level(30, 45);
      return {
        cpu: (i) => (sampleInfo(i).weekday < 5 ? c + uniform(n, 5) : 2 + uniform(n, 1)),
        mem: () => 40 + uniform(n, 4),
        // quiet network on weekends (added 24 Oct so the weekend-only schedule D3b can apply)
        net: (i) => (sampleInfo(i).weekday < 5 ? 12 + uniform(n, 4) : 0.4 + uniform(n, 0.2)),
      };
    }
    case 'office-hours': {
      const c = level(50, 70);
      return {
        cpu: (i) => (isBusinessSample(i) ? c + uniform(n, 10) : 2 + uniform(n, 1)),
        mem: (i) => (isBusinessSample(i) ? 55 + uniform(n, 5) : 30 + uniform(n, 3)),
        net: (i) => (isBusinessSample(i) ? 20 + uniform(n, 5) : 0.5 + uniform(n, 0.3)),
      };
    }
    case 'night-traffic': {
      // Busy by day, CPU idle at night — but a low-CPU sync/replication job keeps network traffic going.
      // Added 24 Oct so the D3 quiet-network rule ("Not scheduled: …") is visible in the demo.
      const c = level(50, 70);
      return {
        cpu: (i) => (isBusinessSample(i) ? c + uniform(n, 10) : 2 + uniform(n, 1)),
        mem: (i) => (isBusinessSample(i) ? 55 + uniform(n, 5) : 30 + uniform(n, 3)),
        net: (i) => (isBusinessSample(i) ? 20 + uniform(n, 5) : 8 + uniform(n, 2)),
      };
    }
    case 'weekend-surge':
      // Prod VM unexpectedly busier on weekends (e.g. a forgotten load test) → I5 alert. Added 24 Oct.
      return {
        cpu: (i) => (sampleInfo(i).weekday >= 5 ? 60 + uniform(n, 5) : 25 + uniform(n, 5)),
        mem: () => 45 + uniform(n, 3),
      };
    case 'idle':
      return { cpu: () => 1.5 + uniform(n, 1), mem: () => 20 + uniform(n, 2), net: () => 0.3 + uniform(n, 0.2) };
    case 'anomaly':
      // CPU AND memory jump from day 22 (memory added 24 Oct so the memory spike alert has a genuine case;
      // same number of random draws per sample, so the rest of the series is unchanged)
      return {
        cpu: (i) => (sampleInfo(i).day >= 22 ? 95 + uniform(n, 3) : 45 + uniform(n, 5)),
        mem: (i) => (sampleInfo(i).day >= 22 ? 82 + uniform(n, 4) : 50 + uniform(n, 4)),
      };
    case 'data-gap':
      return { cpu: () => 15 + uniform(n, 3), mem: () => 30 + uniform(n, 3), missing: (_i, rand) => rand() < 0.4 };
    case 'short-history':
      return { cpu: () => 10 + uniform(n, 2), mem: () => 30 + uniform(n, 2), missing: (i) => sampleInfo(i).day < DAYS - 9 };
    case 'new-this-week': {
      const c = level(45, 60);
      return { cpu: () => c + uniform(n, 6), mem: () => 55 + uniform(n, 5), missing: (i) => sampleInfo(i).day < createdDay };
    }
  }
}

function addDays(iso: string, days: number): string {
  const t = Date.parse(iso) + days * 86400000 + 5.5 * 3600000;
  return new Date(t).toISOString().slice(0, 10);
}

export interface Dataset {
  resources: Resource[];
  series: Map<string, MetricSeries>;
  /** documentation: which pattern each resource was generated with */
  patternOf: Map<string, Pattern | 'orphaned-volume' | 'attached-volume' | 'unused-ip' | 'attached-ip'>;
  seed: number;
  start: string;
}

/** Deterministic: the same seed always returns identical data. `scale` multiplies the VM count (for scale tests). */
export function generateDataset(seed = DATASET_SEED, scale = 1): Dataset {
  const pick = mulberry32(seed);
  const resources: Resource[] = [];
  const series = new Map<string, MetricSeries>();
  const patternOf: Dataset['patternOf'] = new Map();
  const vmIds: string[] = [];
  let counter = 0;
  let newVmIndex = 0;

  for (let copy = 0; copy < scale; copy++) {
    for (const env of ['prod', 'staging', 'dev'] as Env[]) {
      for (const [pattern, count] of Object.entries(MIX[env]) as [Pattern, number][]) {
        for (let j = 0; j < count; j++) {
          counter++;
          const id = `vm-${String(counter).padStart(3, '0')}`;
          const region = REGIONS[Math.floor(pick() * REGIONS.length)];
          const team = TEAMS[Math.floor(pick() * TEAMS.length)];
          const sizes = SIZES_BY_PATTERN[pattern];
          const size = sizes[Math.floor(pick() * sizes.length)];
          const createdDay = pattern === 'new-this-week' ? NEW_VM_DAYS[newVmIndex++ % NEW_VM_DAYS.length] : -200 - Math.floor(pick() * 300);
          const resource: Resource = {
            id,
            name: `${team}-${env}-${String(counter).padStart(3, '0')}`,
            type: 'vm',
            region,
            env,
            team,
            createdAt: addDays(SERIES_START, createdDay),
            vcpu: size.vcpu,
            ramGb: size.ramGb,
            diskGb: bootDiskGb(size),
            pattern,
          };
          const s = seed * 1000 + counter;
          series.set(id, makeSeries(id, s, shapeFor(pattern, mulberry32(s + 1), mulberry32(s + 2), createdDay)));
          resources.push(resource);
          patternOf.set(id, pattern);
          vmIds.push(id);
        }
      }
    }
  }

  // Dependency edges for the Dependency Shield (added 24 Oct; deterministic, no random draws).
  //  1. a prod API depends on an "idle-looking" dev VM (e.g. a licence server) → its stop is BLOCKED
  //  2. a nightly batch VM depends on an office-hours staging VM → its night schedule is BLOCKED
  //  3. two dev office-hours VMs depend on each other (a cycle) and share the same schedule → ALLOWED
  const firstOf = (p: Pattern, env?: Env, nth = 0) => resources.filter((r) => r.type === 'vm' && r.pattern === p && (!env || r.env === env))[nth];
  const link = (a: Resource | undefined, b: Resource | undefined) => {
    if (a && b) a.dependsOn = [...(a.dependsOn ?? []), b.id];
  };
  link(firstOf('healthy-busy', 'prod'), firstOf('idle', 'dev'));
  link(firstOf('batch-nightly', 'staging'), firstOf('office-hours', 'staging'));
  link(firstOf('office-hours', 'dev', 0), firstOf('office-hours', 'dev', 1));
  link(firstOf('office-hours', 'dev', 1), firstOf('office-hours', 'dev', 0));

  // ~20 block volumes per 90 VMs: 12 attached, 8 orphaned.
  for (let v = 0; v < 20 * scale; v++) {
    const orphan = v % 5 < 2;
    const owner = vmIds[Math.floor(pick() * vmIds.length)];
    const ownerRes = resources.find((r) => r.id === owner)!;
    const id = `vol-${String(v + 1).padStart(3, '0')}`;
    resources.push({
      id,
      name: `${ownerRes.team}-disk-${String(v + 1).padStart(3, '0')}`,
      type: 'volume',
      region: ownerRes.region,
      env: ownerRes.env,
      team: ownerRes.team,
      createdAt: addDays(SERIES_START, -100 - Math.floor(pick() * 200)),
      diskGb: [100, 250, 500, 1000][Math.floor(pick() * 4)],
      attachedTo: orphan ? null : owner,
      detachedDays: orphan ? 10 + Math.floor(pick() * 80) : 0,
      pattern: orphan ? 'orphaned-volume' : 'attached-volume',
    });
    patternOf.set(id, orphan ? 'orphaned-volume' : 'attached-volume');
  }

  // ~12 public IPs per 90 VMs: 8 attached, 4 unused.
  for (let p = 0; p < 12 * scale; p++) {
    const unused = p % 3 === 0;
    const owner = vmIds[Math.floor(pick() * vmIds.length)];
    const ownerRes = resources.find((r) => r.id === owner)!;
    const id = `ip-${String(p + 1).padStart(3, '0')}`;
    resources.push({
      id,
      name: `${ownerRes.team}-ip-${String(p + 1).padStart(3, '0')}`,
      type: 'ip',
      region: ownerRes.region,
      env: ownerRes.env,
      team: ownerRes.team,
      createdAt: addDays(SERIES_START, -50 - Math.floor(pick() * 200)),
      attachedTo: unused ? null : owner,
      detachedDays: unused ? 5 + Math.floor(pick() * 60) : 0,
      pattern: unused ? 'unused-ip' : 'attached-ip',
    });
    patternOf.set(id, unused ? 'unused-ip' : 'attached-ip');
  }

  return { resources, series, patternOf, seed, start: SERIES_START };
}
