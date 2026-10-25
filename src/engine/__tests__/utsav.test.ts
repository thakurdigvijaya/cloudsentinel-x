// Utsav Mode (assumptions §Z): team-declared events re-check every proposed resize.
import { describe, expect, it } from 'vitest';
import { makeSeries } from '../../data/fixtures';
import { generateDataset } from '../../data/generator';
import { analyzeAll } from '../index';
import { changeScript } from '../export';
import { applyUtsav, EVENT_PRESETS, utsavCheck, validateEvent, type PlannedEvent } from '../utsav';
import type { Resource } from '../types';

const vm = (id: string, env: Resource['env'] = 'prod'): Resource => ({
  id, name: id, type: 'vm', region: 'mumbai', env, team: 'shop', createdAt: '2025-11-01', pattern: 'test', vcpu: 8, ramGb: 32,
});
// steady 12% CPU on 8 vCPU → engine proposes a smaller size that passes today
const quiet = (id: string) => makeSeries(id, 7, { cpu: () => 12, mem: () => 30 });
const run = (r: Resource) => {
  const series = new Map([[r.id, quiet(r.id)]]);
  return { series, recs: analyzeAll([r], series).recommendations };
};
const sale = (m: number, extra: Partial<PlannedEvent> = {}): PlannedEvent => ({ id: 'sale', name: 'Festive sale', start: '2026-11-05', end: '2026-11-10', loadMultiplier: m, ...extra });

describe('Utsav check', () => {
  const r = vm('shop-api');
  const { series, recs } = run(r);
  it('baseline: the resize is eligible today', () => {
    expect(recs[0].action).toBe('resize');
    expect(recs[0].eligible).toBe(true);
  });

  it('small event load → safe through the event', () => {
    const rep = utsavCheck([r], series, recs, [sale(1.1)], '2026-10-24');
    expect(rep.results[0].status).toBe('safe-through-event');
    expect(rep.results[0].holdUntil).toBeNull();
  });

  it('big event load → hold until the day after the event, with the failing check in the message', () => {
    const rep = utsavCheck([r], series, recs, [sale(4)], '2026-10-24');
    expect(rep.results[0].status).toBe('hold-until-after');
    expect(rep.results[0].holdUntil).toBe('2026-11-11');
    expect(rep.results[0].message).toMatch(/smaller size fails: CPU/);
    expect(rep.heldSavingInr).toBeCloseTo(recs[0].monthlySavingInr, 2);
  });

  it('huge load where even the current size fails → "current also at risk" (plan extra capacity)', () => {
    const rep = utsavCheck([r], series, recs, [sale(10)], '2026-10-24');
    expect(rep.results[0].status).toBe('current-also-at-risk');
    expect(rep.results[0].message).toMatch(/even the CURRENT size fails/);
  });

  it('events already over are ignored; events only affect the declared scope (default: prod)', () => {
    expect(utsavCheck([r], series, recs, [sale(4, { start: '2026-10-01', end: '2026-10-05' })], '2026-10-24').results).toHaveLength(0);
    const dev = vm('dev-api', 'dev');
    const d = run(dev);
    expect(utsavCheck([dev], d.series, d.recs, [sale(4)], '2026-10-24').results).toHaveLength(0);
    expect(utsavCheck([dev], d.series, d.recs, [sale(4, { envs: ['dev'] })], '2026-10-24').results).toHaveLength(1);
    expect(utsavCheck([r], series, recs, [sale(4, { teams: ['other'] })], '2026-10-24').results).toHaveLength(0);
  });

  it('invalid events are refused with clear errors (no guessing)', () => {
    expect(validateEvent(sale(0.5))[0]).toMatch(/between 1 and 20/);
    expect(validateEvent({ ...sale(2), end: '2026-11-01' })[0]).toMatch(/end is before start/);
    expect(validateEvent({ ...sale(2), start: '5 Nov' })[0]).toMatch(/YYYY-MM-DD/);
    const rep = utsavCheck([r], series, recs, [sale(0)], '2026-10-24');
    expect(rep.errors.length).toBeGreaterThan(0);
    expect(rep.results).toHaveLength(0);
  });

  it('applyUtsav sets holdUntil (latest of several events), raises risk, never changes saving or verdict; script warns', () => {
    const rep = utsavCheck([r], series, recs, [sale(4), sale(4, { id: 'ipl', name: 'IPL final', start: '2026-11-20', end: '2026-11-22' })], '2026-10-24');
    const [out] = applyUtsav(recs, rep);
    expect(out.holdUntil).toBe('2026-11-23');
    expect(out.monthlySavingInr).toBe(recs[0].monthlySavingInr);
    expect(out.verdict).toBe(recs[0].verdict);
    expect(out.risk).not.toBe('low');
    expect(out.reasons[0]).toMatch(/^Utsav Mode: .* Hold until 2026-11-23\./);
    expect(changeScript([out])).toMatch(/UTSAV HOLD: do not apply before 2026-11-23/);
    expect(recs[0].holdUntil).toBeUndefined(); // pure: the input is not changed
  });

  it('the Diwali preset has the verified date and NO built-in load (the team must enter it)', () => {
    const p = EVENT_PRESETS.find((x) => x.id === 'diwali-2026')!;
    expect(p.start <= '2026-11-08' && p.end >= '2026-11-08').toBe(true);
    expect('loadMultiplier' in p).toBe(false);
  });
});

describe('On the dataset (Diwali week, prod ×2)', () => {
  it('flags the prod resizes that would not survive double load', () => {
    const d = generateDataset();
    const a = analyzeAll(d.resources, d.series);
    const rep = utsavCheck(d.resources, d.series, a.recommendations, [sale(2, { id: 'diwali', name: 'Diwali week' })], '2026-10-24');
    expect(rep.counts['hold-until-after']).toBeGreaterThan(0);
    for (const x of rep.results) expect(d.resources.find((r) => r.id === x.resourceId)!.env).toBe('prod');
  });
});
