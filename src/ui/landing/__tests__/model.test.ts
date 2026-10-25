// The Evidence Sphere shows real resources and real engine totals; nothing on it may be invented.
import { describe, expect, it } from 'vitest';
import { loadData } from '../../data';
import { buildFleet, computeStress, kindOf, placementFor, portfolioView, targetsFor, PALETTE } from '../model';
import { aggregate } from '../../../engine/decisions';
import { fibonacciSphere } from '../sphere';

const data = loadData();
const fleet = buildFleet(data);

describe('fleet', () => {
  it('has exactly one node per resource', () => {
    expect(fleet.nodes.length).toBe(data.resources.length);
    expect(new Set(fleet.nodes.map((n) => n.id)).size).toBe(data.resources.length);
  });
  it('splits into the four kinds and the counts add up', () => {
    const c = fleet.counts;
    expect(c.safe + c.refused + c.thin + c.none).toBe(fleet.nodes.length);
    expect(c.safe).toBe(data.baseRecommendations.filter((r) => r.eligible && r.monthlySavingInr > 0).length);
  });
  it('eligible total equals the engine aggregate, and the not-claimed figure is candidate minus eligible', () => {
    const t = aggregate(data.resources, data.baseRecommendations, {});
    expect(fleet.eligibleInr).toBe(t.eligibleInr);
    expect(fleet.notClaimedInr).toBe(t.candidateInr - t.eligibleInr);
    expect(fleet.originalInr).toBe(t.originalInr);
  });
  it('kindOf never calls a refused or thin saving safe', () => {
    for (const n of fleet.nodes) if (n.kind === 'safe') expect(n.rec?.eligible).toBe(true);
    expect(kindOf(undefined)).toBe('none');
  });
});

describe('stress explorer', () => {
  it('normal demand changes nothing', () => {
    const s = computeStress(data, 'normal');
    expect(s.dropped.length).toBe(0);
    expect(s.eligibleInr).toBe(fleet.eligibleInr);
  });
  it('a harsher scenario never adds savings, and dropped items were safe before', () => {
    const s = computeStress(data, 'traffic60');
    expect(s.eligibleInr).toBeLessThanOrEqual(fleet.eligibleInr);
    for (const r of s.dropped) expect(fleet.nodes.find((n) => n.id === r.resourceId)?.kind).toBe('safe');
  });
});

describe('portfolio view', () => {
  it('a bigger risk budget never chooses less saving', () => {
    const c = portfolioView(data, 'cautious').savingInr;
    const b = portfolioView(data, 'balanced').savingInr;
    const o = portfolioView(data, 'bold').savingInr;
    expect(c).toBeLessThanOrEqual(b);
    expect(b).toBeLessThanOrEqual(o);
  });
  it('chosen ids are all safe changes', () => {
    for (const id of portfolioView(data, 'bold').chosen) expect(fleet.nodes.find((n) => n.id === id)?.kind).toBe('safe');
  });
});

describe('targets and placement', () => {
  it('one target per node in every chapter, finite, inside the unit ball for the sphere chapters', () => {
    const stress = computeStress(data, 'traffic60');
    for (const theme of ['light', 'dark'] as const) {
      for (let ch = 0; ch <= 8; ch++) {
        const t = targetsFor(ch, fleet, { theme, stress, chosen: portfolioView(data, 'balanced').chosen });
        expect(t.length).toBe(fleet.nodes.length);
        for (const n of t) {
          expect([n.x, n.y, n.z, n.size, n.a].every(Number.isFinite)).toBe(true);
          if (ch !== 3) expect(Math.hypot(n.x, n.y, n.z)).toBeLessThan(1.001);
        }
      }
    }
  });
  it('the verdict is carried by shape as well as colour', () => {
    const t = targetsFor(2, fleet, { theme: 'light', stress: null, chosen: null });
    const shapes = new Set(fleet.nodes.map((n, i) => `${n.kind}:${t[i].shape}`));
    expect([...shapes].some((s) => s === 'refused:1')).toBe(fleet.counts.refused > 0);
    expect([...shapes].some((s) => s === 'thin:2')).toBe(fleet.counts.thin > 0);
    expect(PALETTE.light.safe).not.toEqual(PALETTE.light.refused);
  });
  it('the sphere stays inside its panel, below the labels and above the step card, for common panel sizes', () => {
    for (const [W, H] of [[288, 330], [358, 330], [560, 380], [640, 480]]) {
      for (let ch = 0; ch <= 5; ch++) {
        const p = placementFor(ch, W, H);
        expect(p.r).toBeGreaterThan(20);
        expect(p.cx - p.r * 1.5).toBeGreaterThan(0);
        expect(p.cx + p.r * 1.5).toBeLessThan(W);
        expect(p.cy - p.r).toBeGreaterThan(65);
        expect(p.cy + p.r * 1.42).toBeLessThan(H);
      }
    }
  });
  it('fibonacciSphere points sit on the requested radius', () => {
    for (const p of fibonacciSphere(50, 2)) expect(Math.hypot(p[0], p[1], p[2])).toBeCloseTo(2, 6);
  });
});
