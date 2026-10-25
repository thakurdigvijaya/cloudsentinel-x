// Bring your own data (assumptions §W): CSV/JSON import with row-level errors, and a full round trip.
import { describe, expect, it } from 'vitest';
import { generateDataset } from '../../data/generator';
import { aggregate, analyzeAll } from '../index';
import { datasetToCsv, importCsvDataset, importInventoryCsv, importJsonDataset, importMetricsCsv, parseCsv } from '../importer';
import { slotOffset } from '../time';

describe('CSV parsing', () => {
  it('quotes, doubled quotes, commas and newlines in quotes, CRLF, BOM, comments and blank lines', () => {
    const rows = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n# comment\n\n"multi\nline",2\n');
    expect(rows).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['multi\nline', '2']]);
  });
});

describe('Inventory import', () => {
  const header = 'id,name,type,region,env,team,created_at,vcpu,ram_gb,disk_gb,attached_to,detached_days,depends_on';
  it('accepts aliases (Bangalore, production, Block Volume) and depends_on lists', () => {
    const { resources, errors } = importInventoryCsv(
      `${header}\nvm-1,api,VM,Bangalore,production,pay,2026-01-01,4,16,100,,,vm-2\nvm-2,db,vm,Mumbai,prod,pay,2026-01-01,8,32,100,,,\nv-1,disk,Block Volume,Noida,dev,pay,2026-01-01,,,200,,30,\n`,
    );
    expect(errors).toEqual([]);
    expect(resources.map((r) => [r.id, r.type, r.region, r.env])).toEqual([['vm-1', 'vm', 'bengaluru', 'prod'], ['vm-2', 'vm', 'mumbai', 'prod'], ['v-1', 'volume', 'noida', 'dev']]);
    expect(resources[0].dependsOn).toEqual(['vm-2']);
    expect(resources[2]).toMatchObject({ attachedTo: null, detachedDays: 30, diskGb: 200 });
  });
  it('reports every bad row with line number and field, and skips it', () => {
    const { resources, errors } = importInventoryCsv(
      `${header}\nvm-1,a,vm,Delhi,prod,t,2026-01-01,4,16,100,,,\nvm-1,b,vm,Noida,prod,t,2026-01-01,4,16,100,,,\nvm-1,c,vm,Noida,qa,t,01/02/2026,four,16,100,,,\nvm-3,d,vm,Noida,dev,t,2026-01-01,4,,100,,,\nvm-4,e,vm,Noida,dev,t,2026-01-01,4,16,100,,,ghost\n`,
    );
    const at = (line: number) => errors.filter((e) => e.line === line).map((e) => e.field);
    expect(at(2)).toEqual(['region']);
    expect(at(4)).toEqual(expect.arrayContaining(['id', 'env', 'created_at', 'vcpu'])); // vm-1 again → duplicate
    expect(at(5)).toEqual(['vcpu']); // VM without ram_gb
    expect(errors.some((e) => e.field === 'depends_on' && /unknown resource "ghost"/.test(e.message))).toBe(true); // missing provider remains a hard error
    // line 2 is rejected (Delhi), so line 3's vm-1 is the first valid one; line 4 is the duplicate
    expect(resources.map((r) => r.id)).toEqual(['vm-1', 'vm-4']);
    expect(at(3)).toEqual([]);
    expect(errors.find((e) => e.line === 4 && e.field === 'id')!.message).toMatch(/Duplicate/);
  });
  it('missing required columns are reported before anything else', () => {
    expect(importInventoryCsv('id,name\nx,y\n').errors.map((e) => e.field)).toEqual(['type', 'region', 'env', 'team', 'created_at']);
  });
});

describe('Metrics import', () => {
  const ids = new Set(['vm-1']);
  const head = 'resource_id,timestamp,cpu_pct,mem_pct,disk_pct,iops,net_in_mbps,net_out_mbps';
  it('5-minute data → 15-minute slots using the MAX (a short peak survives)', () => {
    const { series, errors } = importMetricsCsv(
      `${head}\nvm-1,2026-09-07T10:00:00+05:30,10,40,,,,\nvm-1,2026-09-07T10:05:00+05:30,95,41,,,,\nvm-1,2026-09-07T10:10:00+05:30,12,39,,,,\nvm-1,2026-09-07T10:15:00+05:30,11,40,,,,\n`,
      ids,
    );
    expect(errors).toEqual([]);
    const s = series.get('vm-1')!;
    expect(s.cpuPct).toEqual([95, 11]);
    expect(s.memPct).toEqual([41, 40]);
    expect(s.diskPct).toEqual([null, null]); // empty cells = missing, never 0
  });
  it('series may start on any 15-minute slot: weekday/hour stay correct (Thursday 10:00 IST)', () => {
    const { start } = importMetricsCsv(`${head}\nvm-1,2026-09-10T10:00:00+05:30,10,40,,,,\nvm-1,2026-09-10T10:15:00+05:30,10,40,,,,\n`, ids);
    expect(slotOffset(start!)).toBe(3 * 96 + 40); // Thursday = 3, 10:00 = slot 40
  });
  it('rejects bad rows (range, timestamp without zone), warns on unknown resources, and refuses hourly data', () => {
    const r = importMetricsCsv(`${head}\nvm-1,2026-09-07T10:00:00+05:30,140,40,,,,\nvm-1,2026-09-07 10:15,10,40,,,,\nvm-9,2026-09-07T10:00:00Z,1,1,,,,\n`, ids);
    expect(r.errors.map((e) => [e.line, e.field])).toEqual([[2, 'cpu_pct'], [3, 'timestamp']]);
    expect(r.warnings.some((w) => /"vm-9" ignored/.test(w.message))).toBe(true);
    const hourly = importMetricsCsv(`${head}\nvm-1,2026-09-07T10:00:00Z,1,40,,,,\nvm-1,2026-09-07T11:00:00Z,1,40,,,,\nvm-1,2026-09-07T12:00:00Z,1,40,,,,\n`, ids);
    expect(hourly.errors[0].message).toMatch(/every 60 minutes; the engine needs 15 minutes or finer/);
  });
  it('short history is a warning (engine will say INSUFFICIENT EVIDENCE), not a crash', () => {
    const r = importMetricsCsv(`${head}\nvm-1,2026-09-07T10:00:00Z,1,40,,,,\nvm-1,2026-09-07T10:15:00Z,1,40,,,,\n`, ids);
    expect(r.warnings.some((w) => /days of data/.test(w.message))).toBe(true);
  });
});

describe('Round trip: generated dataset → CSV → import → identical analysis', () => {
  it('every recommendation, verdict, saving and total is unchanged', () => {
    const d = generateDataset();
    const { inventoryCsv, metricsCsv } = datasetToCsv(d.resources, d.series);
    const imp = importCsvDataset(inventoryCsv, metricsCsv);
    expect(imp.errors).toEqual([]);
    expect(imp.ok).toBe(true);
    expect(imp.days).toBe(30);
    const a = analyzeAll(d.resources, d.series);
    const b = analyzeAll(imp.resources, imp.series);
    const key = (x: typeof a.recommendations[number]) => [x.resourceId, x.action, x.verdict, x.monthlySavingInr, x.scheduleWindow ?? ''].join('|');
    expect(b.recommendations.map(key)).toEqual(a.recommendations.map(key));
    expect(b.alerts.map((x) => x.id).sort()).toEqual(a.alerts.map((x) => x.id).sort());
    const ta = aggregate(d.resources, a.recommendations, {});
    const tb = aggregate(imp.resources, b.recommendations, {});
    expect(tb.eligibleInr).toBeCloseTo(ta.eligibleInr, 2);
    expect(tb.originalInr).toBeCloseTo(ta.originalInr, 2);
  });
});

describe('JSON import', () => {
  it('accepts the engine types and rejects malformed input with a clear message', () => {
    const d = generateDataset();
    // Import a dependency-closed three-VM subset, with series selected by resource ID.
    // Truncating arbitrary positions can leave dangling dependsOn IDs and must fail.
    const selected = d.resources.filter((r) => r.type === 'vm' && !r.dependsOn?.length).slice(0, 3);
    expect(selected).toHaveLength(3);
    const metrics = selected.map((r) => d.series.get(r.id)!);
    const ok = importJsonDataset(JSON.stringify({ resources: selected, series: metrics }));
    expect(ok.ok).toBe(true);
    expect(ok.resources.map((r) => r.id)).toEqual(selected.map((r) => r.id));
    const dangling = importJsonDataset(JSON.stringify({
      resources: [{ ...selected[0], dependsOn: ['resource-not-imported'] }, ...selected.slice(1)], series: metrics,
    }));
    expect(dangling.ok).toBe(false);
    expect(dangling.errors.some((e) => /depends on unknown resource/.test(e.message))).toBe(true);
    expect(importJsonDataset('{oops').errors[0].message).toMatch(/Not valid JSON/);
    expect(importJsonDataset('{"resources": 1}').errors[0].message).toMatch(/Expected/);
  });
});
