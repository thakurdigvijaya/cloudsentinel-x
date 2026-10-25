// Engine entry point: run everything once, from one source of truth.
import { generateAlerts } from './alerts';
import { CONFIG } from './config';
import { analyzeResource } from './recommend';
import { applyDependencyShield } from './dependencies';
import { generateSpendAlerts } from './spend';
import type { Alert, MetricSeries, Recommendation, Resource, ValidationError } from './types';

export interface Analysis {
  recommendations: Recommendation[];
  invalid: { resourceId: string; errors: ValidationError[] }[];
  alerts: Alert[];
}

export interface AnalyzeOptions {
  /** monthly budget for alert I4; defaults to CONFIG.alerts.monthlyBudgetInr */
  budgetInr?: number;
}

export function analyzeAll(resources: readonly Resource[], series: ReadonlyMap<string, MetricSeries>, options: AnalyzeOptions = {}): Analysis {
  const recommendations: Recommendation[] = [];
  const invalid: Analysis['invalid'] = [];
  const invalidIds = new Set<string>();
  for (const r of resources) {
    const result = analyzeResource(r, series.get(r.id));
    if (result.ok) recommendations.push(result.recommendation);
    else {
      invalid.push({ resourceId: result.resourceId, errors: result.errors });
      invalidIds.add(result.resourceId);
    }
  }
  const valid = resources.filter((r) => !invalidIds.has(r.id));
  const shielded = applyDependencyShield(valid, recommendations);
  recommendations.splice(0, recommendations.length, ...shielded);
  const alerts = generateAlerts(valid, series);
  const first = series.values().next().value as MetricSeries | undefined;
  if (first) {
    const days = Math.round(first.cpuPct.length / CONFIG.time.samplesPerDay);
    alerts.push(...generateSpendAlerts(valid, first.start, days, options.budgetInr));
  }
  return { recommendations, invalid, alerts };
}

export * from './types';
export { CONFIG, offHoursFraction } from './config';
export { dailySpend } from './spend';
export { aggregate, approve, reject, adoptPlanningAssumptions, statusOf } from './decisions';
export { previewRecommendation, revalidate, applyScenario, SCENARIOS } from './scenarios';
export { analyzeResource } from './recommend';
export { fleetWhatIf, FLEET_WINDOWS } from './whatif';
export { forecastSpend, forecastCapacity } from './forecast';
export { fleetEnergy, energyForRecommendation } from './sustainability';
export { recommendationsToCsv, changeScript } from './export';
export { explainBill, roleBrief } from './explain';
export { importCsvDataset, importJsonDataset, datasetToCsv } from './importer';
export { utsavCheck, applyUtsav, EVENT_PRESETS } from './utsav';
export { buildPortfolio, RISK_APPETITES } from './portfolio';
