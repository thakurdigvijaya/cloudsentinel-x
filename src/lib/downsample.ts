// Chart helpers (presentation only — no money or safety maths here).

/**
 * Hourly downsampling for charts: 4 × 15-min samples → 1 point.
 * Uses the MAX of each hour so short peaks stay visible (an average would hide them).
 * Missing hours stay null.
 */
export function hourlyMax(values: readonly (number | null)[], perBucket = 4): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i += perBucket) {
    let max: number | null = null;
    for (let j = i; j < Math.min(i + perBucket, values.length); j++) {
      const v = values[j];
      if (v !== null && (max === null || v > max)) max = v;
    }
    out.push(max);
  }
  return out;
}
