// "Where did the money go?" — the brief's opening problem (assumptions §V).
// Bill Explainer: where the monthly bill goes, how much of it is waste we can safely remove, what we refuse to
// claim, and why spend grew. Role briefs: the same numbers phrased for engineer / finance / leadership.
// Everything is derived from engine output; no number is computed in the UI.
import type { Totals } from './decisions';
import { dailySpend, dayIndex } from './spend';
import { resourceMonthlyCost, round2 } from './pricing';
import type { Alert, Env, Recommendation, Resource, StepAction } from './types';

export type WasteCategory = 'idle-vm' | 'oversized' | 'off-hours' | 'orphaned-volume' | 'unused-ip';

const CATEGORY_PHRASE: Record<WasteCategory, string> = {
  'idle-vm': 'idle VMs',
  oversized: 'oversized VMs',
  'off-hours': 'non-prod VMs running off-hours',
  'orphaned-volume': 'orphaned volumes',
  'unused-ip': 'unused public IPs',
};

const CATEGORY_LABEL: Record<WasteCategory, string> = {
  'idle-vm': 'Idle VMs (stop)',
  oversized: 'Oversized VMs (resize)',
  'off-hours': 'Non-prod running off-hours (schedule)',
  'orphaned-volume': 'Orphaned volumes (delete)',
  'unused-ip': 'Unused public IPs (release)',
};

export interface WasteBucket {
  category: WasteCategory;
  label: string;
  resources: number;
  /** savings that pass every check (safe to act on) */
  eligibleInr: number;
}

export interface GrowthRow {
  key: string;
  firstWeekInr: number;
  lastWeekInr: number;
  deltaInr: number;
}

export interface BillExplanation {
  monthlyBillInr: number;
  waste: WasteBucket[];
  wasteEligibleInr: number;
  wasteSharePct: number;
  /** proposed savings we do NOT claim because a check failed or evidence is insufficient */
  notClaimedInr: number;
  notClaimedResources: number;
  growth: {
    firstWeekInr: number;
    lastWeekInr: number;
    pct: number;
    byTeam: GrowthRow[];
    byEnv: GrowthRow[];
    newResources: { id: string; name: string; team: string; env: Env; createdDay: number; monthlyInr: number }[];
    /** share of the week-over-week increase explained by resources created inside the window */
    newResourcesShareOfIncreasePct: number;
  };
  headlines: string[];
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

function categoryOf(rec: Recommendation, step: StepAction): WasteCategory {
  if (step === 'resize') return 'oversized';
  if (step === 'schedule') return 'off-hours';
  if (rec.resourceType === 'volume') return 'orphaned-volume';
  if (rec.resourceType === 'ip') return 'unused-ip';
  return 'idle-vm';
}

/**
 * @param days length of the observed window (30 for the dataset). Growth compares the first and last 7 days.
 */
export function explainBill(resources: readonly Resource[], recs: readonly Recommendation[], seriesStartIso: string, days: number): BillExplanation {
  const monthlyBillInr = round2(resources.reduce((a, r) => a + resourceMonthlyCost(r), 0));

  // Waste by category — eligible plans only, split by step (marginal savings add up to each plan's saving).
  const buckets = new Map<WasteCategory, { ids: Set<string>; inr: number }>();
  for (const rec of recs) {
    if (!rec.eligible) continue;
    for (const step of rec.steps) {
      const c = categoryOf(rec, step.action);
      const b = buckets.get(c) ?? { ids: new Set<string>(), inr: 0 };
      b.ids.add(rec.resourceId);
      b.inr += step.marginalSavingInr;
      buckets.set(c, b);
    }
  }
  const waste: WasteBucket[] = [...buckets.entries()]
    .map(([category, b]) => ({ category, label: CATEGORY_LABEL[category], resources: b.ids.size, eligibleInr: round2(b.inr) }))
    .sort((a, b) => b.eligibleInr - a.eligibleInr);
  const wasteEligibleInr = round2(waste.reduce((a, w) => a + w.eligibleInr, 0));
  const notClaimed = recs.filter((r) => r.action !== 'none' && !r.eligible && r.monthlySavingInr > 0);
  const notClaimedInr = round2(notClaimed.reduce((a, r) => a + r.monthlySavingInr, 0));

  // Growth: first vs last 7 days of estimated daily spend, by team and environment.
  const w = 7;
  const weekSum = (rs: readonly Resource[], from: number) => dailySpend(rs, seriesStartIso, days).slice(from, from + w).reduce((a, b) => a + b, 0);
  const rows = (key: (r: Resource) => string): GrowthRow[] => {
    const groups = new Map<string, Resource[]>();
    for (const r of resources) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
    return [...groups.entries()]
      .map(([k, rs]) => {
        const first = weekSum(rs, 0);
        const last = weekSum(rs, days - w);
        return { key: k, firstWeekInr: round2(first), lastWeekInr: round2(last), deltaInr: round2(last - first) };
      })
      .sort((a, b) => b.deltaInr - a.deltaInr);
  };
  const firstWeekInr = round2(weekSum(resources, 0));
  const lastWeekInr = round2(weekSum(resources, days - w));
  const pct = firstWeekInr > 0 ? ((lastWeekInr - firstWeekInr) / firstWeekInr) * 100 : 0;
  const newOnes = resources
    .map((r) => ({ r, day: dayIndex(r.createdAt, seriesStartIso) }))
    .filter((x) => x.day >= 1 && x.day < days)
    .map(({ r, day }) => ({ id: r.id, name: r.name, team: r.team, env: r.env, createdDay: day, monthlyInr: resourceMonthlyCost(r) }))
    .sort((a, b) => b.monthlyInr - a.monthlyInr);
  const newSet = new Set(newOnes.map((n) => n.id));
  const newDelta = weekSum(resources.filter((r) => newSet.has(r.id)), days - w) - weekSum(resources.filter((r) => newSet.has(r.id)), 0);
  const increase = lastWeekInr - firstWeekInr;
  const newShare = increase > 0 ? Math.min(100, (newDelta / increase) * 100) : 0;

  const byTeam = rows((r) => r.team);
  const byEnv = rows((r) => r.env);
  const top = waste[0];
  const headlines = [
    `The monthly bill is about ${inr(monthlyBillInr)}. ${inr(wasteEligibleInr)} of it (${((wasteEligibleInr / monthlyBillInr) * 100).toFixed(1)}%) is waste that passes every safety check${top ? ` — the largest part is ${CATEGORY_PHRASE[top.category]}, ${inr(top.eligibleInr)}` : ''}.`,
    `${inr(notClaimedInr)} of further proposed savings on ${notClaimed.length} resources is NOT claimed, because a safety check failed (peak load, or a running resource depends on it) or the data is not good enough.`,
    increase > 0
      ? `Spend rose ${pct.toFixed(1)}% from the first to the last week of the window (${inr(firstWeekInr)} → ${inr(lastWeekInr)}); ${newShare.toFixed(0)}% of that increase comes from ${newOnes.length} newly created resources; the biggest increase is in team "${byTeam[0].key}" (+${inr(byTeam[0].deltaInr)} per week).`
      : `Spend did not rise across the window (${inr(firstWeekInr)} → ${inr(lastWeekInr)}).`,
  ];

  return {
    monthlyBillInr,
    waste,
    wasteEligibleInr,
    wasteSharePct: round2((wasteEligibleInr / monthlyBillInr) * 100),
    notClaimedInr,
    notClaimedResources: notClaimed.length,
    growth: { firstWeekInr, lastWeekInr, pct: round2(pct), byTeam, byEnv, newResources: newOnes, newResourcesShareOfIncreasePct: round2(newShare) },
    headlines,
  };
}

export type Role = 'engineer' | 'finance' | 'leadership';

export interface RoleBrief {
  role: Role;
  title: string;
  points: string[];
}

/** The same numbers phrased for each audience (UTHO bonus: role-based views). Pure text from engine output. */
export function roleBrief(role: Role, input: { recs: readonly Recommendation[]; totals: Totals; bill: BillExplanation; alerts: readonly Alert[] }): RoleBrief {
  const { recs, totals, bill, alerts } = input;
  if (role === 'engineer') {
    const top = recs.filter((r) => r.eligible).sort((a, b) => b.monthlySavingInr - a.monthlySavingInr).slice(0, 5);
    const blockedResizes = recs.filter((r) => r.action.includes('resize') && r.verdict === 'FAIL_SAFETY_CHECKS').length;
    const critical = alerts.filter((a) => a.severity === 'critical');
    return {
      role,
      title: 'Engineer — what to change, and what not to touch',
      points: [
        ...top.map((r) => `${r.resourceName}: ${r.action}${r.proposed.size ? ` → ${r.proposed.size.vcpu} vCPU / ${r.proposed.size.ramGb} GB` : ''}, saves ${inr(r.monthlySavingInr)}/month, risk ${r.risk}${r.requiresHumanReview ? ', needs human confirmation first' : ''}.`),
        `${blockedResizes} resize${blockedResizes === 1 ? ' was' : 's were'} blocked because the VM would fail at its peak (p95/p99/max checks).`,
        `${critical.length} critical alert${critical.length === 1 ? '' : 's'}${critical.length ? ': ' + critical.map((a) => a.title).join('; ') : ''}.`,
      ],
    };
  }
  if (role === 'finance') {
    const envs = (Object.keys(totals.byEnv) as Env[]).map((e) => `${e} ${inr(totals.byEnv[e].originalInr)} → ${inr(totals.byEnv[e].originalInr - totals.byEnv[e].eligibleInr)}`);
    return {
      role,
      title: 'Finance — before vs after, and why the bill grew',
      points: [
        `Current monthly bill ${inr(totals.originalInr)}; safe-to-act savings ${inr(totals.eligibleInr)}; approved so far ${inr(totals.approvedInr)} → projected bill ${inr(totals.projectedInr)}.`,
        `By environment (now → after all safe savings): ${envs.join(' · ')}.`,
        bill.headlines[2],
        'All figures are projections from synthetic data and illustrative prices — not realised savings.',
      ],
    };
  }
  return {
    role,
    title: 'Leadership — three answers',
    points: [
      `Where the money goes: ${bill.headlines[0]}`,
      `Why it grew: ${bill.headlines[2]}`,
      `What we will not do: ${inr(bill.notClaimedInr)} of tempting cuts are held back because they would risk outages or rest on weak data. Every change needs a human approval.`,
    ],
  };
}
