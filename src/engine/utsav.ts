// Utsav Mode: event-aware rightsizing (assumptions §Z).
// A 30-day history cannot contain Diwali, a sale or an IPL final that has not happened yet. The TEAM declares
// upcoming events (dates + expected load); the engine re-checks every proposed resize under that load and says
// "safe through the event" or "hold until after it". The engine never guesses the multiplier.
// Practitioner advice (plan known peaks separately from steady-state sizing) built into each decision.
import { withExtraWorkload } from './challenge';
import { evaluateSize } from './foresight';
import { eligibleSteps, savingFor } from './plan';
import type { Env, MetricSeries, Recommendation, Region, Resource } from './types';

export interface PlannedEvent {
  id: string;
  name: string;
  /** first and last day of the event, YYYY-MM-DD (IST calendar days, inclusive) */
  start: string;
  end: string;
  /** expected CPU demand as a multiple of normal, e.g. 2 = double. Memory grows with it (same model as the break point). */
  loadMultiplier: number;
  /** which resources are affected; empty / omitted = all production VMs */
  envs?: Env[];
  regions?: Region[];
  teams?: string[];
  /** who said so / why (shown in the Passport) */
  source?: string;
}

export type UtsavStatus = 'safe-through-event' | 'hold-until-after' | 'current-also-at-risk' | 'insufficient-evidence';

export interface UtsavResult {
  recommendationId: string;
  resourceId: string;
  eventId: string;
  status: UtsavStatus;
  /** the day after the event ends (YYYY-MM-DD) when status is hold-until-after */
  holdUntil: string | null;
  message: string;
}

export interface UtsavReport {
  asOf: string;
  events: PlannedEvent[];
  results: UtsavResult[];
  counts: Record<UtsavStatus, number>;
  /** resizes worth holding and their monthly saving that waits until after the event */
  heldSavingInr: number;
  errors: string[];
}

/** Example only: the date is verified (Diwali 2026 = Sun 8 Nov); the load multiplier MUST come from the team. */
export const EVENT_PRESETS: Omit<PlannedEvent, 'loadMultiplier'>[] = [
  { id: 'diwali-2026', name: 'Diwali week 2026', start: '2026-11-05', end: '2026-11-10', source: 'Diwali (Lakshmi Puja) is Sun 8 Nov 2026; window and load set by the team' },
];

const DAY = 86400000;
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s + 'T00:00:00Z'));
const dayAfter = (s: string) => new Date(Date.parse(s + 'T00:00:00Z') + DAY).toISOString().slice(0, 10);

export function validateEvent(e: PlannedEvent): string[] {
  const errs: string[] = [];
  if (!e.id || !e.name) errs.push('Every event needs an id and a name.');
  if (!isDate(e.start) || !isDate(e.end)) errs.push(`${e.name || e.id}: start and end must be YYYY-MM-DD.`);
  else if (e.end < e.start) errs.push(`${e.name}: end is before start.`);
  if (!Number.isFinite(e.loadMultiplier) || e.loadMultiplier < 1 || e.loadMultiplier > 20) errs.push(`${e.name || e.id}: loadMultiplier must be between 1 and 20 (1 = normal load).`);
  return errs;
}

const affects = (e: PlannedEvent, r: Resource) =>
  (e.envs?.length ? e.envs.includes(r.env) : r.env === 'prod') &&
  (!e.regions?.length || e.regions.includes(r.region)) &&
  (!e.teams?.length || e.teams.includes(r.team));

/**
 * Checks every recommendation that contains a resize against every upcoming event that affects its resource.
 * Pure preview: changes nothing. `asOf` = today (YYYY-MM-DD); events that ended before it are ignored.
 */
export function utsavCheck(
  resources: readonly Resource[],
  series: ReadonlyMap<string, MetricSeries>,
  recs: readonly Recommendation[],
  events: readonly PlannedEvent[],
  asOf: string,
): UtsavReport {
  const errors = events.flatMap(validateEvent);
  if (!isDate(asOf)) errors.push('asOf must be YYYY-MM-DD.');
  const counts: Record<UtsavStatus, number> = { 'safe-through-event': 0, 'hold-until-after': 0, 'current-also-at-risk': 0, 'insufficient-evidence': 0 };
  if (errors.length) return { asOf, events: [...events], results: [], counts, heldSavingInr: 0, errors };

  const upcoming = events.filter((e) => e.end >= asOf);
  const byId = new Map(resources.map((r) => [r.id, r]));
  const results: UtsavResult[] = [];
  const held = new Set<string>();
  let heldSavingInr = 0;

  for (const rec of recs) {
    const step = rec.steps.find((s) => s.action === 'resize');
    if (!step?.size || !rec.eligible) continue;
    const r = byId.get(rec.resourceId);
    const s = series.get(rec.resourceId);
    if (!r || !s || r.type !== 'vm') continue;
    const current = { vcpu: r.vcpu!, ramGb: r.ramGb! };
    for (const e of upcoming.filter((x) => affects(x, r))) {
      const extra = (e.loadMultiplier - 1) * 100;
      const load = withExtraWorkload(s, extra);
      const onTarget = evaluateSize(load, current, step.size, r.env);
      const onCurrent = evaluateSize(load, current, current, r.env);
      let status: UtsavStatus;
      let message: string;
      const pct = `+${Math.round(extra)}%`;
      if (onTarget.verdict === 'INSUFFICIENT_EVIDENCE') {
        status = 'insufficient-evidence';
        message = `Not enough data to judge ${e.name}.`;
      } else if (onTarget.verdict === 'PASS_UNDER_TESTED_CONDITIONS') {
        status = 'safe-through-event';
        message = `The smaller size also passes at ${e.name} load (${pct}).`;
      } else if (onCurrent.verdict !== 'PASS_UNDER_TESTED_CONDITIONS') {
        status = 'current-also-at-risk';
        message = `At ${e.name} load (${pct}) even the CURRENT size fails (${onCurrent.reasons[0] ?? 'capacity check'}). Do not shrink it — plan extra capacity for the event.`;
      } else {
        status = 'hold-until-after';
        message = `Safe today, but at ${e.name} load (${pct}) the smaller size fails: ${onTarget.reasons[0]} Resize after ${e.end}.`;
      }
      counts[status]++;
      const holdUntil = status === 'hold-until-after' || status === 'current-also-at-risk' ? dayAfter(e.end) : null;
      results.push({ recommendationId: rec.id, resourceId: r.id, eventId: e.id, status, holdUntil, message });
      if (holdUntil && !held.has(rec.id)) {
        held.add(rec.id);
        // Only the marginal resize benefit is deferred. For resize+schedule plans,
        // the scheduling benefit can remain available now. Recompute from the
        // plan, rather than incorrectly deferring the entire bundled saving.
        const applicable = eligibleSteps(rec);
        const withoutResize = applicable.filter((a) => a !== 'resize');
        heldSavingInr += savingFor(rec, applicable) - savingFor(rec, withoutResize);
      }
    }
  }
  return { asOf, events: [...events], results, counts, heldSavingInr: Math.round(heldSavingInr * 100) / 100, errors };
}

/**
 * Applies a report to the recommendations: a resize that fails during an upcoming event gets `holdUntil`
 * (the latest such date), a first reason line and risk ≥ medium. It stays approvable as a PLANNING decision,
 * but the change script will say "do not apply before <date>". Never changes savings or verdicts.
 */
export function applyUtsav(recs: readonly Recommendation[], report: UtsavReport): Recommendation[] {
  const latest = new Map<string, UtsavResult>();
  for (const x of report.results) {
    if (!x.holdUntil) continue;
    const prev = latest.get(x.recommendationId);
    if (!prev || x.holdUntil > prev.holdUntil!) latest.set(x.recommendationId, x);
  }
  return recs.map((r) => {
    const x = latest.get(r.id);
    if (!x) return r;
    return {
      ...r,
      holdUntil: x.holdUntil!,
      risk: r.risk === 'low' ? 'medium' : r.risk,
      reasons: [`Utsav Mode: ${x.message} Hold until ${x.holdUntil}.`, ...r.reasons],
      assumptionIds: [...new Set([...r.assumptionIds, 'Z'])],
    };
  });
}
