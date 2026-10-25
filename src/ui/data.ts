// Dataset + one engine run. Every screen reads from here. The synthetic dataset loads by default;
// a team can replace it with its own CSV (Data & Export screen) — the same engine runs on it.
import { generateDataset } from '../data/generator';
import { analyzeAll, type Analysis } from '../engine';
import type { MetricSeries, Recommendation, Resource } from '../engine/types';

export interface AppData {
  id: string;
  source: 'synthetic' | 'imported';
  /** shown in the top bar on every screen */
  label: string;
  start: string;
  days: number;
  analysis: Analysis;
  resources: Resource[];
  resourceById: Map<string, Resource>;
  series: Map<string, MetricSeries>;
  /** the recommendations produced under normal (historical) conditions */
  baseRecommendations: Recommendation[];
  teams: string[];
  loadMs: number;
}

export function buildData(
  resources: Resource[],
  series: Map<string, MetricSeries>,
  meta: { id: string; source: AppData['source']; start: string; days: number },
): AppData {
  const t0 = performance.now();
  if (meta.source === 'imported') {
    // Import is new evidence. Old timestamps must fail freshness checks rather than being
    // interpreted as fresh merely because they are the end of their own 30-day series.
    const analysisTime = new Date().toISOString();
    for (const s of series.values()) s.analysisTime = analysisTime;
  }
  const analysis = analyzeAll(resources, series);
  return {
    ...meta,
    label: meta.source === 'synthetic' ? 'SYNTHETIC DATA · illustrative pricing' : 'YOUR IMPORTED DATA · illustrative pricing',
    analysis,
    resources,
    resourceById: new Map(resources.map((r) => [r.id, r])),
    series,
    baseRecommendations: analysis.recommendations,
    teams: [...new Set(resources.map((r) => r.team))].sort(),
    loadMs: performance.now() - t0,
  };
}

let cache: AppData | null = null;

export function loadData(): AppData {
  if (cache) return cache;
  const d = generateDataset();
  cache = buildData(d.resources, d.series, { id: 'synthetic-2026', source: 'synthetic', start: d.start, days: 30 });
  return cache;
}
