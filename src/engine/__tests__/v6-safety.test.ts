// V6 safety contract (team decision 24 Oct): implausible telemetry is not evidence (E9),
// and a demonstrated capacity failure is shown as FAIL even when evidence is also incomplete.
import { describe, expect, it } from 'vitest';
import { buildFixtures, makeSeries, type Shape } from '../../data/fixtures';
import { generateDataset } from '../../data/generator';
import { analyzeAll } from '../index';
import { CONFIG } from '../config';
import { breakPoint, safeAlternative } from '../challenge';
import { dataChecks, evaluateSize, implausibleFraction } from '../foresight';
import type { Resource } from '../types';

const N = 2880;
const flat = (v: number | null) => new Array<number | null>(N).fill(v);
const vm = (id: string, env: Resource['env'] = 'dev'): Resource => ({
  id, name: id, type: 'vm', region: 'mumbai', env, team: 't', createdAt: '2025-11-01', pattern: 'test', vcpu: 4, ramGb: 16,
});
const run = (id: string, shape: Shape, env: Resource['env'] = 'dev') =>
  analyzeAll([vm(id, env)], new Map([[id, makeSeries(id, 5, shape)]]));

describe('E9 — dead monitoring agent (0% memory) is not evidence of idleness', () => {
  it('all-zero telemetry → stop is NOT eligible: INSUFFICIENT, E9 failed, data alert raised', () => {
    const a = run('dead', { cpu: () => 0, mem: () => 0, net: () => 0 });
    const r = a.recommendations[0];
    expect(r.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(r.eligible).toBe(false);
    expect(r.checks.find((c) => c.id === 'E9')!.passed).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/monitoring agent may be broken/);
    expect(a.alerts.some((x) => x.type === 'insufficient-data' && /0% memory/.test(x.why))).toBe(true);
  });

  it('a genuinely idle VM (low but non-zero memory) is still eligible to stop', () => {
    const r = run('idle', { cpu: () => 1.5, mem: () => 20, net: () => 0.3 }).recommendations[0];
    expect(r.action).toBe('stop');
    expect(r.verdict).toBe('PASS_UNDER_TESTED_CONDITIONS');
    expect(r.checks.find((c) => c.id === 'E9')!.passed).toBe(true);
  });

  it('boundary: 1% zero samples passes, just above 1% fails', () => {
    const at = (zeros: number) => {
      const mem = flat(30);
      for (let i = 0; i < zeros; i++) mem[i * 50] = 0;
      return dataChecks({ cpuPct: flat(10), memPct: mem }, 'dev').checks.find((c) => c.id === 'E9')!.passed;
    };
    expect(at(28)).toBe(true); // 28 / 2880 = 0.97%
    expect(at(29)).toBe(false); // 1.007%
  });

  it('missing samples (null) are not counted as zero readings', () => {
    const mem = flat(null);
    for (let i = 0; i < N; i += 2) mem[i] = 25;
    expect(implausibleFraction(mem)).toBe(0);
    expect(implausibleFraction(flat(null))).toBe(0);
  });

  it('no false alarms: every fixture and every dataset VM passes E9', () => {
    for (const d of [buildFixtures(), generateDataset()]) {
      for (const r of analyzeAll(d.resources, d.series).recommendations) {
        const e9 = r.checks.find((c) => c.id === 'E9');
        if (e9) expect(e9.passed).toBe(true);
      }
    }
  });
});

describe('FAIL wins over INSUFFICIENT; the missing-evidence flags are kept', () => {
  // 8 vCPU → 2 vCPU (×4): CPU 30% → 120% projected, so capacity fails. Only half of the samples exist.
  const halfMissing = (v: number) => flat(v).map((x, i) => (i % 2 === 0 ? x : null));
  const thin = { cpuPct: halfMissing(30), memPct: halfMissing(20) };
  const big = { vcpu: 8, ramGb: 32 };
  const small = { vcpu: 2, ramGb: 8 };

  it('capacity failure + 50% coverage → FAIL with both kinds of reason', () => {
    const e = evaluateSize(thin, big, small, 'dev');
    expect(e.verdict).toBe('FAIL_SAFETY_CHECKS');
    expect(e.checks.find((c) => c.id === 'E5')!.passed).toBe(false);
    expect(e.checks.find((c) => c.id === 'E3')!.passed).toBe(false);
    expect(e.reasons.join(' ')).toMatch(/CPU max/);
    expect(e.reasons.join(' ')).toMatch(/Evidence is also incomplete: Only 50% of expected samples/);
  });

  it('same thin data on a size that fits → INSUFFICIENT (never PASS)', () => {
    const e = evaluateSize(thin, big, { vcpu: 8, ramGb: 16 }, 'dev');
    expect(e.verdict).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('challenge tools agree: break point says already failing, Safe Alternative says current-also-fails on thin failing data', () => {
    expect(breakPoint(thin, big, small, 'dev').kind).toBe('already-failing');
    const heavy = { cpuPct: halfMissing(95), memPct: halfMissing(20) }; // current 8 vCPU passes E3 but fails E1/E2
    expect(safeAlternative(heavy, big, small, 'dev', 'mumbai').kind).toBe('current-also-fails');
  });

  it('the limit used for E9 is the documented one', () => {
    expect(CONFIG.foresight.maxImplausibleFraction).toBe(0.01);
  });
});
