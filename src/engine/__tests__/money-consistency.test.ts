// Test 25 — every rupee reconciles across the app, plus Challenge Lab PREVIEW MODE.
import { describe, expect, it } from 'vitest';
import { buildFixtures } from '../../data/fixtures';
import { analyzeAll } from '../index';
import { adoptPlanningAssumptions, aggregate, approve, reject, type Decisions } from '../decisions';
import { resourceMonthlyCost, vmMonthlyCost } from '../pricing';
import { previewRecommendation, revalidate } from '../scenarios';

const { resources, series } = buildFixtures();
const { recommendations } = analyzeAll(resources, series);
const byId = (id: string) => recommendations.find((r) => r.resourceId === id)!;
const res = (id: string) => resources.find((r) => r.id === id)!;
const AT = '2026-10-24T10:00:00Z';

const approveAll = (ids: string[]): Decisions =>
  ids.reduce<Decisions>((d, id) => approve(d, byId(id), AT).decisions, {});

describe('25.1 candidate savings equal the documented formulas', () => {
  it('candidate total = sum of each proposed saving', () => {
    const t = aggregate(resources, recommendations, {});
    const sum = recommendations.filter((r) => r.action !== 'none').reduce((a, r) => a + r.monthlySavingInr, 0);
    expect(t.candidateInr).toBeCloseTo(sum, 2);
  });
});

describe('25.2 FAIL / INSUFFICIENT recommendations are excluded from eligible totals', () => {
  it('eligible = PASS only, and blocked ones cannot be approved', () => {
    const t = aggregate(resources, recommendations, {});
    const passOnly = recommendations.filter((r) => r.verdict === 'PASS_UNDER_TESTED_CONDITIONS').reduce((a, r) => a + r.monthlySavingInr, 0);
    expect(t.eligibleInr).toBeCloseTo(passOnly, 2);
    expect(t.eligibleInr).toBeLessThan(t.candidateInr);
    for (const id of ['vm-prod-bursty', 'vm-prod-memheavy', 'vm-stg-gappy', 'vm-dev-newbie']) {
      expect(approve({}, byId(id), AT).ok).toBe(false);
    }
  });
});

describe('25.3 approval changes the projected bill by exactly the approved saving', () => {
  it('projected = original − approved', () => {
    const d = approveAll(['vm-dev-idle', 'vol-orphan']);
    const t = aggregate(resources, recommendations, d);
    expect(t.approvedInr).toBeCloseTo(byId('vm-dev-idle').monthlySavingInr + byId('vol-orphan').monthlySavingInr, 2);
    expect(t.projectedInr).toBeCloseTo(t.originalInr - t.approvedInr, 2);
  });
});

describe('25.4 conflicting actions on one resource are counted once', () => {
  it('a second recommendation for the same resource is refused', () => {
    const dup = { ...byId('vm-stg-conflict'), id: 'rec-duplicate' };
    expect(() => aggregate(resources, [...recommendations, dup], {})).toThrow(/Double counting/);
  });
});

describe('25.5 per-resource, per-environment and global totals reconcile', () => {
  it('sums match at every level', () => {
    const d = approveAll(['vm-dev-underutil', 'vm-stg-conflict', 'ip-unused']);
    const t = aggregate(resources, recommendations, d);
    for (const key of ['originalInr', 'candidateInr', 'eligibleInr', 'approvedInr', 'projectedInr'] as const) {
      const envSum = t.byEnv.prod[key] + t.byEnv.staging[key] + t.byEnv.dev[key];
      const resSum = Object.values(t.byResource).reduce((a, b) => a + b[key], 0);
      const regionSum = t.byRegion.noida[key] + t.byRegion.bengaluru[key] + t.byRegion.mumbai[key];
      expect(envSum).toBeCloseTo(t[key], 1);
      expect(regionSum).toBeCloseTo(t[key], 1);
      expect(resSum).toBeCloseTo(t[key], 1);
    }
    expect(t.originalInr).toBeCloseTo(resources.reduce((a, r) => a + resourceMonthlyCost(r), 0), 2);
  });
});

describe('25.6 rejecting removes the amount from approved totals', () => {
  it('approve two, reject one', () => {
    const d = approveAll(['vm-dev-idle', 'vm-dev-officehours']);
    const r = reject(d, byId('vm-dev-idle'), AT, 'team still uses it on Fridays');
    const t = aggregate(resources, recommendations, r.decisions);
    expect(t.approvedInr).toBeCloseTo(byId('vm-dev-officehours').monthlySavingInr, 2);
  });
});

describe('25.7 Challenge Lab: preview never changes approvals; adopting flags them for review', () => {
  const rec = byId('vm-dev-underutil');
  const decisions = approveAll(['vm-dev-underutil']);
  const before = aggregate(resources, recommendations, decisions);

  it('PREVIEW: +60% shows FAIL but approvals and totals are unchanged', () => {
    const p = previewRecommendation(res('vm-dev-underutil'), series.get('vm-dev-underutil')!, rec, 'traffic60');
    expect(p.preview).toBe(true);
    expect(p.verdict).toBe('FAIL_SAFETY_CHECKS');
    expect(p.eligible).toBe(false);
    const after = aggregate(resources, recommendations, decisions);
    expect(after).toEqual(before);
    expect(decisions['rec-vm-dev-underutil'].status).toBe('approved');
  });

  it('ADOPT: approval flagged needs-review and removed from approved savings', () => {
    const p = previewRecommendation(res('vm-dev-underutil'), series.get('vm-dev-underutil')!, rec, 'traffic60');
    const adopted = adoptPlanningAssumptions(recommendations, decisions, [revalidate(rec, p)], AT);
    expect(adopted.flagged).toEqual(['rec-vm-dev-underutil']);
    expect(adopted.decisions['rec-vm-dev-underutil'].status).toBe('needs-review');
    const t = aggregate(resources, adopted.recommendations, adopted.decisions);
    expect(t.approvedInr).toBe(0);
    expect(t.needsReview).toEqual(['rec-vm-dev-underutil']);
    // eligibility is consistent everywhere: the revalidated rec is no longer eligible
    expect(adopted.recommendations.find((r) => r.id === rec.id)!.eligible).toBe(false);
  });
});

describe('25.8 every displayed cost follows assumptions.md pricing', () => {
  it('current/proposed costs match the price formula', () => {
    for (const r of recommendations) {
      const resource = res(r.resourceId);
      expect(r.current.monthlyCostInr).toBeCloseTo(resourceMonthlyCost(resource), 2);
      if (r.action === 'resize') {
        expect(r.proposed.monthlyCostInr).toBeCloseTo(vmMonthlyCost(r.proposed.size!, r.region), 2);
        expect(r.monthlySavingInr).toBeCloseTo(r.current.monthlyCostInr - r.proposed.monthlyCostInr, 2);
      }
    }
  });
});
