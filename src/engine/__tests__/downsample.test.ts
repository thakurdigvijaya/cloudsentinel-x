import { describe, expect, it } from 'vitest';
import { hourlyMax } from '../../lib/downsample';

describe('hourlyMax (chart downsampling)', () => {
  it('keeps the peak of each hour and the right number of points', () => {
    expect(hourlyMax([1, 9, 2, 3, 4, 4, 4, 4])).toEqual([9, 4]);
    expect(hourlyMax(new Array(2880).fill(1))).toHaveLength(720);
  });
  it('a 15-minute spike is not averaged away', () => {
    const v = new Array(96).fill(10);
    v[41] = 95;
    expect(Math.max(...(hourlyMax(v) as number[]))).toBe(95);
  });
  it('fully missing hours stay null; partially missing hours use what exists', () => {
    expect(hourlyMax([null, null, null, null, null, 7, null, null])).toEqual([null, 7]);
  });
});
