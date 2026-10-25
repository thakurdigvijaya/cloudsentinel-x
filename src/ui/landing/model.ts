// What the Evidence Sphere shows: every node is a real resource of the loaded dataset, coloured and shaped by the
// engine's verdict. Pure functions (no DOM), so they are unit-tested. Nothing here invents a number.
import { aggregate } from '../../engine/decisions';
import { buildPortfolio, RISK_APPETITES, type RiskAppetite } from '../../engine/portfolio';
import { previewRecommendation, revalidate } from '../../engine/scenarios';
import type { Recommendation, ScenarioId } from '../../engine/types';
import type { AppData } from '../data';
import { fibonacciSphere, type NodeTarget, type Placement, type Shape } from './sphere';
import type { Theme } from '../store';

/** safe = passes every check; refused = a check failed; thin = not enough evidence; none = no change proposed */
export type Kind = 'safe' | 'refused' | 'thin' | 'none';

export interface FleetNode {
  id: string;
  name: string;
  env: string;
  region: string;
  team: string;
  /** monthly cost of the resource today, rupees */
  cost: number;
  /** proposed monthly saving, rupees (0 when nothing is proposed) */
  saving: number;
  kind: Kind;
  /** a Dependency Shield block stopped at least one step */
  blocked: boolean;
  rec: Recommendation | undefined;
}

export interface Fleet {
  nodes: FleetNode[];
  maxCost: number;
  maxSaving: number;
  counts: Record<Kind, number>;
  eligibleInr: number;
  notClaimedInr: number;
  notClaimedResources: number;
  blockedCount: number;
  originalInr: number;
}

export const kindOf = (rec: Recommendation | undefined): Kind => {
  if (!rec || rec.monthlySavingInr <= 0) return 'none';
  if (rec.eligible) return 'safe';
  if (rec.verdict === 'FAIL_SAFETY_CHECKS') return 'refused';
  if (rec.verdict === 'INSUFFICIENT_EVIDENCE') return 'thin';
  return 'none';
};

export function buildFleet(data: AppData): Fleet {
  const recs = data.baseRecommendations;
  const byRes = new Map(recs.map((r) => [r.resourceId, r]));
  const totals = aggregate(data.resources, recs, {});
  const nodes: FleetNode[] = [...data.resources]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((res) => {
      const rec = byRes.get(res.id);
      return {
        id: res.id,
        name: res.name,
        env: res.env,
        region: res.region,
        team: res.team,
        cost: totals.byResource[res.id]?.originalInr ?? 0,
        saving: rec?.monthlySavingInr ?? 0,
        kind: kindOf(rec),
        blocked: (rec?.blockedSteps?.length ?? 0) > 0,
        rec,
      };
    });
  const counts: Record<Kind, number> = { safe: 0, refused: 0, thin: 0, none: 0 };
  for (const n of nodes) counts[n.kind]++;
  return {
    nodes,
    maxCost: Math.max(1, ...nodes.map((n) => n.cost)),
    maxSaving: Math.max(1, ...nodes.map((n) => n.saving)),
    counts,
    eligibleInr: totals.eligibleInr,
    notClaimedInr: totals.candidateInr - totals.eligibleInr,
    notClaimedResources: counts.refused + counts.thin,
    blockedCount: nodes.filter((n) => n.blocked).length,
    originalInr: totals.originalInr,
  };
}

// ---------- the stress explorer (Challenge) ----------

export interface Stress {
  scenario: ScenarioId;
  /** resource ids that are still approvable under the scenario */
  eligibleIds: Set<string>;
  /** approvable in the normal case but not under this scenario */
  dropped: Recommendation[];
  eligibleInr: number;
}

/** Re-runs the engine's preview of every VM recommendation under one scenario (the same path as "Adopt as planning assumption"). */
export function computeStress(data: AppData, scenario: ScenarioId): Stress {
  const base = data.baseRecommendations;
  const merged = base.map((rec) =>
    scenario !== 'normal' && rec.resourceType === 'vm' && data.series.has(rec.resourceId)
      ? revalidate(rec, previewRecommendation(data.resourceById.get(rec.resourceId)!, data.series.get(rec.resourceId)!, rec, scenario))
      : rec,
  );
  const totals = aggregate(data.resources, merged, {});
  return {
    scenario,
    eligibleIds: new Set(merged.filter((r) => r.eligible).map((r) => r.resourceId)),
    dropped: merged.filter((m, i) => base[i].eligible && !m.eligible).sort((a, b) => b.monthlySavingInr - a.monthlySavingInr),
    eligibleInr: totals.eligibleInr,
  };
}

// ---------- the portfolio (Decide) ----------

export interface PortfolioView {
  appetite: RiskAppetite;
  chosen: Set<string>;
  count: number;
  savingInr: number;
  riskUsed: number;
  budget: number;
}
export function portfolioView(data: AppData, appetite: RiskAppetite): PortfolioView {
  const p = buildPortfolio(data.baseRecommendations, RISK_APPETITES[appetite], data.resources);
  return {
    appetite,
    chosen: new Set(p.choice.chosen.map((c) => c.resourceId)),
    count: p.choice.chosen.length,
    savingInr: p.choice.savingInr,
    riskUsed: p.choice.riskPointsUsed,
    budget: RISK_APPETITES[appetite],
  };
}

// ---------- node targets for each chapter ----------
// 1 Discover, 2 Analyse, 3 Challenge, 4 Verify, 5 Decide (anything else: the resting state)

type RGB = [number, number, number];
// Day: pine, terracotta and slate on a pale glass panel. Twilight: mint, coral and periwinkle on deep teal.
export const PALETTE: Record<Theme, Record<Kind | 'gold' | 'base', RGB>> = {
  light: { safe: [0.13, 0.45, 0.38], refused: [0.74, 0.35, 0.28], thin: [0.36, 0.47, 0.66], none: [0.6, 0.67, 0.63], gold: [0.8, 0.56, 0.26], base: [0.3, 0.52, 0.46] },
  dark: { safe: [0.45, 0.88, 0.72], refused: [1.0, 0.48, 0.42], thin: [0.62, 0.7, 1.0], none: [0.45, 0.55, 0.62], gold: [1.0, 0.74, 0.52], base: [0.5, 0.82, 0.74] },
};
/** dust colours of the sphere for each theme */
export const DUST: Record<Theme, { main: RGB; accent: RGB; boost: number }> = {
  light: { main: [0.16, 0.36, 0.33], accent: [0.8, 0.56, 0.38], boost: 1 },
  dark: { main: [0.82, 0.94, 0.9], accent: [0.96, 0.7, 0.54], boost: 1.1 },
};
export const SHAPE: Record<Kind, Shape> = { safe: 0, refused: 1, thin: 2, none: 0 };

export interface Ctx {
  theme: Theme;
  stress: Pick<Stress, 'eligibleIds'> | null;
  chosen: Set<string> | null;
}

const CLUSTER_CENTERS: [number, number, number][] = [
  [-0.3, -0.05, 0],
  [1.05, 0.62, 0.15],
  [0.95, -0.7, 0.1],
  [-0.4, 0.98, -0.4],
];

function clusterLayout(assign: number[]): [number, number, number][] {
  const members: number[][] = [[], [], [], []];
  assign.forEach((c, i) => members[c].push(i));
  const out: [number, number, number][] = new Array(assign.length);
  members.forEach((m, c) => {
    if (m.length === 0) return;
    const rad = Math.min(0.85, 0.12 + 0.088 * Math.sqrt(m.length));
    const pts = fibonacciSphere(m.length, rad);
    m.forEach((idx, k) => {
      const [cx, cy, cz] = CLUSTER_CENTERS[c];
      out[idx] = [cx + pts[k][0], cy + pts[k][1], cz + pts[k][2]];
    });
  });
  return out;
}

export function targetsFor(state: number, fleet: Fleet, ctx: Ctx): NodeTarget[] {
  const pal = PALETTE[ctx.theme];
  const sphere = fibonacciSphere(fleet.nodes.length, 1);
  const sizeOfCost = (n: FleetNode) => 0.02 + 0.04 * Math.sqrt(n.cost / fleet.maxCost);
  const sizeOfSaving = (n: FleetNode) => 0.026 + 0.034 * Math.sqrt(n.saving / fleet.maxSaving);
  let pos = sphere;
  let assign: number[] | null = null;
  if (state === 3) {
    assign = fleet.nodes.map((n) => {
      if (n.kind === 'none') return 3;
      if (n.kind === 'refused' || n.kind === 'thin') return 2;
      return ctx.stress && !ctx.stress.eligibleIds.has(n.id) ? 1 : 0;
    });
    pos = clusterLayout(assign);
  }
  return fleet.nodes.map((n, i): NodeTarget => {
    const [x, y, z] = pos[i];
    const t = (c: RGB, a: number, size: number, shape: Shape, glow = 0): NodeTarget => ({ x, y, z, r: c[0], g: c[1], b: c[2], a, size, shape, glow });
    switch (state) {
      case 1:
        return n.saving > 0 ? t(pal.gold, 0.95, sizeOfCost(n), 0, 0.25) : t(pal.none, 0.5, sizeOfCost(n) * 0.8, 0);
      case 2:
        return n.kind === 'none' ? t(pal.none, 0.4, 0.016, 0) : t(pal[n.kind], 0.95, sizeOfSaving(n), SHAPE[n.kind], 0.1);
      case 3: {
        const c = assign![i];
        if (c === 0) return t(pal.safe, 0.95, sizeOfSaving(n), 0, 0.12);
        if (c === 1) return t(pal.refused, 1, sizeOfSaving(n) * 1.15, 1, 0.55);
        if (c === 2) return t(pal[n.kind], 0.5, sizeOfSaving(n) * 0.85, SHAPE[n.kind], 0);
        return t(pal.none, 0.3, 0.014, 0);
      }
      case 4:
        if (n.kind === 'refused' || n.kind === 'thin') return t(pal[n.kind], 1, sizeOfSaving(n) * (n.blocked ? 1.3 : 1.05), SHAPE[n.kind], n.blocked ? 0.8 : 0.3);
        return t(pal.none, n.kind === 'safe' ? 0.28 : 0.14, 0.016, 0);
      case 5: {
        const on = ctx.chosen?.has(n.id) ?? false;
        return on ? t(pal.safe, 1, sizeOfSaving(n) * 1.1, 0, 0.6) : t(pal.none, 0.2, 0.016, 0);
      }
      default:
        return t(pal.base, 0.85, sizeOfCost(n) * 0.95, 0, 0.1);
    }
  });
}

/** Where the sphere sits inside its panel. W is the panel width and H the free height above the step card (both CSS px);
 *  the top 70px are kept clear for the small labels. The sphere never reaches past H (its near side is drawn 1.42 times larger). */
export function placementFor(state: number, W: number, H: number): Placement {
  const free = Math.max(60, H - 70);
  const r = Math.min(W * 0.27, free * 0.35);
  return { cx: W * 0.5, cy: 70 + free * 0.5, r: state === 3 ? r * 0.8 : r };
}
