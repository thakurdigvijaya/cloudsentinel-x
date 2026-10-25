// Estimated spend over time and the spend alerts I2 (increase) and I4 (budget overrun).
// Spend is ESTIMATED from inventory: a resource costs its monthly price × 24/730 per day
// from the day it was created. Synthetic data, illustrative pricing — not a real bill.
import { CONFIG } from './config';
import { resourceMonthlyCost, round2 } from './pricing';
import type { Alert, Resource } from './types';

const DAY_MS = 86400000;
const IST_MS = 5.5 * 3600000;

/** Day index of a YYYY-MM-DD date relative to the series start (IST calendar days). */
export function dayIndex(dateIso: string, seriesStartIso: string): number {
  const startDay = Math.floor((Date.parse(seriesStartIso) + IST_MS) / DAY_MS);
  const day = Math.floor(Date.parse(dateIso + 'T00:00:00Z') / DAY_MS);
  return day - startDay;
}

/** Estimated spend for each day of the window. */
export function dailySpend(resources: readonly Resource[], seriesStartIso: string, days: number): number[] {
  const perDayFactor = 24 / CONFIG.time.hoursPerMonth;
  const out = new Array<number>(days).fill(0);
  for (const r of resources) {
    const created = dayIndex(r.createdAt, seriesStartIso);
    const daily = resourceMonthlyCost(r) * perDayFactor;
    for (let d = Math.max(0, created); d < days; d++) out[d] += daily;
  }
  return out.map(round2);
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const inr = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');

/** I2: last 7 days vs previous 7 days ≥ +15%. */
export function detectSpendIncrease(daily: readonly number[], resources: readonly Resource[], seriesStartIso: string): Alert | null {
  const w = CONFIG.alerts.spendWindowDays;
  if (daily.length < 2 * w) return null;
  const last = sum(daily.slice(-w));
  const prev = sum(daily.slice(-2 * w, -w));
  if (prev <= 0) return null;
  const pct = ((last - prev) / prev) * 100;
  if (pct < CONFIG.alerts.spendIncreasePct) return null;
  const startOfLastWindow = daily.length - w * 2;
  const added = resources.filter((r) => dayIndex(r.createdAt, seriesStartIso) >= startOfLastWindow);
  const addedMonthly = sum(added.map(resourceMonthlyCost));
  return {
    id: 'alert-spend-increase',
    type: 'spend-increase',
    severity: 'warning',
    resourceId: null,
    title: `Estimated spend up ${pct.toFixed(1)}% week over week`,
    why: `Last ${w} days ≈ ${inr(last)} vs previous ${w} days ≈ ${inr(prev)} (threshold +${CONFIG.alerts.spendIncreasePct}%). ` +
      `${added.length} resources created in the last ${2 * w} days add ≈ ${inr(addedMonthly)}/month: ${added.map((r) => r.name).join(', ')}.`,
    synthetic: true,
  };
}

/** I4: run-rate of the last 7 days projected to a month exceeds the monthly budget. */
export function detectBudgetOverrun(daily: readonly number[], budgetInr: number = CONFIG.alerts.monthlyBudgetInr): Alert | null {
  const w = CONFIG.alerts.spendWindowDays;
  if (daily.length < w) return null;
  const avg = sum(daily.slice(-w)) / w;
  const projected = (avg * CONFIG.time.hoursPerMonth) / 24;
  if (projected <= budgetInr) return null;
  return {
    id: 'alert-budget-overrun',
    type: 'budget-overrun',
    severity: 'critical',
    resourceId: null,
    title: `Projected month spend exceeds budget by ${inr(projected - budgetInr)}`,
    why: `Average daily spend over the last ${w} days ≈ ${inr(avg)} → projected ${inr(projected)}/month vs budget ${inr(budgetInr)}.`,
    synthetic: true,
  };
}

export function generateSpendAlerts(resources: readonly Resource[], seriesStartIso: string, days: number, budgetInr?: number): Alert[] {
  const daily = dailySpend(resources, seriesStartIso, days);
  return [detectSpendIncrease(daily, resources, seriesStartIso), detectBudgetOverrun(daily, budgetInr)].filter((a): a is Alert => a !== null);
}
