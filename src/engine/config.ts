// ALL thresholds and prices live here. Keep in sync with assumptions.md.
import type { Env, Region, Size } from './types';

export const CONFIG = {
  time: {
    hoursPerMonth: 730, // A1
    samplesPerDay: 96, // A2 (15-min)
    stepMinutes: 15,
    businessStartHour: 8, // A3 08:00 IST
    businessEndHour: 20, // A3 20:00 IST
    weekdaysPerMonth: 21.7,
  },
  pricing: {
    perVcpuInr: 700, // B1
    perGbRamInr: 180, // B1
    perGbDiskInr: 8, // B4
    publicIpInr: 300, // B5
    regionMultiplier: { mumbai: 1, bengaluru: 1, noida: 0.95 } as Record<Region, number>, // B2
  },
  /** B3 VM catalog (vCPU / GB) */
  catalog: [
    { vcpu: 1, ramGb: 2 },
    { vcpu: 2, ramGb: 4 },
    { vcpu: 2, ramGb: 8 },
    { vcpu: 4, ramGb: 8 },
    { vcpu: 4, ramGb: 16 },
    { vcpu: 8, ramGb: 16 },
    { vcpu: 8, ramGb: 32 },
    { vcpu: 16, ramGb: 32 },
    { vcpu: 16, ramGb: 64 },
  ] as Size[],
  detection: {
    idleCpuP95: 5, // D1
    idleNetP95Mbps: 1, // D1
    idleMinDays: 14, // D1
    oversizedCpuP95: 40, // D2
    oversizedMemP95: 50, // D2
    offHoursCpuP95: 5, // D3
    offHoursNetP95Mbps: 1, // D3 — network must also be quiet off-hours (team decision 24 Oct)
    weekendCpuP95: 5, // D3b weekend-only schedule (brief: "dev environments idle on weekends")
    weekendNetP95Mbps: 1, // D3b
    orphanMinDays: 7, // D4
    burstinessBursty: 3, // C3
  },
  foresight: {
    // P0 safety correction 25 Oct: projected CPU load >100% cannot be defended as
    // having enough capacity, even in staging/dev. A 2% max-memory reserve avoids
    // treating predicted full RAM exhaustion as a safe resize. P99 limits still
    // maintain the larger routine headroom (80% prod, 85% non-prod).
    prod: { cpuP95: 70, cpuP99: 85, cpuMax: 100, memP99: 80, memMax: 98, coverage: 0.9 }, // E1–E5, E8 prod
    nonProd: { cpuP95: 80, cpuP99: 90, cpuMax: 100, memP99: 85, memMax: 98, coverage: 0.85 }, // E1–E5, E8 non-prod
    minHistoryDays: 14, // E6
    maxSampleAgeHours: 24, // E7
    maxImplausibleFraction: 0.01, // E9 — samples reporting exactly 0% memory (a running VM always uses some RAM)
  },
  risk: { lowMarginPts: 15, mediumMarginPts: 5 },
  scenarios: {
    traffic25: { cpu: 1.25, mem: 1.1 }, // F2
    traffic60: { cpu: 1.6, mem: 1.25 }, // F3
    cpuBurst: { multiplierOfP99: 2, startHour: 10, hours: 2 }, // F4
    memPressure: { mem: 1.35 }, // F5
    missingData: { dropFraction: 0.4, seed: 2026 }, // F6
  },
  alerts: {
    spikeSigma: 3, // I1
    spikeMinJumpPts: 20, // I1 guard against tiny absolute jumps
    weekendRatio: 1.5, // I5 weekend p95 CPU > 1.5 × weekday p95 (prod)
    weekendMinP95: 20, // I5 guard: ignore when weekend p95 is below 20% (tiny absolute numbers)
    baselineDays: 7, // I1
    capacityLimitPct: 85, // I3
    capacityHorizonDays: 14, // I3
    recurringBandPts: 5, // I3 recurring: every day's p95 within 5 points of the limit (or above)
    recurringMaxSlope: 0.2, // I3 recurring: not trending (points/day)
    recurringMaxSd: 3, // I3 recurring: day-to-day spread of daily p95
    monthlyBudgetInr: 600000, // I4 (open decision in memory.md)
    spendIncreasePct: 15, // I2 week-over-week
    spendWindowDays: 7, // I2 / I4 window
  },
} as const;

export function limitsFor(env: Env) {
  return env === 'prod' ? CONFIG.foresight.prod : CONFIG.foresight.nonProd;
}

/** A3: (730 − 12 h × 21.7 weekdays) / 730 ≈ 0.6433 */
export function offHoursFraction(): number {
  const t = CONFIG.time;
  const businessHours = (t.businessEndHour - t.businessStartHour) * t.weekdaysPerMonth;
  return (t.hoursPerMonth - businessHours) / t.hoursPerMonth;
}

/** A3b: weekend share of the month = (730 − 24 h × 21.7 weekdays) / 730 ≈ 0.2866 */
export function weekendFraction(): number {
  const t = CONFIG.time;
  return (t.hoursPerMonth - 24 * t.weekdaysPerMonth) / t.hoursPerMonth;
}

export type ScheduleWindow = 'nights-and-weekends' | 'weekends';

/** Share of the month a VM is OFF under each schedule window. */
export function scheduleOffFraction(w: ScheduleWindow = 'nights-and-weekends'): number {
  return w === 'weekends' ? weekendFraction() : offHoursFraction();
}
