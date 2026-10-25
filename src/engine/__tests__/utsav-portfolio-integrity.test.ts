import { describe, expect, it } from 'vitest';
import { buildFixtures } from '../../data/fixtures';
import { analyzeAll } from '../index';
import { savingFor } from '../plan';
import { portfolioCandidates, buildPortfolio } from '../portfolio';

const d = buildFixtures();
const recs = analyzeAll(d.resources, d.series).recommendations;
const multi = recs.find((r) => r.resourceId === 'vm-stg-conflict')!;

describe('Event-held multi-step finance', () => {
  it('keeps an unaffected schedule available now while deferring the resize', () => {
    expect(multi.action).toBe('resize+schedule');
    const planned = { ...multi, holdUntil: '2026-11-11' };
    const now = portfolioCandidates([planned]);
    expect(now).toHaveLength(1);
    expect(now[0].steps).toEqual(['schedule']);
    expect(now[0].savingInr).toBeCloseTo(savingFor(multi, ['schedule']), 2);
    expect(now[0].savingInr).toBeLessThan(savingFor(multi, ['resize', 'schedule']));
    const plan = buildPortfolio([planned], 1000);
    expect(plan.choice.savingInr).toBeCloseTo(now[0].savingInr, 2);
  });
  it('does not offer a held resize-only plan as immediately actionable', () => {
    const r = recs.find((x) => x.resourceId === 'vm-dev-underutil')!;
    expect(r.action).toBe('resize');
    expect(portfolioCandidates([{ ...r, holdUntil: '2026-11-11' }])).toHaveLength(0);
  });
  it('preserves baseline eligible amounts when no upcoming event exists', () => {
    const result=buildPortfolio(recs, 999999);
    expect(result.choice.savingInr).toBeGreaterThan(0);
  });
});
