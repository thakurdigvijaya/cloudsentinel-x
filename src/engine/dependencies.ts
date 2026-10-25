// Dependency Shield (assumptions §X). "A depends on B" is recorded as A.dependsOn = [B].
// Before B is stopped or scheduled off, every resource that depends on B — directly or through others — must be
// off at least whenever B is off. Otherwise the step is BLOCKED (check G1 fails), with the dependents named.
// Cycle-safe. Unknown dependencies are NOT treated as "no dependencies": every shutdown still needs a human.
import { eligibleSteps } from './plan';
import type { CheckResult, Recommendation, Resource, StepAction } from './types';
import type { Decisions } from './decisions';

/** Reverse edges: B → resources that directly depend on B. */
export function directDependents(resources: readonly Resource[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of resources) {
    for (const dep of r.dependsOn ?? []) {
      if (dep === r.id) continue;
      let list = out.get(dep);
      if (!list) out.set(dep, (list = []));
      list.push(r.id);
    }
  }
  return out;
}

/** Everything that depends on `id`, directly or transitively (breadth-first, cycle-safe, never includes `id`). */
export function transitiveDependents(id: string, direct: ReadonlyMap<string, readonly string[]>): string[] {
  const seen = new Set<string>([id]);
  const order: string[] = [];
  const queue = [...(direct.get(id) ?? [])];
  while (queue.length) {
    const x = queue.shift()!;
    if (seen.has(x)) continue;
    seen.add(x);
    order.push(x);
    queue.push(...(direct.get(x) ?? []));
  }
  return order;
}

type Off = 'always' | 'nights-and-weekends' | 'weekends' | 'never';

/** When is this resource planned to be off (only steps that are currently allowed count)? */
function offWindow(rec: Recommendation | undefined): Off {
  if (!rec) return 'never';
  const ok = eligibleSteps(rec);
  if (ok.includes('remove')) return 'always';
  if (ok.includes('schedule')) return rec.scheduleWindow ?? 'nights-and-weekends';
  return 'never';
}

/** Is `dependent` off at least whenever the provider is off under `providerOff`? */
function covers(dependent: Off, providerOff: Off): boolean {
  if (dependent === 'always') return true;
  if (providerOff === 'always') return false; // provider gone for good, dependent still runs at some point
  if (providerOff === 'weekends') return dependent === 'weekends' || dependent === 'nights-and-weekends';
  return dependent === 'nights-and-weekends';
}

/**
 * Applies the gate to every recommendation (returns new objects for changed ones). Repeats until nothing changes,
 * because blocking one plan can keep its own providers running.
 */
export function applyDependencyShield(resources: readonly Resource[], recs: readonly Recommendation[]): Recommendation[] {
  const direct = directDependents(resources);
  if (direct.size === 0) return [...recs]; // no dependency data at all: nothing to check (human review still required)
  const byResource = new Map(recs.map((r) => [r.resourceId, r]));
  const res = new Map(resources.map((r) => [r.id, r]));
  const out = new Map(recs.map((r) => [r.id, r]));
  const describe = (id: string) => {
    const r = res.get(id);
    return r ? `${r.name} (${r.env})` : id;
  };

  for (let pass = 0; pass <= resources.length; pass++) {
    let changed = false;
    for (const rec of out.values()) {
      if (rec.resourceType !== 'vm') continue;
      const ok = eligibleSteps(rec);
      const shutdownSteps = ok.filter((s): s is StepAction => s === 'remove' || s === 'schedule');
      if (shutdownSteps.length === 0) continue;
      const providerOff: Off = shutdownSteps.includes('remove') ? 'always' : rec.scheduleWindow ?? 'nights-and-weekends';
      const deps = transitiveDependents(rec.resourceId, direct);
      if (deps.length === 0) continue;
      const blocking = deps.filter((d) => !covers(offWindow(byResource.get(d)), providerOff));
      if (blocking.length === 0) continue;

      const blockedSteps = shutdownSteps;
      const validSteps = ok.filter((s) => !blockedSteps.includes(s));
      const g1: CheckResult = { id: 'G1', label: 'Dependents still running while it is off', limit: 0, actual: blocking.length, passed: false, unit: 'count' };
      const names = blocking.map(describe).join(', ');
      const updated: Recommendation = {
        ...rec,
        eligible: false,
        validSteps,
        blockedSteps,
        verdict: 'FAIL_SAFETY_CHECKS',
        risk: 'high',
        requiresHumanReview: true,
        checks: [...rec.checks.filter((c) => c.id !== 'G1'), g1],
        reasons: [
          `Blocked by Dependency Shield: ${names} depend${blocking.length === 1 ? 's' : ''} on this VM and would keep running while it is ${providerOff === 'always' ? 'stopped' : 'off'}.` +
            (validSteps.length ? ` The ${validSteps.join(' + ')} step can still be approved on its own.` : ''),
          ...rec.reasons,
        ],
        assumptionIds: [...new Set([...rec.assumptionIds, 'X'])],
      };
      out.set(rec.id, updated);
      byResource.set(rec.resourceId, updated);
      changed = true;
    }
    if (!changed) break;
  }

  // Shutdowns that passed the gate say what was checked — and that the map may be incomplete.
  return recs.map((orig) => {
    const r = out.get(orig.id)!;
    if (r !== orig || r.resourceType !== 'vm') return r;
    const shut = eligibleSteps(r).some((s) => s === 'remove' || s === 'schedule');
    if (!shut) return r;
    const deps = transitiveDependents(r.resourceId, direct);
    const note = deps.length
      ? `Dependency Shield: all ${deps.length} recorded dependent(s) (${deps.map(describe).join(', ')}) are off whenever this VM is off.`
      : 'Dependency Shield: no recorded dependents (the dependency map may be incomplete — confirm with the owning team).';
    return { ...r, reasons: [...r.reasons, note] };
  });
}

/** The *recorded* plan, not merely an eligible proposal, determines shutdown safety.
 * A provider is only off when its approval actually includes remove/schedule.
 */
export interface ApprovalDependencyConflict {
  providerId: string;
  dependentIds: string[];
  providerWindow: 'always' | 'nights-and-weekends' | 'weekends';
}

export function approvalDependencyConflicts(
  resources: readonly Resource[], recs: readonly Recommendation[], decisions: Decisions,
): ApprovalDependencyConflict[] {
  const depGraph = directDependents(resources);
  const byResource = new Map(recs.map(r => [r.resourceId, r]));
  const approvedOff = (id: string): Off => {
    const rec = byResource.get(id);
    const d = rec && decisions[rec.id];
    if (!rec || d?.status !== 'approved') return 'never';
    const allowed = eligibleSteps(rec);
    const selected = d.acceptedSteps ?? allowed;
    if (!selected.every(s => allowed.includes(s))) return 'never';
    if (selected.includes('remove')) return 'always';
    if (selected.includes('schedule')) return rec.scheduleWindow ?? 'nights-and-weekends';
    return 'never';
  };
  const conflicts: ApprovalDependencyConflict[] = [];
  for (const rec of recs) {
    if (rec.resourceType !== 'vm') continue;
    const providerWindow = approvedOff(rec.resourceId);
    if (providerWindow === 'never') continue;
    const dependentIds = transitiveDependents(rec.resourceId, depGraph)
      .filter(id => !covers(approvedOff(id), providerWindow));
    if (dependentIds.length) conflicts.push({ providerId: rec.resourceId, dependentIds, providerWindow });
  }
  return conflicts;
}
