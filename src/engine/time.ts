import { CONFIG } from './config';

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/**
 * Index → calendar. Generated series start on a Monday 00:00 IST (offset 0). Imported series may start at any
 * 15-minute slot: pass `index + slotOffset(series.start)` so weekday/hour are right for every sample.
 */
export function sampleInfo(index: number) {
  const perDay = CONFIG.time.samplesPerDay;
  const day = Math.floor(index / perDay);
  const weekday = day % 7; // 0 = Monday … 6 = Sunday
  const hour = ((index % perDay) * CONFIG.time.stepMinutes) / 60;
  return { day, weekday, hour };
}

// Hot paths (called per sample): plain arithmetic, no object allocation.
const PER_DAY = CONFIG.time.samplesPerDay;
const START_SLOT = (CONFIG.time.businessStartHour * 60) / CONFIG.time.stepMinutes;
const END_SLOT = (CONFIG.time.businessEndHour * 60) / CONFIG.time.stepMinutes;

export function isBusinessSample(index: number): boolean {
  const weekday = Math.floor(index / PER_DAY) % 7;
  const slot = index % PER_DAY;
  return weekday < 5 && slot >= START_SLOT && slot < END_SLOT;
}

/**
 * Number of 15-minute slots from the previous Monday 00:00 IST to `startIso` (0 for the generated data).
 * Throws when the start is not on the 15-minute grid (the importer always aligns it).
 */
export function slotOffset(startIso: string): number {
  const ms = Date.parse(startIso);
  if (!Number.isFinite(ms)) throw new Error(`Invalid series start "${startIso}".`);
  const ist = new Date(ms + IST_OFFSET_MS);
  const weekday = (ist.getUTCDay() + 6) % 7; // Monday = 0
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (minutes % CONFIG.time.stepMinutes !== 0 || ist.getUTCSeconds() !== 0 || ist.getUTCMilliseconds() !== 0) {
    throw new Error(`Series start "${startIso}" is not on the ${CONFIG.time.stepMinutes}-minute grid.`);
  }
  return weekday * PER_DAY + minutes / CONFIG.time.stepMinutes;
}

/** Saturday or Sunday, any hour (D3b weekend-only schedule). */
export function isWeekendSample(index: number): boolean {
  return Math.floor(index / PER_DAY) % 7 >= 5;
}

/** "2026-09-28 10:15 IST" */
export function formatIst(startIso: string, index: number): string {
  const t = Date.parse(startIso) + index * CONFIG.time.stepMinutes * 60 * 1000 + IST_OFFSET_MS;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} IST`;
}
