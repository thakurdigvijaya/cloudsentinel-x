// Bill Explainer and role briefs (assumptions §V): "where did the money go?"
import { describe, expect, it } from 'vitest';
import { generateDataset } from '../../data/generator';
import { buildFixtures } from '../../data/fixtures';
import { aggregate, analyzeAll } from '../index';
import { explainBill, roleBrief } from '../explain';

const d = generateDataset();
const a = analyzeAll(d.resources, d.series);
const totals = aggregate(d.resources, a.recommendations, {});
const bill = explainBill(d.resources, a.recommendations, d.start, 30);

describe('Bill Explainer reconciles with the engine totals', () => {
  it('monthly bill = aggregate original', () => {
    expect(bill.monthlyBillInr).toBeCloseTo(totals.originalInr, 1);
  });
  it('waste categories add up EXACTLY to eligible savings (no double counting of resize+schedule)', () => {
    const sum = bill.waste.reduce((x, w) => x + w.eligibleInr, 0);
    expect(sum).toBeCloseTo(totals.eligibleInr, 1);
    expect(bill.wasteEligibleInr).toBeCloseTo(totals.eligibleInr, 1);
  });
  it('not-claimed = candidate − eligible, and it is reported, not hidden', () => {
    expect(bill.notClaimedInr).toBeCloseTo(totals.candidateInr - totals.eligibleInr, 1);
    expect(bill.headlines[1]).toMatch(/is NOT claimed/);
  });
  it('every waste category is present on the dataset, sorted largest first', () => {
    expect(new Set(bill.waste.map((w) => w.category))).toEqual(new Set(['idle-vm', 'oversized', 'off-hours', 'orphaned-volume', 'unused-ip']));
    for (let i = 1; i < bill.waste.length; i++) expect(bill.waste[i - 1].eligibleInr).toBeGreaterThanOrEqual(bill.waste[i].eligibleInr);
  });
});

describe('Why the bill grew', () => {
  it('week totals match the spend alert window and the growth rows add up', () => {
    expect(bill.growth.pct).toBeGreaterThan(15); // same window as alert I2
    const teamDelta = bill.growth.byTeam.reduce((x, r) => x + r.deltaInr, 0);
    const envDelta = bill.growth.byEnv.reduce((x, r) => x + r.deltaInr, 0);
    expect(teamDelta).toBeCloseTo(bill.growth.lastWeekInr - bill.growth.firstWeekInr, 0);
    expect(envDelta).toBeCloseTo(teamDelta, 0);
  });
  it('names the new resources (most expensive first) and their share of the increase', () => {
    const n = bill.growth.newResources;
    expect(n.length).toBeGreaterThan(0);
    for (let i = 1; i < n.length; i++) expect(n[i - 1].monthlyInr).toBeGreaterThanOrEqual(n[i].monthlyInr);
    expect(bill.growth.newResourcesShareOfIncreasePct).toBeGreaterThan(0);
    expect(bill.headlines[2]).toMatch(/newly created resources/);
  });
  it('flat inventory (fixtures) → says spend did not rise', () => {
    const f = buildFixtures();
    const fb = explainBill(f.resources, analyzeAll(f.resources, f.series).recommendations, f.series.values().next().value!.start, 30);
    expect(fb.growth.pct).toBe(0);
    expect(fb.headlines[2]).toMatch(/did not rise/);
  });
});

describe('Role briefs: same numbers, different audiences', () => {
  const brief = (r: 'engineer' | 'finance' | 'leadership') => roleBrief(r, { recs: a.recommendations, totals, bill, alerts: a.alerts });
  it('engineer: the top saving actions and the count of blocked resizes', () => {
    const b = brief('engineer');
    const blocked = a.recommendations.filter((r) => r.action.includes('resize') && r.verdict === 'FAIL_SAFETY_CHECKS').length;
    expect(b.points.join(' ')).toContain(`${blocked} resizes were blocked`);
    expect(b.points.length).toBeGreaterThanOrEqual(3);
  });
  it('finance: before/after with the projection disclaimer', () => {
    const b = brief('finance').points.join(' ');
    expect(b).toContain(`₹${Math.round(totals.eligibleInr).toLocaleString('en-IN')}`);
    expect(b).toMatch(/not realised savings/);
  });
  it('leadership: exactly three answers, including what we will NOT do', () => {
    const b = brief('leadership');
    expect(b.points).toHaveLength(3);
    expect(b.points[2]).toMatch(/held back/);
  });
});
