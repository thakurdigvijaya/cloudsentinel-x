// Bonus: export as CSV report and illustrative change script (assumptions §U).
import { describe, expect, it } from 'vitest';
import { buildFixtures } from '../../data/fixtures';
import { analyzeAll } from '../index';
import { approve, reject, type Decisions } from '../decisions';
import { changeScript, csvCell, recommendationsToCsv } from '../export';

const { resources, series } = buildFixtures();
const recs = analyzeAll(resources, series).recommendations;
const rec = (id: string) => recs.find((r) => r.resourceId === id)!;
const AT = '2026-10-24T10:00:00Z';

/** Minimal RFC 4180 parser for the test: handles quotes, doubled quotes and commas inside quotes. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

describe('CSV report', () => {
  const csv = recommendationsToCsv(recs);
  const lines = csv.trim().split('\n');
  const header = parseCsvLine(lines[1]);

  it('starts with the synthetic-data disclaimer, then one row per recommendation', () => {
    expect(lines[0]).toMatch(/^# Synthetic data, illustrative pricing/);
    expect(lines).toHaveLength(2 + recs.length);
  });

  it('every row has the same number of columns, and savings round-trip exactly', () => {
    for (const l of lines.slice(2)) expect(parseCsvLine(l)).toHaveLength(header.length);
    const col = header.indexOf('monthly_saving_inr');
    const total = lines.slice(2).reduce((a, l) => a + Number(parseCsvLine(l)[col]), 0);
    expect(total).toBeCloseTo(recs.reduce((a, r) => a + r.monthlySavingInr, 0), 2);
  });

  it('escapes quotes, commas and newlines; neutralises formula injection', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('x\ny')).toBe('"x\ny"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell(-12.5)).toBe('-12.5'); // negative numbers stay numbers
  });

  it('records decisions and partial steps', () => {
    const conflict = rec('vm-stg-conflict');
    const d = approve({}, conflict, AT, ['schedule']).decisions;
    const row = recommendationsToCsv([conflict], d).trim().split('\n')[2];
    const cells = parseCsvLine(row);
    expect(cells[header.indexOf('decision')]).toBe('approved');
    expect(cells[header.indexOf('accepted_steps')]).toBe('schedule');
  });
});

describe('Change script (pseudo-commands)', () => {
  it('without decisions: only eligible recommendations, clearly labelled illustrative', () => {
    const s = changeScript(recs);
    expect(s).toMatch(/ILLUSTRATIVE .* NOT a real UTHO CLI; nothing is executed/);
    for (const r of recs.filter((x) => !x.eligible)) expect(s).not.toContain(`(${r.resourceId},`);
    for (const r of recs.filter((x) => x.eligible)) expect(s).toContain(`(${r.resourceId},`);
  });

  it('only APPROVED steps are scripted; partial approval → only the schedule lines', () => {
    const conflict = rec('vm-stg-conflict');
    let d: Decisions = approve({}, conflict, AT, ['schedule']).decisions;
    d = reject(d, rec('vm-dev-underutil'), AT).decisions;
    const s = changeScript(recs, d);
    expect(s).toContain('cloud vm stop --id vm-stg-conflict');
    expect(s).not.toContain('cloud vm resize --id vm-stg-conflict');
    expect(s).not.toContain('vm-dev-underutil');
  });

  it('volume deletion takes a snapshot first; shutdowns carry the pre-check', () => {
    const d = approve(approve({}, rec('vol-orphan'), AT).decisions, rec('vm-dev-idle'), AT).decisions;
    const s = changeScript(recs, d);
    expect(s.indexOf('cloud volume snapshot --id vol-orphan')).toBeLessThan(s.indexOf('cloud volume delete --id vol-orphan'));
    expect(s).toMatch(/PRE-CHECK: confirm with the owning team/);
  });

  it('nothing approved → says so', () => {
    expect(changeScript(recs, {})).toMatch(/# No approved changes\./);
  });
});
