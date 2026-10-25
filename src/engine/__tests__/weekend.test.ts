// D3b weekend-only schedule (REQUIREMENTS.md G2; brief: "dev environments idle on weekends").
import { describe, expect, it } from 'vitest';
import { makeSeries, type Shape } from '../../data/fixtures';
import { generateDataset } from '../../data/generator';
import { analyzeAll } from '../index';
import { offHoursFraction, weekendFraction } from '../config';
import { approve, aggregate } from '../decisions';
import { savingFor } from '../plan';
import { vmMonthlyCost } from '../pricing';
import { isBusinessSample, sampleInfo } from '../time';
import type { Resource } from '../types';

const weekday = (i: number) => sampleInfo(i).weekday < 5;
const vm = (id: string, size = { vcpu: 4, ramGb: 16 }, env: Resource['env'] = 'dev'): Resource => ({
  id, name: id, type: 'vm', region: 'mumbai', env, team: 't', createdAt: '2025-11-01', pattern: 'test', ...size,
});
const run = (res: Resource, shape: Shape) =>
  analyzeAll([res], new Map([[res.id, makeSeries(res.id, 9, shape)]])).recommendations[0];

// Busy all weekday (day and night), idle on Saturday and Sunday.
const weekendIdle = (wkNet: number): Shape => ({
  cpu: (i) => (weekday(i) ? 40 : 2),
  mem: () => 60,
  net: (i) => (weekday(i) ? 12 : wkNet),
});

describe('A3b weekend fraction', () => {
  it('= (730 − 24 × 21.7) / 730 ≈ 0.2866, smaller than nights+weekends', () => {
    expect(weekendFraction()).toBeCloseTo(209.2 / 730, 10);
    expect(weekendFraction()).toBeLessThan(offHoursFraction());
  });
});

describe('D3b weekend-only schedule', () => {
  it('busy weeknights + quiet weekends → schedule on weekends, saving = cost × weekend fraction', () => {
    const r = run(vm('w'), weekendIdle(0.4));
    expect(r.action).toBe('schedule');
    expect(r.scheduleWindow).toBe('weekends');
    const cost = vmMonthlyCost({ vcpu: 4, ramGb: 16 }, 'mumbai');
    expect(r.monthlySavingInr).toBeCloseTo(cost * weekendFraction(), 1);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].offFraction).toBeCloseTo(weekendFraction(), 10);
    expect(r.steps[0].label).toBe('Schedule weekends');
    expect(r.reasons.join(' ')).toMatch(/Saturday 00:00 to Monday 00:00/);
    expect(r.savingFormula).toContain(weekendFraction().toFixed(4));
    expect(r.assumptionIds).toContain('D3b');
    expect(r.requiresHumanReview).toBe(true);
  });

  it('weekend network busy → not scheduled, with a weekend-specific reason', () => {
    const r = run(vm('wn'), weekendIdle(6));
    expect(r.action).not.toMatch(/schedule/);
    expect(r.reasons.join(' ')).toMatch(/Not scheduled for weekends: CPU is idle on weekends but network traffic continues/);
  });

  it('quiet every night as well → the bigger nights-and-weekends schedule wins (no weekend-only plan)', () => {
    const r = run(vm('n'), {
      cpu: (i) => (isBusinessSample(i) ? 40 : 2), mem: () => 60, net: (i) => (isBusinessSample(i) ? 12 : 0.4),
    });
    expect(r.action).toBe('schedule');
    expect(r.scheduleWindow).toBe('nights-and-weekends');
    expect(r.steps[0].offFraction).toBeCloseTo(offHoursFraction(), 10);
  });

  it('prod is never scheduled for weekends', () => {
    const r = run(vm('p', { vcpu: 4, ramGb: 16 }, 'prod'), weekendIdle(0.4));
    expect(r.action).not.toMatch(/schedule/);
  });

  it('oversized + weekend idle → resize then weekend schedule, costed sequentially (never the sum)', () => {
    const big = { vcpu: 8, ramGb: 32 };
    const r = run(vm('big', big), { cpu: (i) => (weekday(i) ? 15 : 2), mem: () => 30, net: (i) => (weekday(i) ? 12 : 0.4) });
    expect(r.action).toBe('resize+schedule');
    expect(r.scheduleWindow).toBe('weekends');
    const current = vmMonthlyCost(big, 'mumbai');
    const resized = vmMonthlyCost(r.proposed.size!, 'mumbai');
    const w = weekendFraction();
    expect(savingFor(r, ['resize', 'schedule'])).toBeCloseTo(current - resized * (1 - w), 1);
    expect(savingFor(r, ['schedule'])).toBeCloseTo(current * w, 1);
    expect(r.monthlySavingInr).toBeCloseTo(current - resized * (1 - w), 1);
    // partial approval of the weekend schedule only flows into totals with the weekend fraction
    const res = vm('big', big);
    const d = approve({}, r, '2026-10-24T10:00:00Z', ['schedule']).decisions;
    expect(aggregate([res], [r], d).approvedInr).toBeCloseTo(current * w, 1);
  });
});

describe('Full dataset: weekend-idle VMs now get a weekend schedule', () => {
  const d = generateDataset();
  const recs = analyzeAll(d.resources, d.series).recommendations.filter((r) => d.patternOf.get(r.resourceId) === 'weekend-idle');
  it('every weekend-idle VM has a PASS weekend schedule (alone or after a resize)', () => {
    expect(recs).toHaveLength(8);
    for (const r of recs) {
      expect(['schedule', 'resize+schedule']).toContain(r.action);
      expect(r.scheduleWindow).toBe('weekends');
      expect(r.verdict).toBe('PASS_UNDER_TESTED_CONDITIONS');
    }
  });
});
