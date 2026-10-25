// Fleet "what-if" simulator (UTHO bonus feature, the brief's own example:
// "what if we shut down all dev VMs from 8 PM to 8 AM?"). PREVIEW ONLY: it never changes
// recommendations, approvals or totals. Savings are against the CURRENT bill of each VM and are
// not added to recommendation savings (a VM may also have its own resize/schedule recommendation).
import { CONFIG, offHoursFraction, weekendFraction } from './config';
import { dataChecks } from './foresight';
import { round2, vmMonthlyCost } from './pricing';
import { summarize } from './stats';
import { isBusinessSample, isWeekendSample, sampleInfo, slotOffset } from './time';
import type { Env, MetricSeries, Region, Resource } from './types';

export type FleetWindow = 'nights' | 'nights-and-weekends' | 'weekends';

export const FLEET_WINDOWS: Record<FleetWindow, { label: string; inWindow: (i: number) => boolean; offFraction: () => number }> = {
  nights: {
    label: '20:00–08:00 every day',
    inWindow: (i) => {
      const h = sampleInfo(i).hour;
      return h >= CONFIG.time.businessEndHour || h < CONFIG.time.businessStartHour;
    },
    // 12 of 24 hours, every day of the month
    offFraction: () => (24 - (CONFIG.time.businessEndHour - CONFIG.time.businessStartHour)) / 24,
  },
  'nights-and-weekends': { label: '20:00–08:00 on weekdays and all weekend', inWindow: (i) => !isBusinessSample(i), offFraction: offHoursFraction },
  weekends: { label: 'Saturday 00:00 to Monday 00:00', inWindow: isWeekendSample, offFraction: weekendFraction },
};

export interface FleetFilter {
  env?: Env[];
  region?: Region[];
  team?: string[];
}

export type FleetVmStatus = 'quiet' | 'active' | 'insufficient';

export interface FleetVm {
  resourceId: string;
  name: string;
  env: Env;
  monthlyCostInr: number;
  savingInr: number;
  status: FleetVmStatus;
  windowCpuP95: number | null;
  windowNetP95Mbps: number | null;
  reason: string;
}

export interface FleetWhatIfResult {
  window: FleetWindow;
  windowLabel: string;
  offFraction: number;
  filter: FleetFilter;
  vms: FleetVm[];
  /** saving if EVERY matching VM is shut down in the window */
  savingAllInr: number;
  /** saving if only the VMs that are quiet in the window are shut down */
  savingQuietInr: number;
  counts: Record<FleetVmStatus, number> & { total: number; production: number };
  summary: string;
  preview: true;
}

const matches = (r: Resource, f: FleetFilter) =>
  r.type === 'vm' &&
  (!f.env?.length || f.env.includes(r.env)) &&
  (!f.region?.length || f.region.includes(r.region)) &&
  (!f.team?.length || f.team.includes(r.team));

function totalNet(s: MetricSeries, keep: (i: number) => boolean): (number | null)[] {
  return s.netInMbps.map((v, i) => (!keep(i) || v === null || s.netOutMbps[i] === null ? null : v + s.netOutMbps[i]!));
}

/**
 * Evaluates one fleet-wide shutdown policy. A VM is "quiet" when, inside the window, CPU p95 < 5% and
 * network p95 < 1 Mbps (the D3 thresholds) with sufficient data; otherwise it is "active" (shutting it
 * down would interrupt real work) or "insufficient" (we cannot tell).
 */
export function fleetWhatIf(
  resources: readonly Resource[],
  series: ReadonlyMap<string, MetricSeries>,
  window: FleetWindow,
  filter: FleetFilter = {},
): FleetWhatIfResult {
  const w = FLEET_WINDOWS[window];
  const frac = w.offFraction();
  const det = CONFIG.detection;
  const vms: FleetVm[] = [];

  for (const r of resources) {
    if (!matches(r, filter)) continue;
    const s = series.get(r.id);
    const cost = vmMonthlyCost({ vcpu: r.vcpu!, ramGb: r.ramGb! }, r.region);
    const saving = round2(cost * frac);
    const o = s ? slotOffset(s.start) : 0;
    const inWin = (i: number) => w.inWindow(i + o);
    const cpu = s ? summarize(s.cpuPct.map((v, i) => (inWin(i) ? v : null))) : null;
    const net = s ? summarize(totalNet(s, inWin)) : null;
    const data = s ? dataChecks(s, r.env) : null;
    let status: FleetVmStatus;
    let reason: string;
    if (!s || !data || !data.ok || !cpu || !net) {
      status = 'insufficient';
      reason = data && !data.ok ? data.reasons.join(' ') : 'No samples inside the window.';
    } else if (cpu.p95 >= det.offHoursCpuP95 || net.p95 >= det.offHoursNetP95Mbps) {
      status = 'active';
      const parts: string[] = [];
      if (cpu.p95 >= det.offHoursCpuP95) parts.push(`CPU p95 ${cpu.p95.toFixed(1)}%`);
      if (net.p95 >= det.offHoursNetP95Mbps) parts.push(`network p95 ${net.p95.toFixed(1)} Mbps`);
      reason = `Busy in this window (${parts.join(', ')}) — shutting it down would interrupt real work.`;
    } else {
      status = 'quiet';
      reason = `Quiet in this window (CPU p95 ${cpu.p95.toFixed(1)}%, network p95 ${net.p95.toFixed(2)} Mbps).`;
    }
    if (r.env === 'prod') reason += ' Production VM: never shut down without a manual review.';
    vms.push({
      resourceId: r.id, name: r.name, env: r.env, monthlyCostInr: cost, savingInr: saving, status,
      windowCpuP95: cpu?.p95 ?? null, windowNetP95Mbps: net?.p95 ?? null, reason,
    });
  }

  const sum = (xs: FleetVm[]) => round2(xs.reduce((a, v) => a + v.savingInr, 0));
  const quiet = vms.filter((v) => v.status === 'quiet');
  const counts = {
    total: vms.length,
    quiet: quiet.length,
    active: vms.filter((v) => v.status === 'active').length,
    insufficient: vms.filter((v) => v.status === 'insufficient').length,
    production: vms.filter((v) => v.env === 'prod').length,
  };
  const savingAllInr = sum(vms);
  const savingQuietInr = sum(quiet);
  const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
  const summary =
    counts.total === 0
      ? 'No VMs match this filter.'
      : `Shutting down all ${counts.total} matching VMs ${w.label} would save about ${inr(savingAllInr)}/month (illustrative pricing). ` +
        `${counts.active} are busy in that window and ${counts.insufficient} lack enough data, so the defensible part is ` +
        `${counts.quiet} quiet VMs, about ${inr(savingQuietInr)}/month. Preview only — nothing is approved.`;

  return { window, windowLabel: w.label, offFraction: frac, filter, vms, savingAllInr, savingQuietInr, counts, summary, preview: true };
}
