// Human approval workflow and conflict-free money totals (R4, H6, test suite 25).
import { allSteps, eligibleSteps, savingFor } from './plan';
import { approvalDependencyConflicts } from './dependencies';
import { round2, resourceMonthlyCost } from './pricing';
import type { Env, Recommendation, Region, Resource, StepAction } from './types';

export type DecisionStatus = 'pending' | 'approved' | 'rejected' | 'needs-review';

export interface Decision {
  recommendationId: string;
  status: DecisionStatus;
  at: string;
  note?: string;
  /** which steps were accepted; omitted = all steps of the recommendation */
  acceptedSteps?: StepAction[];
}

export type Decisions = Readonly<Record<string, Decision>>;

export interface DecisionResult {
  ok: boolean;
  decisions: Decisions;
  error?: string;
}

/**
 * Only eligible (PASS + saving > 0) recommendations can be approved. Returns a NEW map.
 * `steps` lets a user accept part of a multi-step plan (e.g. only the schedule of resize+schedule).
 */
export interface ApprovalContext { resources: readonly Resource[]; recommendations: readonly Recommendation[] }

/** Approval-time validation is mandatory at the UI/API boundary; standalone unit callers can omit context. */
export function approve(decisions: Decisions, rec: Recommendation, at: string, steps?: StepAction[], context?: ApprovalContext): DecisionResult {
  const available = eligibleSteps(rec).filter(s => !(rec.holdUntil && s === 'resize'));
  if (available.length === 0) {
    return { ok: false, decisions, error: `Cannot approve ${rec.id}: verdict is ${rec.verdict}.` };
  }
  const accepted = steps ?? available;
  const unknown = accepted.filter((s) => !available.includes(s));
  if (accepted.length === 0 || unknown.length > 0) {
    const failing = unknown.filter((s) => allSteps(rec).includes(s));
    const error = failing.length > 0
      ? `Cannot approve ${rec.id}: step ${failing.join(', ')} no longer passes (${rec.verdict}).`
      : `Invalid steps for ${rec.id}: ${unknown.join(', ') || 'none selected'}.`;
    return { ok: false, decisions, error };
  }
  const proposed = { ...decisions, [rec.id]: { recommendationId: rec.id, status: 'approved' as const, at, acceptedSteps: [...accepted] } };
  if (context) {
    const conflicts = approvalDependencyConflicts(context.resources, context.recommendations, proposed);
    if (conflicts.length) {
      const c = conflicts[0];
      return { ok: false, decisions, error: `Cannot approve: ${c.providerId} would be off while dependent ${c.dependentIds.join(', ')} is running. Approve a compatible coordinated bundle first.` };
    }
  }
  return { ok: true, decisions: proposed };
}

/** Atomic coordination: every selected shutdown must be safe in the FINAL approved set. */
export function approveCoordinated(
  decisions: Decisions, items: readonly { rec: Recommendation; steps: StepAction[] }[], at: string, context: ApprovalContext,
): DecisionResult {
  let proposed = decisions;
  for (const { rec, steps } of items) {
    const item = approve(proposed, rec, at, steps); // verify individual eligibility; inter-item dependencies checked after all items
    if (!item.ok) return { ...item, decisions };
    proposed = item.decisions;
  }
  const conflicts = approvalDependencyConflicts(context.resources, context.recommendations, proposed);
  if (conflicts.length) {
    const c = conflicts[0];
    return { ok: false, decisions, error: `Unsafe coordinated plan: ${c.providerId} needs ${c.dependentIds.join(', ')} off in the same window.` };
  }
  return { ok: true, decisions: proposed };
}

/** A dependent plan being undone/rejected cannot silently leave its provider's shutdown approved. */
export function recheckApprovedDependencies(decisions: Decisions, context: ApprovalContext, at: string): Decisions {
  let updated: Decisions = decisions;
  for (let i = 0; i <= context.resources.length; i++) {
    const conflicts = approvalDependencyConflicts(context.resources, context.recommendations, updated);
    if (!conflicts.length) break;
    const patch: Record<string, Decision> = { ...updated };
    for (const conflict of conflicts) {
      const rec = context.recommendations.find(r => r.resourceId === conflict.providerId);
      if (!rec || patch[rec.id]?.status !== 'approved') continue;
      patch[rec.id] = { ...patch[rec.id], status: 'needs-review', at,
        note: `Dependency revalidation: ${conflict.dependentIds.join(', ')} still running while ${rec.resourceId} would be off.` };
    }
    updated = patch;
  }
  return updated;
}

/** Freshness and scenario changes can invalidate an old approval after a restart or re-import.
 * Keep the decision as an audit record, but never show it as an executable approved change. */
export function recheckApprovedEvidence(decisions: Decisions, recs: readonly Recommendation[], at: string): Decisions {
  const byId = new Map(recs.map((rec) => [rec.id, rec]));
  let next: Record<string, Decision> | null = null;
  for (const [id, d] of Object.entries(decisions)) {
    if (d.status !== 'approved') continue;
    const rec = byId.get(id);
    const actions = d.acceptedSteps ?? (rec ? allSteps(rec) : []);
    const allowed = rec ? eligibleSteps(rec) : [];
    if (rec && actions.length > 0 && actions.every((step) => allowed.includes(step))) continue;
    next ??= { ...decisions };
    next[id] = { ...d, status: 'needs-review', at,
      note: `Evidence revalidation: previously approved action no longer passes the available data/safety checks.` };
  }
  return next ?? decisions;
}

/** Previously approved resize actions cannot remain executable when a later declared event holds them.
 * The approval is kept for audit, but must be re-confirmed by a human before it is counted again. */
export function recheckHeldApprovals(decisions: Decisions, recs: readonly Recommendation[], at: string): Decisions {
  let result: Record<string, Decision> | null = null;
  for (const rec of recs) {
    const decision = decisions[rec.id];
    if (!rec.holdUntil || decision?.status !== 'approved') continue;
    const selected = decision.acceptedSteps ?? allSteps(rec);
    if (!selected.includes('resize')) continue;
    result ??= { ...decisions };
    result[rec.id] = { ...decision, status: 'needs-review', at,
      note: `Utsav safety revalidation: resize held until ${rec.holdUntil}; human review required.` };
  }
  return result ?? decisions;
}

/** Saving actually approved for a recommendation, recomputed from the accepted steps (never a running total). */
export function approvedSaving(rec: Recommendation, decisions: Decisions): number {
  const d = decisions[rec.id];
  if (!d || d.status !== 'approved') return 0;
  const accepted = d.acceptedSteps ?? allSteps(rec);
  if (rec.holdUntil && accepted.includes('resize')) return 0;
  const ok = eligibleSteps(rec);
  if (!accepted.every((s) => ok.includes(s))) return 0;
  return savingFor(rec, accepted);
}

export function reject(decisions: Decisions, rec: Recommendation, at: string, note?: string): DecisionResult {
  return { ok: true, decisions: { ...decisions, [rec.id]: { recommendationId: rec.id, status: 'rejected', at, note } } };
}

export function statusOf(decisions: Decisions, recId: string): DecisionStatus {
  return decisions[recId]?.status ?? 'pending';
}

interface Bucket {
  originalInr: number;
  candidateInr: number;
  eligibleInr: number;
  approvedInr: number;
  projectedInr: number;
}

export interface Totals extends Bucket {
  byEnv: Record<Env, Bucket>;
  byRegion: Record<Region, Bucket>;
  byResource: Record<string, Bucket>;
  /** approved recommendations whose evidence no longer passes */
  needsReview: string[];
}

const emptyBucket = (): Bucket => ({ originalInr: 0, candidateInr: 0, eligibleInr: 0, approvedInr: 0, projectedInr: 0 });

/**
 * One source of truth for every rupee on every screen.
 * candidate = all proposed savings (any verdict) · eligible = PASS only · approved = approved AND still eligible.
 * Throws if two recommendations target the same resource (that would double count).
 */
export function aggregate(resources: readonly Resource[], recs: readonly Recommendation[], decisions: Decisions): Totals {
  const recByResource = new Map<string, Recommendation>();
  for (const rec of recs) {
    if (recByResource.has(rec.resourceId)) {
      throw new Error(`Double counting: more than one recommendation for ${rec.resourceId}.`);
    }
    recByResource.set(rec.resourceId, rec);
  }

  const total: Bucket = emptyBucket();
  const byEnv: Record<Env, Bucket> = { prod: emptyBucket(), staging: emptyBucket(), dev: emptyBucket() };
  const byRegion: Record<Region, Bucket> = { noida: emptyBucket(), bengaluru: emptyBucket(), mumbai: emptyBucket() };
  const byResource: Record<string, Bucket> = {};
  const needsReview: string[] = [];

  for (const r of resources) {
    const rec = recByResource.get(r.id);
    const original = resourceMonthlyCost(r);
    const candidate = rec && rec.action !== 'none' ? rec.monthlySavingInr : 0;
    const okSteps = rec ? eligibleSteps(rec) : [];
    const eligible = !rec ? 0 : rec.eligible ? rec.monthlySavingInr : okSteps.length > 0 ? savingFor(rec, okSteps) : 0;
    const status = rec ? statusOf(decisions, rec.id) : 'pending';
    if (status === 'needs-review' && rec) needsReview.push(rec.id);
    const approved = rec ? approvedSaving(rec, decisions) : 0;
    const b: Bucket = { originalInr: original, candidateInr: candidate, eligibleInr: eligible, approvedInr: approved, projectedInr: original - approved };
    byResource[r.id] = b;
    for (const target of [total, byEnv[r.env], byRegion[r.region]]) {
      target.originalInr += b.originalInr;
      target.candidateInr += b.candidateInr;
      target.eligibleInr += b.eligibleInr;
      target.approvedInr += b.approvedInr;
      target.projectedInr += b.projectedInr;
    }
  }

  const r2 = (b: Bucket): Bucket => ({
    originalInr: round2(b.originalInr), candidateInr: round2(b.candidateInr), eligibleInr: round2(b.eligibleInr),
    approvedInr: round2(b.approvedInr), projectedInr: round2(b.projectedInr),
  });
  return {
    ...r2(total),
    byEnv: { prod: r2(byEnv.prod), staging: r2(byEnv.staging), dev: r2(byEnv.dev) },
    byRegion: { noida: r2(byRegion.noida), bengaluru: r2(byRegion.bengaluru), mumbai: r2(byRegion.mumbai) },
    byResource: Object.fromEntries(Object.entries(byResource).map(([k, v]) => [k, r2(v)])),
    needsReview,
  };
}

/**
 * The team EXPLICITLY adopts new planning assumptions (e.g. "+60% is our new normal").
 * Re-validated recommendations replace the old ones; approvals whose new verdict is not PASS
 * are flagged 'needs-review' (never silently kept, never silently deleted).
 */
export function adoptPlanningAssumptions(
  recs: readonly Recommendation[],
  decisions: Decisions,
  revalidated: readonly Recommendation[],
  at: string,
): { recommendations: Recommendation[]; decisions: Decisions; flagged: string[] } {
  const byId = new Map(revalidated.map((r) => [r.id, r]));
  const next: Record<string, Decision> = { ...decisions };
  const flagged: string[] = [];
  const recommendations = recs.map((old) => {
    const updated = byId.get(old.id) ?? old;
    const d = decisions[old.id];
    if (d?.status === 'approved' && !updated.eligible) {
      // Only the steps the human actually approved matter (partial approval of a multi-step plan).
      const accepted = d.acceptedSteps ?? allSteps(old);
      const ok = eligibleSteps(updated);
      const failed = accepted.filter((s) => !ok.includes(s));
      if (failed.length > 0) {
        next[old.id] = { ...d, status: 'needs-review', at, note: `New evidence: ${updated.verdict} — approved step(s) ${failed.join(', ')} no longer pass.` };
        flagged.push(old.id);
      } else {
        const notApproved = allSteps(old).filter((s) => !accepted.includes(s));
        next[old.id] = { ...d, note: `Still valid under new assumptions: approved step(s) ${accepted.join(', ')} pass; ${notApproved.join(', ')} (not approved) would fail.` };
      }
    }
    return updated;
  });
  return { recommendations, decisions: next, flagged };
}
