// Bonus: export recommendations as a report (CSV) or as illustrative change scripts (assumptions §U).
// The scripts are PSEUDO-COMMANDS for human review — not a real UTHO CLI, not executable, nothing is changed.
import type { Decisions } from './decisions';
import { allSteps } from './plan';
import { sizeLabel } from './pricing';
import type { Recommendation } from './types';

const CSV_COLUMNS = [
  'resource_id', 'name', 'type', 'env', 'region', 'team', 'action', 'schedule_window', 'current_size', 'target_size',
  'current_monthly_inr', 'proposed_monthly_inr', 'monthly_saving_inr', 'verdict', 'risk', 'data_adequacy_score',
  'requires_human_review', 'decision', 'accepted_steps', 'saving_formula', 'reasons',
] as const;

/** RFC 4180 quoting: wrap in quotes when needed and double inner quotes. Also neutralise spreadsheet formulas. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function recommendationsToCsv(recs: readonly Recommendation[], decisions: Decisions = {}): string {
  const rows = recs.map((r) => {
    const d = decisions[r.id];
    return [
      r.resourceId, r.resourceName, r.resourceType, r.env, r.region, r.team, r.action, r.scheduleWindow ?? '',
      r.current.size ? sizeLabel(r.current.size) : '', r.proposed.size ? sizeLabel(r.proposed.size) : '',
      r.current.monthlyCostInr, r.proposed.monthlyCostInr, r.monthlySavingInr, r.verdict, r.risk,
      r.dataAdequacyScore.toFixed(2), r.requiresHumanReview, d?.status ?? 'pending',
      d?.status === 'approved' ? (d.acceptedSteps ?? allSteps(r)).join('+') : '', r.savingFormula, r.reasons.join(' | '),
    ].map(csvCell).join(',');
  });
  const header = '# Synthetic data, illustrative pricing (see assumptions.md). Savings are projections, not realised savings.';
  return [header, CSV_COLUMNS.join(','), ...rows].join('\n') + '\n';
}

/**
 * Pseudo-commands for the APPROVED steps only (or all eligible steps when `decisions` is omitted).
 * Every block starts with a pre-check comment; deletions take a snapshot first; schedules are cron lines in IST.
 */
export function changeScript(recs: readonly Recommendation[], decisions?: Decisions): string {
  const lines: string[] = [
    '# CloudSentinel X — ILLUSTRATIVE change plan (pseudo-commands, NOT a real UTHO CLI; nothing is executed).',
    '# Translate to your provider CLI / IaC after review. Synthetic data, illustrative pricing.',
    '',
  ];
  let count = 0;
  for (const r of recs) {
    let steps: string[];
    if (decisions) {
      const d = decisions[r.id];
      if (!d || d.status !== 'approved') continue;
      steps = d.acceptedSteps ?? allSteps(r);
    } else {
      if (!r.eligible) continue;
      steps = allSteps(r);
    }
    if (steps.length === 0) continue;
    count++;
    lines.push(`## ${r.resourceName} (${r.resourceId}, ${r.env}, ${r.region}) — saving ≈ ₹${r.monthlySavingInr}/month, verdict ${r.verdict}`);
    if (r.requiresHumanReview) lines.push('# PRE-CHECK: confirm with the owning team that nothing depends on this resource while it is off.');
    for (const s of r.steps.filter((x) => steps.includes(x.action))) {
      if (s.action === 'remove') {
        if (r.resourceType === 'volume') lines.push(`cloud volume snapshot --id ${r.resourceId}`, `cloud volume delete --id ${r.resourceId}`);
        else if (r.resourceType === 'ip') lines.push(`cloud ip release --id ${r.resourceId}`);
        else lines.push(`cloud vm stop --id ${r.resourceId}`);
      }
      if (s.action === 'resize' && s.size) {
        if (r.holdUntil) lines.push(`# UTSAV HOLD: do not apply before ${r.holdUntil} (an upcoming event would break the smaller size)`);
        lines.push(`cloud vm resize --id ${r.resourceId} --vcpu ${s.size.vcpu} --ram-gb ${s.size.ramGb}`);
      }
      if (s.action === 'schedule') {
        if (r.scheduleWindow === 'weekends') {
          lines.push(`# cron (IST): stop Saturday 00:00, start Monday 00:00`, `0 0 * * 6  cloud vm stop --id ${r.resourceId}`, `0 0 * * 1  cloud vm start --id ${r.resourceId}`);
        } else {
          lines.push(
            `# cron (IST): stop 20:00 Mon–Fri, start 08:00 Mon–Fri (stays off all weekend)`,
            `0 20 * * 1-5  cloud vm stop --id ${r.resourceId}`,
            `0 8 * * 1-5   cloud vm start --id ${r.resourceId}`,
          );
        }
      }
    }
    lines.push('');
  }
  if (count === 0) lines.push('# No approved changes.');
  return lines.join('\n');
}
