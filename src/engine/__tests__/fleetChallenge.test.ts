import { describe, expect, it } from 'vitest';
import { generateDataset } from '../../data/generator';
import { analyzeAll } from '../index';
import { challengeFleet } from '../fleetChallenge';

const generate = () => {
  const d = generateDataset();
  const a = analyzeAll(d.resources, d.series);
  return { resources:d.resources, series:d.series, recommendations:a.recommendations };
};

describe('live fleet challenge', () => {
  const input = generate();
  it('returns unchanged baseline at 0% and never edits stored recommendations', () => {
    const previous = JSON.stringify(input.recommendations);
    const baseline = challengeFleet(input,0);
    expect(baseline.baselineEligibleCount).toBe(59);
    expect(baseline.remainingEligibleCount).toBe(59);
    expect(baseline.lostSavingInr).toBe(0);
    expect(baseline.lostEligibility).toHaveLength(0);
    expect(JSON.stringify(input.recommendations)).toBe(previous);
  });
  it('derives +60% blocked candidates from actual ForeSight evaluation', () => {
    const r = challengeFleet(input,60);
    expect(r.remainingEligibleCount).toBe(51);
    expect(r.lostEligibility).toHaveLength(8);
    expect(r.stressedEligibleInr).toBe(191886.35);
    expect(r.lostSavingInr).toBe(26963.64);
    expect(r.reducedSaving.every(x => x.deltaInr > 0)).toBe(true);
  });
  it('decreases eligible savings as simulated demand increases', () => {
    const a = challengeFleet(input,25), b=challengeFleet(input,60), c=challengeFleet(input,100);
    expect(a.stressedEligibleInr).toBeGreaterThanOrEqual(b.stressedEligibleInr);
    expect(b.stressedEligibleInr).toBeGreaterThanOrEqual(c.stressedEligibleInr);
    expect(a.remainingEligibleCount).toBeGreaterThanOrEqual(b.remainingEligibleCount);
    expect(b.remainingEligibleCount).toBeGreaterThanOrEqual(c.remainingEligibleCount);
  });
  it('never allows invalid stress or missing telemetry to appear verified',()=>{
    expect(()=>challengeFleet(input,201)).toThrow();
    expect(()=>challengeFleet(input,-1)).toThrow();
    expect(()=>challengeFleet(input,0.5)).toThrow();
    const target=input.recommendations.find(r=>r.eligible&&r.proposed.size)!;
    const series=new Map(input.series);series.delete(target.resourceId);
    const r=challengeFleet({...input,series},60);
    expect(r.eligibleIds.has(target.resourceId)).toBe(false);
  });
  it('separates event-held resize savings from immediately actionable amounts',()=>{
    const target=input.recommendations.find(r=>r.eligible&&r.steps.some(s=>s.action==='resize'))!;
    const held=input.recommendations.map(r=>r.id===target.id?{...r,holdUntil:'2026-11-11'}:r);
    const r=challengeFleet({...input,recommendations:held},0);
    expect(r.baselineActionableInr).toBeLessThanOrEqual(r.baselineEligibleInr);
    expect(r.baselineEligibleInr-r.baselineActionableInr).toBeGreaterThan(0);
  });
});
