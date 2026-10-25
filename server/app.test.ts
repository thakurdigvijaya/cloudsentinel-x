// API tests: a real HTTP server on a random port, real requests.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app';
import { loadData } from '../src/ui/data';
import { aggregate } from '../src/engine/decisions';

let server: Server;
let base = '';
const dir = mkdtempSync(join(tmpdir(), 'csx-'));
const file = join(dir, 'decisions.json');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = { status: number; headers: Headers; body: any };
const get = async (p: string): Promise<Res> => {
  const r = await fetch(base + p);
  const ct = r.headers.get('content-type') ?? '';
  return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : await r.text() };
};
const send = async (method: string, p: string, body?: unknown, type = 'application/json'): Promise<Omit<Res, 'headers'>> => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': type }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

async function start(app: ReturnType<typeof createApp>) {
  const s = createServer((req, res) => void app(req, res));
  await new Promise<void>((ok) => s.listen(0, ok));
  const addr = s.address();
  return { s, url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` };
}

beforeAll(async () => {
  const x = await start(createApp({ decisionsFile: file, maxBodyBytes: 30 * 1024 * 1024 }));
  server = x.s;
  base = x.url;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

describe('Read endpoints', () => {
  it('health + summary: synthetic label, totals match the engine', async () => {
    const h = await get('/api/health');
    expect(h.status).toBe(200);
    expect(h.body.dataset.label).toBe('Synthetic data · illustrative pricing');
    const s = await get('/api/summary');
    // Command Center and API use the same seeded inventory, engine and aggregation.
    // Do not compare a different imported dataset or saved what-if scenario as the baseline.
    const uiData = loadData();
    const uiTotals = aggregate(uiData.resources, uiData.baseRecommendations, {});
    expect(s.body.dataset.id).toBe(uiData.id);
    expect(uiTotals.originalInr).toBe(835622);
    expect(uiTotals.eligibleInr).toBe(218849.99);
    expect(s.body.totals.originalInr).toBe(uiTotals.originalInr);
    expect(s.body.totals.eligibleInr).toBe(uiTotals.eligibleInr);
    expect(s.body.totals.approvedInr).toBe(0);
    expect(s.body.counts.alerts).toBeGreaterThan(0);
  });

  it('recommendations filter by env / verdict / actionable', async () => {
    const r = await get('/api/recommendations?env=dev&actionable=true');
    expect(r.body.items.every((x: { env: string; action: string }) => x.env === 'dev' && x.action !== 'none')).toBe(true);
    const f = await get('/api/recommendations?verdict=FAIL_SAFETY_CHECKS');
    expect(f.body.count).toBeGreaterThan(0);
  });

  it('resource detail: hourly-max series by default (720 points), raw on request', async () => {
    const r = await get('/api/resources/vm-001');
    expect(r.body.series.cpuPct).toHaveLength(720);
    expect(r.body.series.aggregation).toBe('hourly max');
    expect((await get('/api/resources/vm-001?resolution=15m')).body.series.cpuPct).toHaveLength(2880);
    expect((await get('/api/resources/nope')).status).toBe(404);
  });

  it('explain, what-if, forecast, sustainability, challenge, passport', async () => {
    expect((await get('/api/explain?role=leadership')).body.briefs[0].points).toHaveLength(3);
    expect((await get('/api/explain?role=boss')).status).toBe(400);
    const w = await get('/api/whatif?window=nights&env=dev');
    expect(w.body.counts.total).toBe(35);
    expect((await get('/api/whatif?window=always')).status).toBe(400);
    expect((await get('/api/forecast')).body.spend.points).toHaveLength(3);
    expect((await get('/api/sustainability')).body.eligible.kwhSavedPerMonth).toBeGreaterThan(0);
    const resize = (await get('/api/recommendations?actionable=true')).body.items.find((x: { action: string; eligible: boolean }) => x.action === 'resize' && x.eligible);
    const c = await get(`/api/challenge/${resize.resourceId}`);
    expect(c.body.breakPoint.kind).toBeDefined();
    expect(c.body.closestCall.kind).toBeDefined();
    const p = await get(`/api/passport/${resize.resourceId}`);
    expect(p.headers.get('content-type')).toMatch(/text\/markdown/);
    expect(p.body).toMatch(/not a probability of safety/);
  });
});

describe('Preview never changes totals; decisions persist', () => {
  it('preview reports totalsUnchanged', async () => {
    const r = await send('POST', '/api/preview', { resourceId: 'vm-001', scenario: 'traffic60' });
    expect(r.status).toBe(200);
    expect(r.body.totalsUnchanged).toBe(true);
    expect((await send('POST', '/api/preview', { resourceId: 'vm-001', scenario: 'meteor' })).status).toBe(400);
  });

  it('approve (partial), reject, refuse ineligible; totals update; written to disk atomically', async () => {
    const items = (await get('/api/recommendations?actionable=true')).body.items;
    const multi = items.find((x: { action: string; eligible: boolean }) => x.action === 'resize+schedule' && x.eligible);
    const r1 = await send('POST', '/api/decisions', { recommendationId: multi.id, action: 'approve', steps: ['schedule'] });
    expect(r1.status).toBe(200);
    expect(r1.body.decision.acceptedSteps).toEqual(['schedule']);
    expect(r1.body.totals.approvedInr).toBeGreaterThan(0);
    const failing = items.find((x: { verdict: string }) => x.verdict === 'FAIL_SAFETY_CHECKS');
    const r2 = await send('POST', '/api/decisions', { recommendationId: failing.id, action: 'approve' });
    expect(r2.status).toBe(409);
    expect(r2.body.error).toMatch(/Cannot approve/);
    expect((await send('POST', '/api/decisions', { recommendationId: failing.id, action: 'reject', note: 'peak risk' })).status).toBe(200);
    const saved = JSON.parse(readFileSync(file, 'utf8')).datasets['synthetic-2026'];
    expect(saved.decisions[multi.id].status).toBe('approved');
    expect(saved.history.length).toBe(2);
  });

  it('a new server instance reloads the saved decisions (restart-safe)', async () => {
    const x = await start(createApp({ decisionsFile: file }));
    const r = (await fetch(x.url + '/api/decisions').then((res) => res.json())) as { decisions: object; totals: { approvedInr: number } };
    expect(Object.keys(r.decisions).length).toBe(2);
    expect(r.totals.approvedInr).toBeGreaterThan(0);
    await new Promise<void>((ok) => x.s.close(() => ok()));
  });

  it('a corrupt decisions file does not crash the API; it is kept aside', async () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    const x = await start(createApp({ decisionsFile: bad }));
    expect((await fetch(x.url + '/api/health')).status).toBe(200);
    expect(existsSync(bad)).toBe(false);
    await new Promise<void>((ok) => x.s.close(() => ok()));
  });

  it('adopting a scenario flags affected approvals; reset restores recommendations', async () => {
    const a = await send('POST', '/api/scenario/adopt', { scenario: 'traffic60' });
    expect(a.status).toBe(200);
    expect(a.body.adoptedScenario).toBe('traffic60');
    expect((await send('POST', '/api/scenario/adopt', { scenario: 'normal' })).status).toBe(400);
    const r = await send('POST', '/api/scenario/reset');
    expect(r.body.adoptedScenario).toBeNull();
  });
});

describe('Utsav Mode over HTTP', () => {
  const diwali = { id: 'diwali', name: 'Diwali week', start: '2026-11-05', end: '2026-11-10', loadMultiplier: 2 };
  it('presets carry the verified date and no load; check is a preview; apply sets holds; clear removes them', async () => {
    const p = await get('/api/utsav/presets');
    expect(p.body.presets[0].start).toBe('2026-11-05');
    const before = (await get('/api/summary')).body.totals;
    const c = await send('POST', '/api/utsav/check', { events: [diwali], asOf: '2026-10-24' });
    expect(c.status).toBe(200);
    expect(c.body.preview).toBe(true);
    expect(c.body.report.counts['hold-until-after']).toBeGreaterThan(0);
    expect((await get('/api/recommendations')).body.items.some((r: { holdUntil?: string }) => r.holdUntil)).toBe(false);
    const a = await send('POST', '/api/utsav/apply', { events: [diwali], asOf: '2026-10-24' });
    expect(a.body.held.length).toBeGreaterThan(0);
    expect(a.body.held[0].holdUntil).toBe('2026-11-11');
    // holds survive an adopt/reset cycle
    await send('POST', '/api/scenario/reset');
    expect((await get('/api/recommendations')).body.items.filter((r: { holdUntil?: string }) => r.holdUntil).length).toBe(a.body.held.length);
    expect((await get('/api/export/script?scope=eligible')).body).toMatch(/UTSAV HOLD: do not apply before 2026-11-11/);
    expect((await get('/api/summary')).body.totals.eligibleInr).toBe(before.eligibleInr); // savings unchanged
    await send('POST', '/api/utsav/clear');
    expect((await get('/api/recommendations')).body.items.some((r: { holdUntil?: string }) => r.holdUntil)).toBe(false);
  });
  it('bad events → 400 with the reasons', async () => {
    const r = await send('POST', '/api/utsav/check', { events: [{ ...diwali, loadMultiplier: 0 }] });
    expect(r.status).toBe(400);
    expect(r.body.details.errors[0]).toMatch(/between 1 and 20/);
    expect((await send('POST', '/api/utsav/check', {})).status).toBe(400);
  });
});

describe('Planning state survives a restart', () => {
  it('adopted scenario and Utsav events are restored by a new server instance', async () => {
    const f = join(dir, 'state.json');
    const one = await start(createApp({ decisionsFile: f }));
    const post = (p: string, b: unknown) => fetch(one.url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    await post('/api/scenario/adopt', { scenario: 'traffic25' });
    await post('/api/utsav/apply', { events: [{ id: 'd', name: 'Diwali week', start: '2026-11-05', end: '2026-11-10', loadMultiplier: 3, envs: ['prod', 'staging', 'dev'] }], asOf: '2026-10-24' });
    const held1 = ((await fetch(one.url + '/api/recommendations').then((r) => r.json())) as { items: { holdUntil?: string }[] }).items.filter((r) => r.holdUntil).length;
    await new Promise<void>((ok) => one.s.close(() => ok()));
    const two = await start(createApp({ decisionsFile: f }));
    const h = (await fetch(two.url + '/api/health').then((r) => r.json())) as { dataset: { adoptedScenario: string } };
    expect(h.dataset.adoptedScenario).toBe('traffic25');
    const u = (await fetch(two.url + '/api/utsav').then((r) => r.json())) as { applied: { events: unknown[] } | null };
    expect(u.applied?.events).toHaveLength(1);
    const held2 = ((await fetch(two.url + '/api/recommendations').then((r) => r.json())) as { items: { holdUntil?: string }[] }).items.filter((r) => r.holdUntil).length;
    expect(held2).toBe(held1);
    expect(held2).toBeGreaterThan(0);
    await new Promise<void>((ok) => two.s.close(() => ok()));
  });
});

describe('Risk Budget Portfolio over HTTP', () => {
  it('appetite presets and explicit budgets; bad input → 400', async () => {
    const c = await get('/api/portfolio?appetite=cautious');
    const b = await get('/api/portfolio?appetite=bold');
    expect(c.body.choice.riskPointsUsed).toBeLessThanOrEqual(c.body.appetites.cautious);
    expect(b.body.choice.savingInr).toBeGreaterThanOrEqual(c.body.choice.savingInr);
    expect((await get('/api/portfolio?budget=0')).body.choice.chosen).toHaveLength(0);
    expect((await get('/api/portfolio?appetite=yolo')).status).toBe(400);
    expect((await get('/api/portfolio?budget=-1')).status).toBe(400);
  });
});

describe('Import and export over HTTP', () => {
  it('CSV export starts with the disclaimer; change script lists only approved steps', async () => {
    const csv = await get('/api/export.csv');
    expect(csv.headers.get('content-disposition')).toMatch(/attachment/);
    expect(csv.body).toMatch(/^# Synthetic data/);
    expect((await get('/api/export/script')).body).toMatch(/ILLUSTRATIVE/);
  });

  it('bad import → 422 with row-level errors; dataset unchanged', async () => {
    const before = (await get('/api/health')).body.dataset.id;
    const r = await send('POST', '/api/import', { inventoryCsv: 'id,name\nx,y\n', metricsCsv: '' });
    expect(r.status).toBe(422);
    expect(r.body.details.errors.length).toBeGreaterThan(0);
    expect((await get('/api/health')).body.dataset.id).toBe(before);
  });

  it('good import (sample files) → 201, new dataset, fresh decisions; reset brings back the synthetic data', async () => {
    const inventoryCsv = readFileSync('docs/sample-data/inventory.csv', 'utf8');
    const metricsCsv = readFileSync('docs/sample-data/metrics.csv', 'utf8');
    const r = await send('POST', '/api/import', { inventoryCsv, metricsCsv });
    expect(r.status).toBe(201);
    expect(r.body.dataset.source).toBe('imported');
    expect(r.body.dataset.label).toBe('Imported data · illustrative pricing');
    const s = await get('/api/summary');
    expect(s.body.totals.approvedInr).toBe(0);
    expect(s.body.dataset.vms).toBe(7);
    // a decision on the imported data must not wipe the synthetic dataset's decisions
    const idle = (await get('/api/recommendations?actionable=true')).body.items.find((x: { eligible: boolean }) => x.eligible);
    expect((await send('POST', '/api/decisions', { recommendationId: idle.id, action: 'approve' })).status).toBe(200);
    expect((await send('POST', '/api/dataset/reset')).body.dataset.source).toBe('synthetic');
    // decisions for the synthetic dataset come back from disk
    expect(Object.keys((await get('/api/decisions')).body.decisions).length).toBeGreaterThan(0);
  });
});

describe('HTTP hygiene', () => {
  it('404, 405 with Allow, 415 for non-JSON, 400 for broken JSON, 413 for huge bodies, CORS preflight', async () => {
    expect((await get('/api/nope')).status).toBe(404);
    const m = await fetch(base + '/api/summary', { method: 'POST' });
    expect(m.status).toBe(405);
    expect(m.headers.get('allow')).toBe('GET');
    expect((await send('POST', '/api/decisions', 'x=1', 'text/plain')).status).toBe(415);
    expect((await send('POST', '/api/decisions', '{oops')).status).toBe(400);
    const tiny = await start(createApp({ maxBodyBytes: 100 }));
    const big = await fetch(tiny.url + '/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ json: 'x'.repeat(500) }) });
    expect(big.status).toBe(413);
    await new Promise<void>((ok) => tiny.s.close(() => ok()));
    const o = await fetch(base + '/api/decisions', { method: 'OPTIONS' });
    expect(o.status).toBe(204);
    // Local browser is explicitly allowed; wildcard CORS is not the expected policy.
    expect(o.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(o.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('malformed URL encoding → 400, not 500', async () => {
    expect((await get('/api/resources/%E0%A4%A')).status).toBe(400);
  });

  it('errors never leak stack traces', async () => {
    const r = await send('POST', '/api/decisions', { recommendationId: 'nope', action: 'approve' });
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toMatch(/at .*\.ts:\d+/);
  });
});
