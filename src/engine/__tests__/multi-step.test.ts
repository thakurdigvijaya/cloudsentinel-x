// Review point 3 (ChatGPT): no double counting when one resource has more than one change.
// Fixed order: remove → resize → schedule; partial acceptance recomputed from scratch.
import { describe, expect, it } from 'vitest';
import { buildFixtures } from '../../data/fixtures';
import { analyzeAll } from '../index';
import { adoptPlanningAssumptions, aggregate, approve, approvedSaving, reject } from '../decisions';
import { previewRecommendation, revalidate } from '../scenarios';
import type { ScenarioId } from '../types';
import { offHoursFraction } from '../config';
import { projectedCost, savingFor } from '../plan';
import { vmMonthlyCost } from '../pricing';

const { resources, series } = buildFixtures();
const { recommendations } = analyzeAll(resources, series);
const conflict = recommendations.find((r) => r.resourceId === 'vm-stg-conflict')!;
const AT = '2026-10-24T10:00:00Z';
const current = 11360; // 8 vCPU / 32 GB, Mumbai
const resized = vmMonthlyCost({ vcpu: 4, ramGb: 16 }, 'mumbai'); // 5680
const on = 1 - offHoursFraction(); // ≈ 0.3567

describe('Multi-step plan: resize + schedule on one VM', () => {
  it('breakdown steps are ordered and add up exactly to the combined saving', () => {
    expect(conflict.steps.map((s) => s.action)).toEqual(['resize', 'schedule']);
    const sum = conflict.steps.reduce((a, s) => a + s.marginalSavingInr, 0);
    expect(sum).toBeCloseTo(conflict.monthlySavingInr, 1);
    expect(conflict.steps[0].costAfterInr).toBe(resized);
    expect(conflict.steps[1].costAfterInr).toBeCloseTo(resized * on, 1);
  });

  it('accept only resize → saving = current − new plan price', () => {
    expect(savingFor(conflict, ['resize'])).toBeCloseTo(current - resized, 2);
  });

  it('accept only schedule → saving = current × off-hours fraction (on the ORIGINAL size)', () => {
    expect(savingFor(conflict, ['schedule'])).toBeCloseTo(current * offHoursFraction(), 1);
  });

  it('accept both → sequential: current − new price × on-hours, NOT the sum of the two', () => {
    const both = savingFor(conflict, ['resize', 'schedule']);
    expect(both).toBeCloseTo(current - resized * on, 1);
    const naiveSum = savingFor(conflict, ['resize']) + savingFor(conflict, ['schedule']);
    expect(both).toBeLessThan(naiveSum);
    expect(naiveSum).toBeGreaterThan(current * 0.99); // the naive sum is (almost) the whole bill — impossible in reality
    expect(both).toBeLessThan(current);
  });

  it('order of the accepted list does not matter', () => {
    expect(projectedCost(conflict, ['schedule', 'resize'])).toBe(projectedCost(conflict, ['resize', 'schedule']));
  });

  it('partial approval flows into totals; reject recomputes from scratch', () => {
    const onlySchedule = approve({}, conflict, AT, ['schedule']);
    expect(onlySchedule.ok).toBe(true);
    let t = aggregate(resources, recommendations, onlySchedule.decisions);
    expect(t.approvedInr).toBeCloseTo(current * offHoursFraction(), 1);
    expect(t.byEnv.staging.approvedInr).toBeCloseTo(t.approvedInr, 2);

    const both = approve(onlySchedule.decisions, conflict, AT); // default = all steps
    t = aggregate(resources, recommendations, both.decisions);
    expect(t.approvedInr).toBeCloseTo(conflict.monthlySavingInr, 1);

    const rejected = reject(both.decisions, conflict, AT);
    expect(aggregate(resources, recommendations, rejected.decisions).approvedInr).toBe(0);
    expect(approvedSaving(conflict, rejected.decisions)).toBe(0);
  });

  it('unknown or empty step selections are refused', () => {
    expect(approve({}, conflict, AT, []).ok).toBe(false);
    const single = recommendations.find((r) => r.action === 'schedule')!;
    expect(approve({}, single, AT, ['resize']).ok).toBe(false);
  });
});

describe('Remove actions end the plan', () => {
  it('stop / delete / release → projected cost 0 and saving = full price', () => {
    for (const id of ['vm-dev-idle', 'vol-orphan', 'ip-unused']) {
      const r = recommendations.find((x) => x.resourceId === id)!;
      expect(r.steps).toHaveLength(1);
      expect(r.steps[0].action).toBe('remove');
      expect(projectedCost(r, ['remove'])).toBe(0);
      expect(savingFor(r, ['remove'])).toBe(r.current.monthlyCostInr);
    }
  });

  it('no saving anywhere is larger than its resource bill', () => {
    for (const r of recommendations) {
      expect(r.monthlySavingInr).toBeLessThanOrEqual(r.current.monthlyCostInr);
      expect(savingFor(r, r.steps.map((s) => s.action))).toBeCloseTo(r.action === 'none' ? 0 : r.monthlySavingInr, 1);
    }
  });
});

describe('Adopt with a partial approval: only the approved steps decide (team decision 24 Oct)', () => {
  const resource = resources.find((r) => r.id === 'vm-stg-conflict')!;
  const adopt = (scenario: ScenarioId, steps?: ('resize' | 'schedule')[]) => {
    const d = approve({}, conflict, AT, steps).decisions;
    const re = revalidate(conflict, previewRecommendation(resource, series.get(resource.id)!, conflict, scenario));
    const out = adoptPlanningAssumptions(recommendations, d, [re], AT);
    const recs = out.recommendations;
    return { out, re, totals: aggregate(resources, recs, out.decisions) };
  };

  it('memory pressure breaks the resize but not the schedule (per-step validity)', () => {
    const { re } = adopt('memPressure');
    expect(re.eligible).toBe(false);
    expect(re.validSteps).toEqual(['schedule']);
  });

  it('only schedule approved → stays approved, saving still counted, note explains why', () => {
    const { out, totals } = adopt('memPressure', ['schedule']);
    expect(out.flagged).toEqual([]);
    expect(out.decisions[conflict.id].status).toBe('approved');
    expect(out.decisions[conflict.id].note).toMatch(/Still valid.*schedule pass; resize \(not approved\) would fail/);
    expect(totals.approvedInr).toBeCloseTo(current * offHoursFraction(), 1);
    expect(totals.needsReview).toEqual([]);
  });

  it('both steps approved → needs-review naming the failed step, nothing counted', () => {
    const { out, totals } = adopt('memPressure');
    expect(out.flagged).toEqual([conflict.id]);
    expect(out.decisions[conflict.id].status).toBe('needs-review');
    expect(out.decisions[conflict.id].note).toMatch(/step\(s\) resize no longer pass/);
    expect(out.decisions[conflict.id].acceptedSteps).toEqual(['resize', 'schedule']); // the human's choice is kept for the record
    expect(totals.approvedInr).toBe(0);
  });

  it('only resize approved → needs-review', () => {
    const { out } = adopt('cpuBurst', ['resize']);
    expect(out.decisions[conflict.id].status).toBe('needs-review');
  });

  it('missing data (F6) invalidates every step, even schedule-only', () => {
    const { re, out, totals } = adopt('missingData', ['schedule']);
    expect(re.validSteps).toEqual([]);
    expect(out.decisions[conflict.id].status).toBe('needs-review');
    expect(totals.approvedInr).toBe(0);
  });

  it('money stays consistent: approved ≤ eligible after adopt, and eligible counts only the valid steps', () => {
    const { totals } = adopt('memPressure', ['schedule']);
    expect(totals.byResource['vm-stg-conflict'].eligibleInr).toBeCloseTo(current * offHoursFraction(), 1);
    expect(totals.approvedInr).toBeLessThanOrEqual(totals.eligibleInr + 1e-6);
  });

  it('after adopt, a new approval may take only the steps that still pass', () => {
    const { re } = adopt('memPressure', ['schedule']);
    expect(approve({}, re, AT, ['schedule']).ok).toBe(true);
    const both = approve({}, re, AT, ['resize', 'schedule']);
    expect(both.ok).toBe(false);
    expect(both.error).toMatch(/step resize no longer passes/);
    expect(approve({}, re, AT).decisions[re.id].acceptedSteps).toEqual(['schedule']); // default = valid steps only
  });
});
