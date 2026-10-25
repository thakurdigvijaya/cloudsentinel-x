// Speed change (24 Oct): percentiles by quickselect instead of sorting. Must give EXACTLY the sort-based answer.
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../data/random';
import { dailyPercentile, percentileSorted, percentileWhere, summarize } from '../stats';

const sortedOf = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null).sort((a, b) => a - b);

describe('quickselect percentiles equal nearest-rank on sorted data', () => {
  const rand = mulberry32(42);
  const cases: (number | null)[][] = [];
  for (let c = 0; c < 200; c++) {
    const n = 1 + Math.floor(rand() * 400);
    // many duplicates (rounded to integers), some nulls, some negatives
    cases.push(Array.from({ length: n }, () => (rand() < 0.1 ? null : Math.round((rand() - 0.2) * 50))));
  }
  cases.push([5], [null, null], [], [3, 3, 3, 3], [1, 2]);

  it('percentileWhere (p50/p95/p99, with and without a filter) on 205 random arrays', () => {
    for (const xs of cases) {
      for (const p of [50, 95, 99]) {
        const s = sortedOf(xs);
        expect(percentileWhere(xs, p)).toBe(s.length ? percentileSorted(s, p) : null);
        const even = xs.map((v, i) => (i % 2 === 0 ? v : null));
        const se = sortedOf(even);
        expect(percentileWhere(xs, p, (i) => i % 2 === 0)).toBe(se.length ? percentileSorted(se, p) : null);
      }
    }
  });

  it('summarize returns the same p50/p95/p99/max/mean/count as the sort-based definition', () => {
    for (const xs of cases) {
      const s = sortedOf(xs);
      const got = summarize([...xs]); // fresh array (bypasses the cache)
      if (s.length === 0) {
        expect(got).toBeNull();
        continue;
      }
      expect(got).toEqual({
        p50: percentileSorted(s, 50), p95: percentileSorted(s, 95), p99: percentileSorted(s, 99),
        max: s[s.length - 1], mean: s.reduce((a, b) => a + b, 0) / s.length, count: s.length,
      });
    }
  });

  it('dailyPercentile = p95 of each day block, skipping empty days', () => {
    const xs: (number | null)[] = [1, 2, 3, 4, null, null, null, null, 9, 8, 7, null];
    expect(dailyPercentile(xs, 4, 95)).toEqual([4, 9]);
  });
});
