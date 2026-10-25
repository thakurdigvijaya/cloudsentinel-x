// Prints the engine's decisions for the fixture servers — no UI needed.
// Run: npm run report   (or: tsx scripts/report.ts)
import { buildFixtures } from '../src/data/fixtures';
import { aggregate, analyzeAll } from '../src/engine';

const { resources, series } = buildFixtures();
const { recommendations, invalid, alerts } = analyzeAll(resources, series);

const short: Record<string, string> = {
  PASS_UNDER_TESTED_CONDITIONS: 'PASS',
  FAIL_SAFETY_CHECKS: 'FAIL',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT',
  NO_ACTION: '—',
};
const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });

console.log('CloudSentinel X — fixture report (SYNTHETIC DATA · illustrative pricing)\n');
console.log(['server'.padEnd(20), 'action'.padEnd(16), 'saving/mo'.padStart(10), 'verdict'.padEnd(13), 'reason'].join('  '));
for (const rec of recommendations) {
  console.log(
    [
      rec.resourceId.padEnd(20),
      rec.action.padEnd(16),
      (rec.monthlySavingInr ? inr(rec.monthlySavingInr) : '—').padStart(10),
      short[rec.verdict].padEnd(13),
      rec.reasons[rec.reasons.length > 1 && rec.verdict === 'FAIL_SAFETY_CHECKS' ? 1 : 0],
    ].join('  '),
  );
}
if (invalid.length) console.log('\nInvalid inputs:', invalid);

const t = aggregate(resources, recommendations, {});
console.log(`\nCurrent monthly cost: ${inr(t.originalInr)}`);
console.log(`Candidate savings (all proposals): ${inr(t.candidateInr)}`);
console.log(`Eligible savings (PASS only):      ${inr(t.eligibleInr)}`);
console.log(`Approved savings:                  ${inr(t.approvedInr)}`);
console.log(`\nAlerts (${alerts.length}):`);
for (const a of alerts) console.log(`  [${a.severity}] ${a.title} — ${a.why}`);
