// Regression tests for the code-review findings of 24 Oct (ChatGPT review of the P1 engine milestone).
import { describe, expect, it } from 'vitest';
import { buildFixtures, makeSeries, type Shape } from '../../data/fixtures';
import { analyzeAll } from '../index';
import { CONFIG, limitsFor } from '../config';
import { isBusinessSample } from '../time';
import type { Resource } from '../types';
import { safeAlternative } from '../challenge';
import { evaluateSize, type UsageInput } from '../foresight';
import { buildPassport, passportToMarkdown } from '../passport';
import { SHUTDOWN_ASSUMPTION } from '../recommend';
import { applyScenario } from '../scenarios';

const { resources, series } = buildFixtures();
const { recommendations } = analyzeAll(resources, series);
const rec = (id: string) => recommendations.find((r) => r.resourceId === id)!;
const res = (id: string) => resources.find((r) => r.id === id)!;
const N = 2880;
const flat = (v: number) => new Array<number | null>(N).fill(v);

// 25 Oct revised safety policy: all projected CPU maxima must fit at or below 100%,
// and memory maxima must preserve a 2% instantaneous reserve.
describe('Conservative CPU max: no environment may exceed 100%' , () => {
  it('limits per environment', () => {
    expect(limitsFor('prod').cpuMax).toBe(100);
    expect(limitsFor('staging').cpuMax).toBe(100);
    expect(limitsFor('dev').cpuMax).toBe(100);
  });

  it('a rare projected peak far above capacity FAILS even when p95 and p99 are fine', () => {
    // 8 vCPU VM, CPU 10% except 10 samples (0.35% of the month, below the 1% that p99 ignores) at 60%.
    const cpu = flat(10);
    for (let i = 0; i < 10; i++) cpu[1000 + i * 96] = 60;
    const usage: UsageInput = { cpuPct: cpu, memPct: flat(20) };
    const e = evaluateSize(usage, { vcpu: 8, ramGb: 32 }, { vcpu: 2, ramGb: 8 }, 'dev'); // ×4 → p99 40%, max 240%
    const by = (id: string) => e.checks.find((c) => c.id === id)!;
    expect(by('E1').passed).toBe(true);
    expect(by('E2').passed).toBe(true);
    expect(by('E3').actual).toBeCloseTo(240, 6);
    expect(by('E3').passed).toBe(false);
    expect(e.verdict).toBe('FAIL_SAFETY_CHECKS');
    expect(e.reasons.join(' ')).toMatch(/CPU max/);
  });

  const peak = (v: number) => {
    const cpu = flat(10);
    cpu[500] = v;
    return { cpuPct: cpu, memPct: flat(20) };
  };
  const big = { vcpu: 8, ramGb: 32 };
  const small = { vcpu: 2, ramGb: 8 }; // ×4

  it('a brief 104% peak fails E3 in staging and prod', () => {
    expect(evaluateSize(peak(26), big, small, 'staging').checks.find((c) => c.id === 'E3')!.passed).toBe(false);
    expect(evaluateSize(peak(26), big, small, 'prod').checks.find((c) => c.id === 'E3')!.passed).toBe(false);
  });

  it('boundary: exactly 100% passes E3; 104% fails', () => {
    expect(evaluateSize(peak(25), big, small, 'staging').checks.find((c) => c.id === 'E3')!.passed).toBe(true);
    expect(evaluateSize(peak(26), big, small, 'staging').checks.find((c) => c.id === 'E3')!.passed).toBe(false);
  });
});

describe('Conservative E8 memory max is 98%; E4 preserves p99 headroom', () => {
  // 32 GB VM → 16 GB target doubles memory %.
  const big = { vcpu: 8, ramGb: 32 };
  const half = { vcpu: 8, ramGb: 16 };
  const oneSpike = (base: number, spike: number) => {
    const mem = flat(base);
    mem[700] = spike;
    return { cpuPct: flat(10), memPct: mem };
  };

  it('E8 limit is 98% in every environment', () => {
    expect(limitsFor('prod').memMax).toBe(98);
    expect(limitsFor('dev').memMax).toBe(98);
  });

  it('a single 92% projected peak passes E8 in prod (RAM still fits)', () => {
    const e = evaluateSize(oneSpike(30, 46), big, half, 'prod');
    expect(e.checks.find((c) => c.id === 'E8')!.passed).toBe(true);
  });

  it('a single projected peak above 98% (reserve exhausted) FAILS', () => {
    const e = evaluateSize(oneSpike(30, 51), big, half, 'staging'); // ×2 → 102%
    expect(e.checks.find((c) => c.id === 'E8')!.passed).toBe(false);
    expect(e.verdict).toBe('FAIL_SAFETY_CHECKS');
    expect(e.reasons.join(' ')).toMatch(/Memory max/);
  });

  it('sustained high memory without any over-100% sample is still blocked by E4 (headroom)', () => {
    const e = evaluateSize({ cpuPct: flat(10), memPct: flat(45) }, big, half, 'prod'); // ×2 → 90% everywhere
    expect(e.checks.find((c) => c.id === 'E8')!.passed).toBe(true);
    expect(e.checks.find((c) => c.id === 'E4')!.passed).toBe(false);
    expect(e.verdict).toBe('FAIL_SAFETY_CHECKS');
  });
});

describe('Finding 3 — "confidence" renamed to Data Adequacy Score', () => {
  it('recommendations expose dataAdequacyScore and no "confidence" field', () => {
    for (const r of recommendations) {
      expect(r).toHaveProperty('dataAdequacyScore');
      expect(r).not.toHaveProperty('confidence');
      expect(r.dataAdequacyScore).toBeGreaterThanOrEqual(0);
      expect(r.dataAdequacyScore).toBeLessThanOrEqual(1);
    }
  });
  it('the passport says it is not a probability of safety', () => {
    const md = passportToMarkdown(buildPassport(res('vm-dev-underutil'), series.get('vm-dev-underutil'), rec('vm-dev-underutil')));
    expect(md).toContain('Data adequacy score');
    expect(md).toContain('not a probability of safety');
    expect(md).not.toMatch(/Confidence/);
  });
});

describe('Finding 4 — shutdown assumptions are explicit and need a human', () => {
  it('every stop / schedule / resize+schedule requires human review and states the dependency assumption', () => {
    const shutdowns = recommendations.filter((r) => ['stop', 'schedule', 'resize+schedule'].includes(r.action));
    expect(shutdowns.length).toBeGreaterThanOrEqual(3);
    for (const r of shutdowns) {
      expect(r.requiresHumanReview).toBe(true);
      expect(r.reasons).toContain(SHUTDOWN_ASSUMPTION);
    }
  });
  it('scheduled VMs are quiet on the network off-hours too', () => {
    for (const id of ['vm-dev-officehours', 'vm-stg-conflict']) {
      expect(rec(id).evidence.offHoursNetP95Mbps!).toBeLessThan(CONFIG.detection.offHoursNetP95Mbps);
      expect(rec(id).reasons.join(' ')).not.toMatch(/Not scheduled/);
    }
  });
  it('saving amounts of the fixture schedules are unchanged', () => {
    expect(rec('vm-stg-conflict').monthlySavingInr).toBeCloseTo(9334, 0);
    expect(rec('vm-dev-officehours').monthlySavingInr).toBeCloseTo(2591.16, 1);
  });
});

describe('Finding 4 (team decision) — D3: no schedule while off-hours network is busy', () => {
  // Same CPU shape (busy by day, idle at night); only the night-time network differs.
  const nightNet = (night: number) => (i: number) => (isBusinessSample(i) ? 15 : night);
  const officeCpu = (i: number) => (isBusinessSample(i) ? 55 : 2);
  const vmOf = (id: string, size: { vcpu: number; ramGb: number }): Resource => ({
    id, name: id, type: 'vm', region: 'mumbai', env: 'dev', team: 't', createdAt: '2025-11-01', pattern: 'test', ...size,
  });
  const run = (id: string, size: { vcpu: number; ramGb: number }, shape: Shape) =>
    analyzeAll([vmOf(id, size)], new Map([[id, makeSeries(id, 77, shape)]])).recommendations[0];

  it('quiet night network (0.5 Mbps) → schedule', () => {
    const r = run('quiet', { vcpu: 4, ramGb: 16 }, { cpu: officeCpu, mem: () => 60, net: nightNet(0.5) });
    expect(r.action).toBe('schedule');
  });

  it('busy night network (8 Mbps) → NOT scheduled, no saving, reason says why', () => {
    const r = run('busy', { vcpu: 4, ramGb: 16 }, { cpu: officeCpu, mem: () => 60, net: nightNet(8) });
    expect(r.action).toBe('none');
    expect(r.monthlySavingInr).toBe(0);
    expect(r.reasons.join(' ')).toMatch(/Not scheduled: CPU is idle off-hours but network traffic continues \(p95 8\.0 Mbps/);
  });

  it('boundary: night network exactly at the 1 Mbps limit is blocked; just below is allowed', () => {
    expect(run('at', { vcpu: 4, ramGb: 16 }, { cpu: officeCpu, mem: () => 60, net: nightNet(1) }).action).toBe('none');
    expect(run('below', { vcpu: 4, ramGb: 16 }, { cpu: officeCpu, mem: () => 60, net: nightNet(0.99) }).action).toBe('schedule');
  });

  it('oversized + idle CPU at night but busy network → resize only (no schedule step), with the reason', () => {
    const r = run('big', { vcpu: 8, ramGb: 32 }, { cpu: (i) => (isBusinessSample(i) ? 18 : 2), mem: () => 30, net: nightNet(8) });
    expect(r.action).toBe('resize');
    expect(r.steps.map((s) => s.action)).toEqual(['resize']);
    expect(r.reasons.join(' ')).toMatch(/Not scheduled/);
  });

  it('prod is never scheduled, and gets no "Not scheduled" note', () => {
    const id = 'p';
    const res: Resource = { ...vmOf(id, { vcpu: 4, ramGb: 16 }), env: 'prod' };
    const r = analyzeAll([res], new Map([[id, makeSeries(id, 77, { cpu: officeCpu, mem: () => 60, net: nightNet(8) })]])).recommendations[0];
    expect(r.action).not.toMatch(/schedule/);
    expect(r.reasons.join(' ')).not.toMatch(/Not scheduled/);
  });
});

describe('Finding 5 — Safe Alternative distinguishes its "no" answers', () => {
  it('keep-current: no cheaper safe size, current passes', () => {
    const id = 'vm-prod-bursty';
    const alt = safeAlternative(series.get(id)!, { vcpu: 8, ramGb: 32 }, { vcpu: 4, ramGb: 16 }, 'prod', 'mumbai');
    expect(alt.kind).toBe('keep-current');
  });
  it('current-also-fails: under a CPU burst the current size fails too — says a larger size may be needed', () => {
    const id = 'vm-prod-bursty';
    const usage = applyScenario(series.get(id)!, 'cpuBurst'); // 2 × p99 ≈ 144% on the current size
    const alt = safeAlternative(usage, { vcpu: 8, ramGb: 32 }, { vcpu: 4, ramGb: 16 }, 'prod', 'mumbai');
    expect(alt.kind).toBe('current-also-fails');
    expect(alt.message).toMatch(/larger size may be needed/);
    expect(alt.message).not.toMatch(/No supported alternative|no safe configuration exists/i);
  });
  it('insufficient-evidence: data too thin to judge any size', () => {
    const id = 'vm-stg-gappy';
    const alt = safeAlternative(series.get(id)!, { vcpu: 8, ramGb: 32 }, { vcpu: 4, ramGb: 16 }, 'staging', 'bengaluru');
    expect(alt.kind).toBe('insufficient-evidence');
  });
  it('found: a cheaper size that passes', () => {
    const alt = safeAlternative(series.get('vm-dev-underutil')!, { vcpu: 8, ramGb: 32 }, { vcpu: 1, ramGb: 2 }, 'dev', 'bengaluru');
    expect(alt.kind).toBe('found');
  });
});
