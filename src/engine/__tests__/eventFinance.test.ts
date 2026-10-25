import { describe, expect, it } from 'vitest';
import { buildFixtures } from '../../data/fixtures';
import { analyzeAll } from '../index';
import { approve, approvedSaving, recheckHeldApprovals } from '../decisions';
import { eventTimingSummary } from '../eventFinance';
import { savingFor } from '../plan';

const d = buildFixtures();
const recs = analyzeAll(d.resources,d.series).recommendations;
const multi = recs.find((r)=>r.resourceId==='vm-stg-conflict')!;

describe('Approved and eligible savings by event timing',()=>{
  it('does not misstate a future resize plus available schedule as immediately executable',()=>{
    const rec={...multi,holdUntil:'2026-11-11'};
    const result=approve({},rec,'2026-10-25T00:00:00Z');
    expect(result.ok).toBe(true);
    // An already-held resize is NEVER part of a new approval; schedule alone remains safe.
    expect(result.decisions[rec.id].acceptedSteps).toEqual(['schedule']);
    const t=eventTimingSummary([rec],result.decisions);
    expect(t.eligiblePlannedInr).toBeCloseTo(savingFor(rec,['resize','schedule']),2);
    expect(t.eligiblePlannedInr).toBeCloseTo(9333.87,2);
    expect(t.eligibleNowInr).toBeCloseTo(savingFor(rec,['schedule']),2);
    expect(t.eligibleNowInr).toBeCloseTo(7307.75,2);
    expect(t.deferredEligibleInr).toBeCloseTo(2026.12,2);
    expect(t.deferredEligibleInr).toBeCloseTo(t.eligiblePlannedInr-t.eligibleNowInr,2);
    expect(t.approvedPlannedInr).toBeCloseTo(t.eligibleNowInr,2);
    expect(t.approvedNowInr).toBeCloseTo(t.approvedPlannedInr,2);
    expect(t.deferredApprovedInr).toBe(0); // never count a resize that wasn't approved
  });
  it('previously approved resize is not counted after a new Utsav hold without human reapproval',()=>{
    const old = approve({}, multi, '2026-10-24T00:00:00Z');
    expect(old.ok).toBe(true);
    const held = { ...multi, holdUntil: '2026-11-11' };
    // Even before audit revalidation, a previously-approved held resize contributes zero approved saving.
    expect(approvedSaving(held, old.decisions)).toBe(0);
    const reviewed = recheckHeldApprovals(old.decisions, [held], '2026-10-25T00:00:00Z');
    expect(reviewed[held.id].status).toBe('needs-review');
    const t = eventTimingSummary([held], reviewed);
    expect(t.approvedPlannedInr).toBe(0);
    expect(t.approvedNowInr).toBe(0);
    expect(t.deferredApprovedInr).toBe(0);
    expect(t.deferredEligibleInr).toBeGreaterThan(0);
  });
  it('retains identical savings when no event hold exists',()=>{
    const t=eventTimingSummary(recs,{});
    expect(t.eligibleNowInr).toBeCloseTo(t.eligiblePlannedInr,2);
    expect(t.deferredEligibleInr).toBe(0);
  });
});
