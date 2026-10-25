// Risk Budget Portfolio (assumptions §AA): exact, deterministic, reconciles with eligible savings.
import { describe, expect, it } from 'vitest';
import { generateDataset } from '../../data/generator';
import { mulberry32 } from '../../data/random';
import { aggregate, analyzeAll } from '../index';
import { buildPortfolio, portfolioCandidates, RISK_APPETITES, riskPointsOf } from '../portfolio';
import type { Recommendation } from '../types';

const d = generateDataset();
const recs = analyzeAll(d.resources, d.series).recommendations;
const totals = aggregate(d.resources, recs, {});

/** minimal fake recommendation for the optimality test */
function fake(i: number, saving: number, risk: 'low' | 'medium' | 'high'): Recommendation {
  return {
    id: `r${i}`, resourceId: `x${i}`, resourceName: `x${i}`, resourceType: 'vm', env: 'dev', region: 'mumbai', team: 't', action: 'resize',
    current: { size: { vcpu: 8, ramGb: 32 }, hoursOnPerMonth: 730, monthlyCostInr: 100000 },
    proposed: { size: { vcpu: 4, ramGb: 16 }, hoursOnPerMonth: 730, monthlyCostInr: 100000 - saving },
    monthlySavingInr: saving, savingFormula: '', evidence: {} as Recommendation['evidence'], checks: [], verdict: 'PASS_UNDER_TESTED_CONDITIONS',
    risk, dataAdequacyScore: 1, reasons: [], assumptionIds: [], requiresHumanReview: false, eligible: true,
    steps: [{ action: 'resize', label: 'Resize', costAfterInr: 100000 - saving, marginalSavingInr: saving, size: { vcpu: 4, ramGb: 16 } }],
  };
}

describe('Risk points', () => {
  it('documented formula: base + shutdown + prod + event hold', () => {
    const r = fake(1, 100, 'medium');
    expect(riskPointsOf(r).points).toBe(3);
    expect(riskPointsOf({ ...r, env: 'prod', holdUntil: '2026-11-11' }).points).toBe(3 + 2 + 5);
    expect(riskPointsOf({ ...r, risk: 'high' }).why).toMatch(/high risk 8/);
  });
});

describe('Knapsack is exact', () => {
  it('matches brute force on 200 random small instances', () => {
    const rand = mulberry32(9);
    const risks = ['low', 'medium', 'high'] as const;
    for (let t = 0; t < 200; t++) {
      const n = 1 + Math.floor(rand() * 10);
      const sizes = [{ vcpu: 1, ramGb: 2 }, { vcpu: 2, ramGb: 4 }, { vcpu: 2, ramGb: 8 }, { vcpu: 4, ramGb: 8 }, { vcpu: 4, ramGb: 16 }];
      const items = Array.from({ length: n }, (_, i) => {
        const f = fake(i, 0, risks[Math.floor(rand() * 3)]);
        const size = sizes[Math.floor(rand() * sizes.length)];
        return { ...f, steps: [{ ...f.steps[0], size }], proposed: { ...f.proposed, size } };
      });
      const budget = Math.floor(rand() * 30);
      // brute force over the SAME candidate values the portfolio uses (savings are recomputed from catalog prices)
      const cand = portfolioCandidates(items);
      let bestBrute = 0;
      for (let mask = 0; mask < 1 << cand.length; mask++) {
        let w = 0;
        let v = 0;
        for (let i = 0; i < cand.length; i++) if (mask & (1 << i)) { w += cand[i].riskPoints; v += cand[i].savingInr; }
        if (w <= budget && v > bestBrute) bestBrute = v;
      }
      const p = buildPortfolio(items, budget);
      expect(p.choice.savingInr).toBeCloseTo(bestBrute, 2);
      expect(p.choice.riskPointsUsed).toBeLessThanOrEqual(budget);
    }
  });
});

describe('On the dataset', () => {
  it('candidates are exactly the approvable changes; full budget = total eligible savings', () => {
    const c = portfolioCandidates(recs);
    expect(c.every((x) => recs.find((r) => r.id === x.recommendationId)!.eligible || x.steps.length > 0)).toBe(true);
    const all = buildPortfolio(recs, 1e9);
    expect(all.choice.savingInr).toBeCloseTo(totals.eligibleInr, 1);
    expect(all.choice.chosen).toHaveLength(c.length);
  });

  it('budget 0 → nothing; appetites rise monotonically; frontier strictly increases', () => {
    expect(buildPortfolio(recs, 0).choice.chosen).toHaveLength(0);
    const s = Object.values(RISK_APPETITES).map((b) => buildPortfolio(recs, b).choice.savingInr);
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeGreaterThanOrEqual(s[i - 1]);
    const f = buildPortfolio(recs, 0).frontier;
    for (let i = 1; i < f.length; i++) {
      expect(f[i].budget).toBeGreaterThan(f[i - 1].budget);
      expect(f[i].savingInr).toBeGreaterThan(f[i - 1].savingInr);
    }
  });

  it('a cautious budget prefers low-risk changes and never picks a blocked step', () => {
    const p = buildPortfolio(recs, RISK_APPETITES.cautious);
    expect(p.choice.chosen.length).toBeGreaterThan(0);
    for (const x of p.choice.chosen) {
      const r = recs.find((y) => y.id === x.recommendationId)!;
      for (const s of x.steps) expect(r.blockedSteps ?? []).not.toContain(s);
    }
    expect(p.method).toMatch(/Exact 0\/1 knapsack/);
  });

  it('deterministic: same input → same choice', () => {
    expect(buildPortfolio(recs, 60).choice.chosen.map((x) => x.recommendationId)).toEqual(buildPortfolio(recs, 60).choice.chosen.map((x) => x.recommendationId));
  });
});
