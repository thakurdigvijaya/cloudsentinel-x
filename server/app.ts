// CloudSentinel X API (assumptions §Y). Node's built-in http only — no framework, no dependencies.
// Every number comes from the same engine the UI uses; the server adds state (dataset, decisions, adopted
// scenario), persistence of decisions, and HTTP. Synthetic data and illustrative pricing unless a team imports its own.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { generateDataset } from '../src/data/generator';
import { hourlyMax } from '../src/lib/downsample';
import { breakPoint, closestCall, compareConfigurations, safeAlternative } from '../src/engine/challenge';
import { CONFIG } from '../src/engine/config';
import { adoptPlanningAssumptions, aggregate, approve, approveCoordinated, recheckApprovedDependencies, recheckApprovedEvidence, recheckHeldApprovals, reject, statusOf, type Decisions } from '../src/engine/decisions';
import { explainBill, roleBrief, type Role } from '../src/engine/explain';
import { changeScript, recommendationsToCsv } from '../src/engine/export';
import { forecastCapacity, forecastSpend } from '../src/engine/forecast';
import { importCsvDataset, importJsonDataset } from '../src/engine/importer';
import { analyzeAll, type Analysis } from '../src/engine/index';
import { buildPassport, passportToMarkdown } from '../src/engine/passport';
import { previewRecommendation, revalidate, SCENARIOS } from '../src/engine/scenarios';
import { dailySpend } from '../src/engine/spend';
import { fleetEnergy } from '../src/engine/sustainability';
import { fleetWhatIf, FLEET_WINDOWS, type FleetWindow } from '../src/engine/whatif';
import { applyUtsav, EVENT_PRESETS, utsavCheck, type PlannedEvent, type UtsavReport } from '../src/engine/utsav';
import { buildPortfolio, RISK_APPETITES, type RiskAppetite } from '../src/engine/portfolio';
import { evaluateProofGate } from '../src/engine/proofgate';
import type { Env, MetricSeries, Recommendation, Region, Resource, ScenarioId, StepAction } from '../src/engine/types';

export interface AppOptions {
  /** where approvals are saved; omit to keep them in memory only (tests) */
  decisionsFile?: string;
  /** largest accepted request body in bytes (default 50 MB, enough for a 15 MB metrics CSV) */
  maxBodyBytes?: number;
  /** Explicit allowed browser origin (default local Vite dev server); never a credentialed wildcard. */
  corsOrigin?: string;
  /** Optional bearer token for the local API; REQUIRED by launcher on any non-loopback bind. */
  apiToken?: string;
  /** Authenticated actor from the secure organization gateway; audit uses server-verified identity. */
  actorForRequest?: (req: IncomingMessage) => { id: string; email: string } | null;
}

interface Dataset {
  id: string;
  source: 'synthetic' | 'imported';
  resources: Resource[];
  series: Map<string, MetricSeries>;
  start: string;
  days: number;
}

interface HistoryEntry {
  at: string;
  recommendationId: string;
  action: 'approve' | 'reject' | 'adopt-flag' | 'reset';
  steps?: StepAction[];
  note?: string;
  actorId?: string;
  actorEmail?: string;
}

class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

const ENVS: Env[] = ['prod', 'staging', 'dev'];
const REGIONS: Region[] = ['noida', 'bengaluru', 'mumbai'];
const now = () => new Date().toISOString();

export function createApp(options: AppOptions = {}) {
  const maxBody = options.maxBodyBytes ?? 50 * 1024 * 1024;
  const cors = options.corsOrigin ?? 'http://localhost:5173';

  // ------------------------------------------------------------------ state
  // A separate, gzip-compressed snapshot restores the last API-imported dataset after restart.
  // Only enabled when a local decisionsFile was configured; isolated in-memory test servers stay unchanged.
  const importedSnapshot = options.decisionsFile ? `${options.decisionsFile}.import.json.gz` : null;
  function restoreSnapshot(): Dataset | null {
    if (!importedSnapshot || !existsSync(importedSnapshot)) return null;
    try {
      // Bound decompression to avoid accepting unexpectedly huge/corrupt local snapshots.
      const raw = gunzipSync(readFileSync(importedSnapshot), { maxOutputLength: 128 * 1024 * 1024 }).toString('utf8');
      const state = JSON.parse(raw) as { id?: string; resources?: Resource[]; series?: MetricSeries[] };
      if (!state.id || !state.id.startsWith('import-sha256-')) throw new Error('Dataset identifier is invalid.');
      const imported = importJsonDataset(JSON.stringify({ resources: state.resources, series: state.series }));
      if (!imported.ok) throw new Error('Dataset failed validation: ' + imported.errors[0]?.message);
      return { id: state.id, source: 'imported', resources: imported.resources, series: imported.series,
        start: imported.start ?? new Date().toISOString(), days: imported.days };
    } catch (err) {
      // Never silently use a damaged dataset or attach imported decisions to synthetic data.
      console.error('Ignored invalid imported dataset snapshot:', (err as Error).message);
      try { renameSync(importedSnapshot, `${importedSnapshot}.corrupt-${Date.now()}`); } catch { /* read-only disk */ }
      return null;
    }
  }
  function storeSnapshot(d: Dataset | null) {
    if (!importedSnapshot) return;
    if (!d || d.source !== 'imported') {
      if (existsSync(importedSnapshot)) rmSync(importedSnapshot);
      return;
    }
    const payload = JSON.stringify({ id: d.id, resources: d.resources, series: [...d.series.values()] });
    const tmp = `${importedSnapshot}.${randomUUID()}.tmp`;
    mkdirSync(dirname(importedSnapshot), { recursive: true });
    try {
      writeFileSync(tmp, gzipSync(payload));
      renameSync(tmp, importedSnapshot);
    } catch (error) {
      try { if (existsSync(tmp)) rmSync(tmp); } catch { /* cleanup best effort */ }
      throw error;
    }
  }

  let dataset: Dataset = restoreSnapshot() ?? synthetic();
  if (dataset.source === 'imported') for (const s of dataset.series.values()) s.analysisTime = now();
  let analysis: Analysis = analyzeAll(dataset.resources, dataset.series);
  let recs: Recommendation[] = analysis.recommendations; // may be revalidated by an adopted scenario
  let adoptedScenario: ScenarioId | null = null;
  let utsav: UtsavReport | null = null; // applied events (Utsav Mode), re-applied on top of the current recommendations
  let decisions: Decisions = {};
  let history: HistoryEntry[] = [];
  loadDecisions();

  function synthetic(): Dataset {
    const d = generateDataset();
    return { id: 'synthetic-2026', source: 'synthetic', resources: d.resources, series: d.series, start: d.start, days: 30 };
  }

  function setDataset(d: Dataset) {
    if (d.source === 'imported') {
      const analysisTime = now();
      for (const s of d.series.values()) s.analysisTime = analysisTime;
    }
    storeSnapshot(d);
    dataset = d;
    analysis = analyzeAll(d.resources, d.series);
    recs = analysis.recommendations;
    adoptedScenario = null;
    utsav = null;
    decisions = {};
    history = [];
    loadDecisions();
  }

  // Decisions persist per dataset id in one file: { datasets: { [id]: { decisions, history, adoptedScenario, utsav } } }.
  // Written atomically (temp file + rename), so a crash mid-write never leaves a half-written file.
  type SavedState = {
    decisions: Decisions;
    history: HistoryEntry[];
    savedAt: string;
    adoptedScenario?: ScenarioId | null;
    utsav?: { events: PlannedEvent[]; asOf: string } | null;
  };
  type SavedFile = { datasets: Record<string, SavedState> };

  /** the base recommendations re-checked under a scenario (no approval flagging: decisions are already saved) */
  function revalidatedFor(scenario: ScenarioId): Recommendation[] {
    const byId = new Map(
      analysis.recommendations
        .filter((r) => r.resourceType === 'vm' && dataset.series.has(r.resourceId))
        .map((r) => {
          const res = dataset.resources.find((x) => x.id === r.resourceId)!;
          return [r.id, revalidate(r, previewRecommendation(res, dataset.series.get(r.resourceId)!, r, scenario))] as const;
        }),
    );
    return analysis.recommendations.map((r) => byId.get(r.id) ?? r);
  }
  function readFile(): SavedFile {
    if (!options.decisionsFile || !existsSync(options.decisionsFile)) return { datasets: {} };
    try {
      const saved = JSON.parse(readFileSync(options.decisionsFile, 'utf8')) as Partial<SavedFile>;
      return { datasets: saved.datasets && typeof saved.datasets === 'object' ? saved.datasets : {} };
    } catch {
      // a corrupt file must never stop the API: start clean, keep the bad file for inspection
      renameSync(options.decisionsFile, `${options.decisionsFile}.corrupt-${Date.now()}`);
      return { datasets: {} };
    }
  }
  function loadDecisions() {
    const mine = readFile().datasets[dataset.id];
    if (!mine) return;
    const known = new Set(recs.map((r) => r.id));
    decisions = Object.fromEntries(Object.entries(mine.decisions ?? {}).filter(([id]) => known.has(id)));
    history = Array.isArray(mine.history) ? mine.history : [];
    // restore planning state: adopted scenario first, then Utsav holds on top
    if (mine.adoptedScenario && mine.adoptedScenario in SCENARIOS && mine.adoptedScenario !== 'normal') {
      adoptedScenario = mine.adoptedScenario;
      recs = revalidatedFor(mine.adoptedScenario);
    }
    if (mine.utsav && Array.isArray(mine.utsav.events)) {
      const rep = utsavCheck(dataset.resources, dataset.series, recs, mine.utsav.events, mine.utsav.asOf);
      if (rep.errors.length === 0) {
        utsav = rep;
        recs = applyUtsav(recs, rep);
      }
    }
    decisions = recheckHeldApprovals(recheckApprovedEvidence(recheckApprovedDependencies(decisions, { resources: dataset.resources, recommendations: recs }, now()), recs, now()), recs, now());
  }
  function saveDecisions() {
    if (!options.decisionsFile) return;
    const all = readFile();
    all.datasets[dataset.id] = { decisions, history, savedAt: now(), adoptedScenario, utsav: utsav ? { events: utsav.events, asOf: utsav.asOf } : null };
    mkdirSync(dirname(options.decisionsFile), { recursive: true });
    const tmp = `${options.decisionsFile}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2));
    renameSync(tmp, options.decisionsFile);
  }

  const totals = () => aggregate(dataset.resources, recs, decisions);
  /** keeps applied Utsav events in force when the recommendations are rebuilt (adopt / reset) */
  function reapplyUtsav(base: Recommendation[]): Recommendation[] {
    if (!utsav) return base;
    utsav = utsavCheck(dataset.resources, dataset.series, base, utsav.events, utsav.asOf);
    return applyUtsav(base, utsav);
  }
  const recById = (id: string) => recs.find((r) => r.id === id || r.resourceId === id);
  const resource = (id: string) => dataset.resources.find((r) => r.id === id);
  const needResource = (id: string) => {
    const r = resource(id);
    if (!r) throw new HttpError(404, `Unknown resource "${id}".`);
    return r;
  };
  const needRec = (id: string) => {
    const r = recById(id);
    if (!r) throw new HttpError(404, `Unknown recommendation or resource "${id}".`);
    return r;
  };
  const list = (v: string | null) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
  const datasetInfo = () => ({
    id: dataset.id, source: dataset.source, start: dataset.start, days: dataset.days,
    resources: dataset.resources.length, vms: dataset.resources.filter((r) => r.type === 'vm').length,
    label: dataset.source === 'synthetic' ? 'Synthetic data · illustrative pricing' : 'Imported data · illustrative pricing',
    adoptedScenario,
  });

  // ------------------------------------------------------------------ routes
  type Handler = (ctx: { url: URL; params: Record<string, string>; body: () => Promise<unknown>; text: () => Promise<string>; actor?: { id: string; email: string } | null }) => Promise<Reply> | Reply;
  type Reply = { status?: number; json?: unknown; text?: string; type?: string; filename?: string };
  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
  const route = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_m, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, pattern, keys, handler });
  };

  route('GET', '/api/health', () => ({ json: { ok: true, version: '1.0.0', dataset: datasetInfo() } }));

  route('GET', '/api/summary', () => {
    const t = totals();
    return {
      json: {
        dataset: datasetInfo(),
        totals: { originalInr: t.originalInr, candidateInr: t.candidateInr, eligibleInr: t.eligibleInr, approvedInr: t.approvedInr, projectedInr: t.projectedInr },
        byEnv: t.byEnv, byRegion: t.byRegion, needsReview: t.needsReview,
        counts: {
          recommendations: recs.filter((r) => r.action !== 'none').length,
          byVerdict: recs.reduce<Record<string, number>>((a, r) => ((a[r.verdict] = (a[r.verdict] ?? 0) + 1), a), {}),
          alerts: analysis.alerts.length, invalid: analysis.invalid.length,
        },
      },
    };
  });

  route('GET', '/api/recommendations', ({ url }) => {
    const env = list(url.searchParams.get('env'));
    const region = list(url.searchParams.get('region'));
    const team = list(url.searchParams.get('team'));
    const verdict = list(url.searchParams.get('verdict'));
    const actionable = url.searchParams.get('actionable') === 'true';
    const items = recs
      .filter((r) => (!env.length || env.includes(r.env)) && (!region.length || region.includes(r.region)) && (!team.length || team.includes(r.team)))
      .filter((r) => (!verdict.length || verdict.includes(r.verdict)) && (!actionable || r.action !== 'none'))
      .map((r) => ({ ...r, decision: decisions[r.id] ?? { status: statusOf(decisions, r.id) } }));
    return { json: { count: items.length, items } };
  });

  route('GET', '/api/resources', () => ({ json: { count: dataset.resources.length, items: dataset.resources } }));

  route('GET', '/api/resources/:id', ({ params, url }) => {
    const r = needResource(params.id);
    const s = dataset.series.get(r.id);
    const full = url.searchParams.get('resolution') === '15m';
    const pick = (v: (number | null)[]) => (full ? v : hourlyMax(v));
    return {
      json: {
        resource: r,
        recommendation: recs.find((x) => x.resourceId === r.id) ?? null,
        decision: decisions[`rec-${r.id}`] ?? null,
        alerts: analysis.alerts.filter((a) => a.resourceId === r.id),
        series: s ? { start: s.start, stepMinutes: full ? s.stepMinutes : 60, aggregation: full ? 'raw' : 'hourly max', cpuPct: pick(s.cpuPct), memPct: pick(s.memPct), netInMbps: pick(s.netInMbps), netOutMbps: pick(s.netOutMbps) } : null,
        capacityForecast: s && r.type === 'vm' ? { cpu: forecastCapacity(r, s, 'cpu'), memory: forecastCapacity(r, s, 'memory') } : null,
      },
    };
  });

  route('GET', '/api/alerts', () => ({ json: { count: analysis.alerts.length, items: analysis.alerts } }));

  route('GET', '/api/explain', ({ url }) => {
    const bill = explainBill(dataset.resources, recs, dataset.start, Math.round(dataset.days));
    const role = url.searchParams.get('role') as Role | null;
    const roles: Role[] = role ? [role] : ['engineer', 'finance', 'leadership'];
    if (role && !['engineer', 'finance', 'leadership'].includes(role)) throw new HttpError(400, 'role must be engineer, finance or leadership.');
    return { json: { bill, briefs: roles.map((r) => roleBrief(r, { recs, totals: totals(), bill, alerts: analysis.alerts })) } };
  });

  route('GET', '/api/whatif', ({ url }) => {
    const window = (url.searchParams.get('window') ?? 'nights') as FleetWindow;
    if (!(window in FLEET_WINDOWS)) throw new HttpError(400, `window must be one of ${Object.keys(FLEET_WINDOWS).join(', ')}.`);
    const env = list(url.searchParams.get('env')) as Env[];
    const region = list(url.searchParams.get('region')) as Region[];
    if (env.some((e) => !ENVS.includes(e))) throw new HttpError(400, 'Unknown env.');
    if (region.some((r) => !REGIONS.includes(r))) throw new HttpError(400, 'Unknown region.');
    return { json: fleetWhatIf(dataset.resources, dataset.series, window, { env, region, team: list(url.searchParams.get('team')) }) };
  });

  route('GET', '/api/forecast', () => {
    const t = totals();
    const spend = forecastSpend(dailySpend(dataset.resources, dataset.start, Math.round(dataset.days)), t.eligibleInr);
    const capacity = dataset.resources
      .filter((r) => r.type === 'vm' && dataset.series.has(r.id))
      .flatMap((r) => (['cpu', 'memory'] as const).map((m) => forecastCapacity(r, dataset.series.get(r.id)!, m)))
      .filter((f) => f !== null && f.daysToLimit !== null);
    return { json: { spend, capacityAtRisk: capacity } };
  });

  route('GET', '/api/sustainability', () => {
    const accepted = (r: Recommendation) => (decisions[r.id]?.status === 'approved' ? decisions[r.id].acceptedSteps ?? r.steps.map((s) => s.action) : []);
    return {
      json: {
        eligible: fleetEnergy(recs.filter((r) => r.eligible)),
        approved: fleetEnergy(recs.filter((r) => decisions[r.id]?.status === 'approved'), accepted),
      },
    };
  });

  route('POST', '/api/preview', async ({ body }) => {
    const b = (await body()) as { resourceId?: string; scenario?: ScenarioId };
    if (!b?.resourceId || !b.scenario || !(b.scenario in SCENARIOS)) throw new HttpError(400, `Body must be { resourceId, scenario } with scenario in ${Object.keys(SCENARIOS).join(', ')}.`);
    const r = needResource(b.resourceId);
    const s = dataset.series.get(r.id);
    if (!s) throw new HttpError(400, 'Only VMs with metrics can be previewed.');
    const rec = needRec(r.id);
    const before = totals();
    const p = previewRecommendation(r, s, rec, b.scenario);
    return { json: { preview: p, totalsUnchanged: JSON.stringify(totals()) === JSON.stringify(before) } };
  });

  route('GET', '/api/challenge/:id', ({ params, url }) => {
    const r = needResource(params.id);
    const s = dataset.series.get(r.id);
    if (!s || r.type !== 'vm') throw new HttpError(400, 'Challenge Lab works on VMs with metrics.');
    const rec = needRec(r.id);
    const current = { vcpu: r.vcpu!, ramGb: r.ramGb! };
    const target = rec.proposed.size && (rec.proposed.size.vcpu !== current.vcpu || rec.proposed.size.ramGb !== current.ramGb) ? rec.proposed.size : null;
    const scenario = (url.searchParams.get('scenario') ?? 'normal') as ScenarioId;
    if (!(scenario in SCENARIOS)) throw new HttpError(400, 'Unknown scenario.');
    return {
      json: {
        resourceId: r.id, target,
        closestCall: target ? closestCall(s, s.start, current, target, r.env) : null,
        breakPoint: target ? breakPoint(s, current, target, r.env) : null,
        safeAlternative: safeAlternative(s, current, target, r.env, r.region),
        comparison: compareConfigurations(r, s, scenario),
      },
    };
  });

  route('GET', '/api/passport/:id', ({ params, url }) => {
    const r = needResource(params.id);
    const rec = needRec(r.id);
    const p = buildPassport(r, dataset.series.get(r.id), rec, decisions[rec.id]);
    if (url.searchParams.get('format') === 'json') return { json: p };
    return { text: passportToMarkdown(p), type: 'text/markdown; charset=utf-8', filename: `passport-${r.id}.md` };
  });

  route('GET', '/api/proofgate/:id', ({ params }) => ({
    json: evaluateProofGate(needRec(params.id), dataset.resources, recs, decisions),
  }));

  route('GET', '/api/decisions', () => ({ json: { decisions, history, totals: totals() } }));

  route('POST', '/api/decisions', async ({ body, actor }) => {
    const b = (await body()) as { recommendationId?: string; action?: string; steps?: StepAction[]; note?: string };
    if (!b?.recommendationId || (b.action !== 'approve' && b.action !== 'reject')) throw new HttpError(400, 'Body must be { recommendationId, action: "approve" | "reject", steps?, note? }.');
    if (b.steps !== undefined && (!Array.isArray(b.steps) || b.steps.some((s) => typeof s !== 'string'))) throw new HttpError(400, 'steps must be an array of step names.');
    if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 1000)) throw new HttpError(400, 'note must be a string of at most 1000 characters.');
    const rec = needRec(b.recommendationId);
    const at = now();
    const result = b.action === 'approve' ? approve(decisions, rec, at, b.steps, { resources: dataset.resources, recommendations: recs }) : reject(decisions, rec, at, b.note);
    if (!result.ok) throw new HttpError(409, result.error ?? 'Not allowed.');
    decisions = recheckApprovedDependencies(result.decisions, { resources: dataset.resources, recommendations: recs }, at);
    history.push({ at, recommendationId: rec.id, action: b.action, steps: decisions[rec.id]?.acceptedSteps, note: b.note, actorId: actor?.id, actorEmail: actor?.email });
    saveDecisions();
    return { json: { decision: decisions[rec.id], totals: totals() } };
  });

  route('POST', '/api/decisions/bundle', async ({ body, actor }) => {
    const b = (await body()) as { items?: { recommendationId: string; steps: StepAction[] }[] };
    if (!Array.isArray(b?.items) || b.items.length < 2 || b.items.length > 100) throw new HttpError(400, 'Provide 2–100 coordinated actions.');
    if (new Set(b.items.map(i => i.recommendationId)).size !== b.items.length) throw new HttpError(400, 'Duplicate recommendation in bundle.');
    const items = b.items.map(i => {
      if (!i || typeof i.recommendationId !== 'string' || !Array.isArray(i.steps)) throw new HttpError(400, 'Invalid bundle item.');
      return { rec: needRec(i.recommendationId), steps: i.steps };
    });
    const at = now();
    const result = approveCoordinated(decisions, items, at, { resources: dataset.resources, recommendations: recs });
    if (!result.ok) throw new HttpError(409, result.error ?? 'Unsafe coordinated plan.');
    decisions = result.decisions;
    for (const { rec, steps } of items) history.push({ at, recommendationId: rec.id, action: 'approve', steps, actorId: actor?.id, actorEmail: actor?.email });
    saveDecisions();
    return { json: { decisions, totals: totals(), coordinated: true } };
  });

  route('DELETE', '/api/decisions', () => {
    decisions = {};
    history.push({ at: now(), recommendationId: '*', action: 'reset' });
    saveDecisions();
    return { json: { ok: true, totals: totals() } };
  });

  route('POST', '/api/scenario/adopt', async ({ body }) => {
    const b = (await body()) as { scenario?: ScenarioId };
    if (!b?.scenario || !(b.scenario in SCENARIOS) || b.scenario === 'normal') throw new HttpError(400, 'Body must be { scenario } (not "normal"; use /api/scenario/reset).');
    const out = adoptPlanningAssumptions(analysis.recommendations, decisions, revalidatedFor(b.scenario), now());
    recs = reapplyUtsav(out.recommendations);
    decisions = recheckApprovedDependencies(out.decisions, { resources: dataset.resources, recommendations: recs }, now());
    adoptedScenario = b.scenario;
    for (const id of out.flagged) history.push({ at: now(), recommendationId: id, action: 'adopt-flag', note: `Adopted "${SCENARIOS[b.scenario].label}"` });
    saveDecisions();
    return { json: { adoptedScenario, flagged: out.flagged, totals: totals() } };
  });

  route('POST', '/api/scenario/reset', () => {
    recs = reapplyUtsav(analysis.recommendations);
    adoptedScenario = null;
    saveDecisions();
    return { json: { adoptedScenario, totals: totals() } };
  });

  route('POST', '/api/import', async ({ body }) => {
    const b = (await body()) as { inventoryCsv?: string; metricsCsv?: string; json?: string };
    const r = typeof b?.json === 'string'
      ? importJsonDataset(b.json)
      : typeof b?.inventoryCsv === 'string' && typeof b?.metricsCsv === 'string'
        ? importCsvDataset(b.inventoryCsv, b.metricsCsv)
        : null;
    if (!r) throw new HttpError(400, 'Body must be { inventoryCsv, metricsCsv } or { json }.');
    if (!r.ok) throw new HttpError(422, 'Import refused: fix the listed rows and try again.', { errors: r.errors, warnings: r.warnings });
    // Stable content fingerprint: the same imported data gets the same decision namespace,
    // while different uploads cannot accidentally share prior human approvals.
    // Match the browser's fingerprint format for CSV pairs.
    const digest = createHash('sha256');
    if (typeof b.inventoryCsv === 'string' && typeof b.metricsCsv === 'string') {
      const inv = Buffer.from(b.inventoryCsv, 'utf8');
      const met = Buffer.from(b.metricsCsv, 'utf8');
      digest.update(`CloudSentinelX-import-v1:${inv.length}:${met.length}:`);
      digest.update(inv);
      digest.update(met);
    } else {
      digest.update('CloudSentinelX-json-import-v1:');
      digest.update(b.json ?? '');
    }
    setDataset({ id: `import-sha256-${digest.digest('hex')}`, source: 'imported', resources: r.resources, series: r.series, start: r.start ?? new Date().toISOString(), days: r.days });
    return { status: 201, json: { dataset: datasetInfo(), warnings: r.warnings, invalid: analysis.invalid } };
  });

  route('POST', '/api/dataset/reset', () => {
    setDataset(synthetic());
    return { json: { dataset: datasetInfo() } };
  });

  // Utsav Mode: today's date for "upcoming" = request asOf, else the real date (IST)
  const todayIst = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  const parseEvents = async (body: () => Promise<unknown>) => {
    const b = (await body()) as { events?: PlannedEvent[]; asOf?: string };
    if (!Array.isArray(b?.events) || b.events.length === 0 || b.events.length > 50) throw new HttpError(400, 'Body must be { events: [...] } with 1–50 events, asOf optional (YYYY-MM-DD).');
    const report = utsavCheck(dataset.resources, dataset.series, recs.map((r) => ({ ...r, holdUntil: undefined })), b.events, b.asOf ?? todayIst());
    if (report.errors.length) throw new HttpError(400, 'Invalid events.', { errors: report.errors });
    return report;
  };
  route('GET', '/api/utsav/presets', () => ({ json: { presets: EVENT_PRESETS, note: 'Dates are verified; the load multiplier must come from your team.' } }));
  route('GET', '/api/utsav', () => ({ json: { applied: utsav } }));
  route('POST', '/api/utsav/check', async ({ body }) => ({ json: { report: await parseEvents(body), preview: true } }));
  route('POST', '/api/utsav/apply', async ({ body }) => {
    utsav = await parseEvents(body);
    recs = applyUtsav(recs.map((r) => ({ ...r, holdUntil: undefined, reasons: r.reasons.filter((x) => !x.startsWith('Utsav Mode:')) })), utsav);
    decisions = recheckHeldApprovals(recheckApprovedEvidence(recheckApprovedDependencies(decisions, { resources: dataset.resources, recommendations: recs }, now()), recs, now()), recs, now());
    saveDecisions();
    return { json: { report: utsav, held: recs.filter((r) => r.holdUntil).map((r) => ({ id: r.id, holdUntil: r.holdUntil })) } };
  });
  route('POST', '/api/utsav/clear', () => {
    utsav = null;
    recs = recs.map((r) => (r.holdUntil ? { ...r, holdUntil: undefined, reasons: r.reasons.filter((x) => !x.startsWith('Utsav Mode:')) } : r));
    saveDecisions();
    return { json: { applied: null } };
  });

  route('GET', '/api/portfolio', ({ url }) => {
    const appetite = url.searchParams.get('appetite') as RiskAppetite | null;
    const raw = url.searchParams.get('budget');
    if (appetite && !(appetite in RISK_APPETITES)) throw new HttpError(400, `appetite must be one of ${Object.keys(RISK_APPETITES).join(', ')}.`);
    const budget = raw !== null ? Number(raw) : RISK_APPETITES[appetite ?? 'balanced'];
    if (!Number.isFinite(budget) || budget < 0) throw new HttpError(400, 'budget must be a number ≥ 0.');
    return { json: { appetites: RISK_APPETITES, ...buildPortfolio(recs, budget, dataset.resources) } };
  });

  route('GET', '/api/export.csv', () => ({ text: recommendationsToCsv(recs, decisions), type: 'text/csv; charset=utf-8', filename: 'cloudsentinel-recommendations.csv' }));
  route('GET', '/api/export/script', ({ url }) => ({
    text: changeScript(recs, url.searchParams.get('scope') === 'eligible' ? undefined : decisions),
    type: 'text/plain; charset=utf-8', filename: 'cloudsentinel-change-plan.txt',
  }));
  route('GET', '/api/config', () => ({ json: { thresholds: CONFIG.foresight, detection: CONFIG.detection, pricing: CONFIG.pricing, scenarios: SCENARIOS, windows: Object.fromEntries(Object.entries(FLEET_WINDOWS).map(([k, v]) => [k, v.label])) } }));

  // ------------------------------------------------------------------ HTTP plumbing
  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBody) throw new HttpError(413, `Request body larger than ${Math.round(maxBody / 1024 / 1024)} MB.`);
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  function send(res: ServerResponse, status: number, reply: Reply) {
    res.setHeader('Access-Control-Allow-Origin', cors);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (reply.filename) res.setHeader('Content-Disposition', `attachment; filename="${reply.filename}"`);
    if (reply.text !== undefined) {
      res.writeHead(status, { 'Content-Type': reply.type ?? 'text/plain; charset=utf-8' });
      res.end(reply.text);
    } else {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(reply.json ?? null));
    }
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    try {
      if (options.apiToken && method !== 'OPTIONS' && url.pathname !== '/api/health') {
        const auth = req.headers.authorization ?? '';
        const expected = Buffer.from(`Bearer ${options.apiToken}`);
        const supplied = Buffer.from(auth);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
          throw new HttpError(401, 'Authorization required for this API.');
      }
      if (method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': cors, 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
        return void res.end();
      }
      const matches = routes.filter((r) => r.pattern.test(url.pathname));
      if (matches.length === 0) throw new HttpError(404, `No route for ${url.pathname}.`);
      const r = matches.find((x) => x.method === method);
      if (!r) {
        res.setHeader('Allow', matches.map((x) => x.method).join(', '));
        throw new HttpError(405, `Method ${method} not allowed on ${url.pathname}.`);
      }
      const m = url.pathname.match(r.pattern)!;
      const params = Object.fromEntries(
        r.keys.map((k, i) => {
          try {
            return [k, decodeURIComponent(m[i + 1])];
          } catch {
            throw new HttpError(400, 'Malformed URL encoding.');
          }
        }),
      );
      let raw: string | null = null;
      const text = async () => (raw ??= await readBody(req));
      const body = async () => {
        const t = await text();
        if (t.trim() === '') return {};
        const ct = req.headers['content-type'] ?? '';
        if (!ct.includes('application/json')) throw new HttpError(415, 'Send JSON with Content-Type: application/json.');
        try {
          return JSON.parse(t);
        } catch {
          throw new HttpError(400, 'Body is not valid JSON.');
        }
      };
      const reply = await r.handler({ url, params, body, text, actor: options.actorForRequest?.(req) });
      send(res, reply.status ?? 200, reply);
    } catch (e) {
      if (e instanceof HttpError) send(res, e.status, { json: { error: e.message, ...(e.details ? { details: e.details } : {}) } });
      else {
        console.error(e);
        send(res, 500, { json: { error: 'Internal error.' } });
      }
    }
  };
}
