// Bring your own data (assumptions §W). Imports an inventory + metrics (CSV or JSON) into the engine's types,
// with row-level errors. Also the inverse (datasetToCsv) so the sample files and the round-trip test use one format.
//
// Inventory CSV columns (header names, any order, case-insensitive):
//   id, name, type (vm | volume | ip), region (noida | bengaluru/bangalore | mumbai), env (prod | staging | dev), team,
//   created_at (YYYY-MM-DD), vcpu, ram_gb, disk_gb, attached_to, detached_days, depends_on (ids separated by ';')
// Metrics CSV (long format, one row per resource per timestamp):
//   resource_id, timestamp (ISO 8601 with offset, e.g. 2026-09-07T10:15:00+05:30), cpu_pct, mem_pct, disk_pct, iops,
//   net_in_mbps, net_out_mbps — empty cell = missing sample.
// Samples at 5–15 minute granularity are put on the engine's 15-minute grid using the MAX in each slot
// (conservative: a short peak is never averaged away).
import { CONFIG } from './config';
import { validateResource, validateSeries } from './validate';
import type { Env, MetricSeries, Region, Resource, ResourceType } from './types';

export interface ImportIssue {
  file: 'inventory' | 'metrics' | 'json';
  line: number | null;
  field?: string;
  message: string;
}

export interface ImportResult {
  ok: boolean;
  resources: Resource[];
  series: Map<string, MetricSeries>;
  start: string | null;
  days: number;
  errors: ImportIssue[];
  warnings: ImportIssue[];
}

const STEP_MS = CONFIG.time.stepMinutes * 60 * 1000;
const MAX_ERRORS = 50;

/** RFC 4180 CSV → rows of cells. Handles quotes, doubled quotes, commas/newlines inside quotes, CRLF and a BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  // drop blank lines and comment lines starting with '#'
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === '') && !r[0]?.startsWith('#'));
}

const REGION_ALIASES: Record<string, Region> = { noida: 'noida', bengaluru: 'bengaluru', bangalore: 'bengaluru', mumbai: 'mumbai', bombay: 'mumbai' };
const TYPE_ALIASES: Record<string, ResourceType> = { vm: 'vm', 'virtual machine': 'vm', volume: 'volume', 'block volume': 'volume', ip: 'ip', 'public ip': 'ip' };
const ENVS: Env[] = ['prod', 'staging', 'dev'];
const ENV_ALIASES: Record<string, Env> = { production: 'prod', development: 'dev', stage: 'staging' };

function headerIndex(header: string[]): Map<string, number> {
  return new Map(header.map((h, i) => [h.trim().toLowerCase().replace(/\s+/g, '_'), i]));
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function importInventoryCsv(text: string): { resources: Resource[]; errors: ImportIssue[] } {
  const rows = parseCsv(text);
  const errors: ImportIssue[] = [];
  if (rows.length === 0) return { resources: [], errors: [{ file: 'inventory', line: null, message: 'Inventory file is empty.' }] };
  const h = headerIndex(rows[0]);
  for (const col of ['id', 'name', 'type', 'region', 'env', 'team', 'created_at']) {
    if (!h.has(col)) errors.push({ file: 'inventory', line: 1, field: col, message: `Missing required column "${col}".` });
  }
  if (errors.length) return { resources: [], errors };
  const get = (r: string[], c: string) => (h.has(c) ? (r[h.get(c)!] ?? '').trim() : '');
  const seen = new Set<string>();
  const resources: Resource[] = [];
  rows.slice(1).forEach((r, k) => {
    const line = k + 2;
    const err = (field: string, message: string) => errors.length < MAX_ERRORS && errors.push({ file: 'inventory', line, field, message });
    const id = get(r, 'id');
    const type = TYPE_ALIASES[get(r, 'type').toLowerCase()];
    const region = REGION_ALIASES[get(r, 'region').toLowerCase()];
    const envRaw = get(r, 'env').toLowerCase();
    const env = (ENVS as string[]).includes(envRaw) ? (envRaw as Env) : ENV_ALIASES[envRaw];
    const created = get(r, 'created_at');
    let bad = false;
    if (!id) { err('id', 'Resource id is required.'); bad = true; }
    if (!get(r, 'name')) { err('name', 'Resource name is required, not an invented fallback.'); bad = true; }
    if (!get(r, 'team')) { err('team', 'Owner/team is required, not an invented fallback.'); bad = true; }
    else if (seen.has(id)) { err('id', `Duplicate resource id "${id}".`); bad = true; }
    if (!type) { err('type', `Unknown type "${get(r, 'type')}" (use vm, volume or ip).`); bad = true; }
    if (!region) { err('region', `Unknown region "${get(r, 'region')}" (use Noida, Bengaluru/Bangalore or Mumbai).`); bad = true; }
    if (!env) { err('env', `Unknown environment "${get(r, 'env')}" (use prod, staging or dev).`); bad = true; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(created) || !Number.isFinite(Date.parse(created))) { err('created_at', `Invalid date "${created}" (use YYYY-MM-DD).`); bad = true; }
    const vcpu = num(get(r, 'vcpu'));
    const ramGb = num(get(r, 'ram_gb'));
    const diskGb = num(get(r, 'disk_gb'));
    const detachedDays = num(get(r, 'detached_days'));
    for (const [f, v] of [['vcpu', vcpu], ['ram_gb', ramGb], ['disk_gb', diskGb], ['detached_days', detachedDays]] as const) {
      if (Number.isNaN(v)) { err(f, `"${get(r, f)}" is not a number.`); bad = true; }
    }
    if (type === 'vm' && (vcpu === undefined || ramGb === undefined)) { err('vcpu', 'A VM needs vcpu and ram_gb.'); bad = true; }
    if (type === 'vm' && diskGb === undefined) { err('disk_gb', 'A VM needs its boot disk inventory size; the cost model still excludes its charge.'); bad = true; }
    if (type === 'volume' && diskGb === undefined) { err('disk_gb', 'A volume needs disk_gb.'); bad = true; }
    if (bad) return;
    seen.add(id);
    const attached = get(r, 'attached_to');
    const deps = get(r, 'depends_on').split(';').map((x) => x.trim()).filter(Boolean);
    resources.push({
      id, name: get(r, 'name'), type: type!, region: region!, env: env!, team: get(r, 'team'), createdAt: created,
      ...(vcpu !== undefined ? { vcpu } : {}), ...(ramGb !== undefined ? { ramGb } : {}), ...(diskGb !== undefined ? { diskGb } : {}),
      ...(type !== 'vm' ? { attachedTo: attached || null, detachedDays: detachedDays ?? 0 } : {}),
      ...(deps.length ? { dependsOn: deps } : {}),
      pattern: 'imported',
    });
  });
  // dependency ids must exist
  const ids = new Set(resources.map((r) => r.id));
  for (const r of resources) {
    for (const dep of r.dependsOn ?? []) {
      if (!ids.has(dep)) errors.length < MAX_ERRORS && errors.push({ file: 'inventory', line: null, field: 'depends_on', message: `${r.id} depends on unknown resource "${dep}".` });
    }
  }
  return { resources, errors };
}

const METRIC_COLS = [
  ['cpu_pct', 'cpuPct', true],
  ['mem_pct', 'memPct', true],
  ['disk_pct', 'diskPct', true],
  ['iops', 'iops', false],
  ['net_in_mbps', 'netInMbps', false],
  ['net_out_mbps', 'netOutMbps', false],
] as const;

type SeriesKey = (typeof METRIC_COLS)[number][1];

export function importMetricsCsv(
  text: string,
  vmIds: ReadonlySet<string>,
): { series: Map<string, MetricSeries>; start: string | null; days: number; errors: ImportIssue[]; warnings: ImportIssue[] } {
  const rows = parseCsv(text);
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const fail = (message: string, line: number | null = null, field?: string) => ({ series: new Map(), start: null, days: 0, errors: [{ file: 'metrics' as const, line, field, message }], warnings });
  if (rows.length < 2) return fail('Metrics file has no data rows.');
  const h = headerIndex(rows[0]);
  for (const col of ['resource_id', 'timestamp', 'cpu_pct', 'mem_pct']) if (!h.has(col)) return fail(`Missing required column "${col}".`, 1, col);

  // pass 1: parse + validate rows
  type Row = { id: string; t: number; v: Partial<Record<SeriesKey, number | null>> };
  const parsed: Row[] = [];
  const unknown = new Set<string>();
  rows.slice(1).forEach((r, k) => {
    const line = k + 2;
    const err = (field: string, message: string) => errors.length < MAX_ERRORS && errors.push({ file: 'metrics', line, field, message });
    const id = (r[h.get('resource_id')!] ?? '').trim();
    if (!vmIds.has(id)) { unknown.add(id); return; }
    const ts = (r[h.get('timestamp')!] ?? '').trim();
    const t = Date.parse(ts);
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(ts) || !Number.isFinite(t)) { err('timestamp', `Invalid timestamp "${ts}" (ISO 8601 with a time zone, e.g. 2026-09-07T10:15:00+05:30).`); return; }
    const v: Row['v'] = {};
    for (const [col, key, isPct] of METRIC_COLS) {
      if (!h.has(col)) continue;
      const raw = (r[h.get(col)!] ?? '').trim();
      if (raw === '') { v[key] = null; continue; }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || (isPct && n > 100)) { err(col, `"${raw}" is out of range${isPct ? ' (0–100)' : ' (≥ 0)'}.`); return; }
      v[key] = n;
    }
    parsed.push({ id, t, v });
  });
  for (const id of unknown) warnings.push({ file: 'metrics', line: null, field: 'resource_id', message: `Rows for "${id}" ignored: not a VM in the inventory.` });
  if (parsed.length === 0) return { series: new Map(), start: null, days: 0, errors: errors.length ? errors : [{ file: 'metrics', line: null, message: 'No usable metric rows.' }], warnings };

  // granularity: median gap between consecutive timestamps of one resource must be 5–15 minutes
  const byRes = new Map<string, number[]>();
  for (const p of parsed) {
    let list = byRes.get(p.id);
    if (!list) byRes.set(p.id, (list = []));
    list.push(p.t);
  }
  const gaps: number[] = [];
  for (const ts of byRes.values()) {
    const s = [...new Set(ts)].sort((a, b) => a - b);
    for (let i = 1; i < s.length; i++) gaps.push(s[i] - s[i - 1]);
  }
  gaps.sort((a, b) => a - b);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : STEP_MS;
  if (median > STEP_MS) errors.push({ file: 'metrics', line: null, message: `Samples are every ${Math.round(median / 60000)} minutes; the engine needs 15 minutes or finer.` });
  if (median < 60000) warnings.push({ file: 'metrics', line: null, message: 'Samples are less than a minute apart; they are combined per 15-minute slot (max).' });

  // pass 2: put everything on one shared 15-minute grid (every series starts at the same slot)
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const p of parsed) {
    if (p.t < tMin) tMin = p.t;
    if (p.t > tMax) tMax = p.t;
  }
  const t0 = Math.floor(tMin / STEP_MS) * STEP_MS;
  const t1 = tMax;
  const n = Math.floor((t1 - t0) / STEP_MS) + 1;
  const empty = () => new Array<number | null>(n).fill(null);
  const series = new Map<string, MetricSeries>();
  const startIso = new Date(t0).toISOString();
  for (const id of byRes.keys()) {
    series.set(id, { resourceId: id, start: startIso, stepMinutes: CONFIG.time.stepMinutes, cpuPct: empty(), memPct: empty(), diskPct: empty(), iops: empty(), netInMbps: empty(), netOutMbps: empty() });
  }
  for (const p of parsed) {
    const s = series.get(p.id)!;
    const i = Math.floor((p.t - t0) / STEP_MS);
    for (const [, key] of METRIC_COLS) {
      const v = p.v[key];
      if (v === undefined || v === null) continue;
      const cur = s[key][i];
      s[key][i] = cur === null ? v : Math.max(cur, v); // MAX per slot: peaks are never averaged away
    }
  }
  const days = n / CONFIG.time.samplesPerDay;
  if (days < CONFIG.foresight.minHistoryDays) warnings.push({ file: 'metrics', line: null, message: `Only ${days.toFixed(1)} days of data; recommendations need ${CONFIG.foresight.minHistoryDays}+ days and will show INSUFFICIENT EVIDENCE.` });
  for (const id of vmIds) if (!series.has(id)) warnings.push({ file: 'metrics', line: null, field: 'resource_id', message: `VM "${id}" has no metric rows; it cannot be analysed.` });
  return { series, start: startIso, days, errors, warnings };
}

/** One call for the API / UI: inventory CSV + metrics CSV → engine input, with every problem listed. */
export function importCsvDataset(inventoryCsv: string, metricsCsv: string): ImportResult {
  const inv = importInventoryCsv(inventoryCsv);
  const vmIds = new Set(inv.resources.filter((r) => r.type === 'vm').map((r) => r.id));
  const met = vmIds.size ? importMetricsCsv(metricsCsv, vmIds) : { series: new Map<string, MetricSeries>(), start: null, days: 0, errors: [{ file: 'metrics' as const, line: null, message: 'No valid VMs in the inventory.' }], warnings: [] };
  const errors = [...inv.errors, ...met.errors];
  return { ok: errors.length === 0, resources: inv.resources, series: met.series, start: met.start, days: met.days, errors, warnings: met.warnings };
}

/** JSON import: { resources: Resource[], series: MetricSeries[] } (the engine's own types). */
export function importJsonDataset(json: string): ImportResult {
  const fail = (message: string): ImportResult => ({ ok: false, resources: [], series: new Map(), start: null, days: 0, errors: [{ file: 'json', line: null, message }], warnings: [] });
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch (e) { return fail(`Not valid JSON: ${(e as Error).message}`); }
  if (!parsed || typeof parsed !== 'object') return fail('Expected a JSON object with resources and series arrays.');
  const data = parsed as { resources?: unknown; series?: unknown };
  if (!Array.isArray(data.resources) || !Array.isArray(data.series)) return fail('Expected { "resources": [...], "series": [...] }.');
  if (data.resources.length > 10000 || data.series.length > 10000) return fail('Dataset exceeds the 10,000 resource limit.');
  const resources: Resource[] = [];
  const seenResources = new Set<string>();
  const errors: ImportIssue[] = [];
  const err = (msg: string) => { if (errors.length < MAX_ERRORS) errors.push({ file: 'json', line: null, message: msg }); };
  for (const raw of data.resources) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { err('Resource must be an object.'); continue; }
    const r = raw as Resource;
    if (typeof r.id !== 'string' || !r.id.trim()) { err('Resource ID must be a non-empty string.'); continue; }
    if (seenResources.has(r.id)) { err(`Duplicate resource ID ${r.id}.`); continue; }
    seenResources.add(r.id);
    if (typeof r.name !== 'string' || !r.name.trim()) err(`${r.id}: name must be a non-empty string.`);
    if (typeof r.team !== 'string' || !r.team.trim()) err(`${r.id}: team must be a non-empty string.`);
    if (typeof r.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.createdAt) || !Number.isFinite(Date.parse(r.createdAt)))
      err(`${r.id}: createdAt must be a valid YYYY-MM-DD date.`);
    if (r.dependsOn !== undefined && (!Array.isArray(r.dependsOn) || r.dependsOn.some(x => typeof x !== 'string')))
      err(`${r.id}: dependsOn must be a list of resource ID strings.`);
    for (const issue of validateResource(r)) err(`${r.id}: ${issue.field} — ${issue.message}`);
    resources.push(r);
  }
  const known = new Set(resources.map(r => r.id));
  for (const r of resources) for (const id of (Array.isArray(r.dependsOn) ? r.dependsOn : [])) {
    if (!known.has(id)) err(`${r.id} depends on unknown resource ${id}.`);
  }
  const series = new Map<string, MetricSeries>();
  const starts = new Set<string>();
  for (const raw of data.series) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { err('Metric series must be an object.'); continue; }
    const s = raw as MetricSeries;
    if (typeof s.resourceId !== 'string' || !known.has(s.resourceId)) { err('Metric series has an unknown resource ID.'); continue; }
    if (series.has(s.resourceId)) { err(`Duplicate series for ${s.resourceId}.`); continue; }
    if (!Array.isArray(s.cpuPct) || !Array.isArray(s.memPct) || !Array.isArray(s.diskPct) ||
        !Array.isArray(s.iops) || !Array.isArray(s.netInMbps) || !Array.isArray(s.netOutMbps)) {
      err(`${s.resourceId}: CPU, memory, disk, IOPS and network must all be arrays.`); continue;
    }
    for (const issue of validateSeries(s)) err(`${s.resourceId}: ${issue.field} — ${issue.message}`);
    series.set(s.resourceId, s);
    starts.add(s.start);
  }
  if (starts.size > 1) err('All series must share the same start timestamp.');
  for (const r of resources) if (r.type === 'vm' && !series.has(r.id)) err(`VM ${r.id} has no metrics series.`);
  if (errors.length) return { ok: false, resources: [], series: new Map(), start: null, days: 0, errors, warnings: [] };
  const first = [...series.values()][0];
  return { ok: true, resources, series, start: first?.start ?? null,
    days: first ? first.cpuPct.length / CONFIG.time.samplesPerDay : 0, errors: [], warnings: [] };
}

/** Inverse of importCsvDataset (sample files, round-trip test). Timestamps are written in IST. */
export function datasetToCsv(resources: readonly Resource[], series: ReadonlyMap<string, MetricSeries>): { inventoryCsv: string; metricsCsv: string } {
  const q = (v: unknown) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const inv = ['id,name,type,region,env,team,created_at,vcpu,ram_gb,disk_gb,attached_to,detached_days,depends_on'];
  for (const r of resources) {
    inv.push([r.id, r.name, r.type, r.region, r.env, r.team, r.createdAt, r.vcpu, r.ramGb, r.diskGb, r.attachedTo, r.type === 'vm' ? '' : r.detachedDays, (r.dependsOn ?? []).join(';')].map(q).join(','));
  }
  const met = ['resource_id,timestamp,cpu_pct,mem_pct,disk_pct,iops,net_in_mbps,net_out_mbps'];
  const IST = 5.5 * 3600 * 1000;
  const p2 = (x: number) => String(x).padStart(2, '0');
  for (const [id, s] of series) {
    const t0 = Date.parse(s.start);
    for (let i = 0; i < s.cpuPct.length; i++) {
      const vals = [s.cpuPct[i], s.memPct[i], s.diskPct[i], s.iops[i], s.netInMbps[i], s.netOutMbps[i]];
      if (vals.every((v) => v === null)) continue;
      const d = new Date(t0 + i * STEP_MS + IST);
      const ts = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:00+05:30`;
      met.push([id, ts, ...vals.map((v) => (v === null ? '' : v))].join(','));
    }
  }
  return { inventoryCsv: inv.join('\n') + '\n', metricsCsv: met.join('\n') + '\n' };
}
