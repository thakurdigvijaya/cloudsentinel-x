import { describe, expect, it } from 'vitest';
import { shouldAnimateCountUp } from '../CountUp';

describe('financial KPI displays', () => {
  it('never animates monetary totals (avoids misleading intermediate amounts)', () => {
    for (const text of ['₹8,35,622', '₹2,18,850', '₹0', '₹2,18,849.99', 'Savings ₹7,307.75 / month']) {
      expect(shouldAnimateCountUp(text)).toBe(false);
    }
  });

  it('retains the original animation for non-financial counters', () => {
    for (const text of ['59 changes', '122 resources', '51', '60% workload', '90 VMs']) {
      expect(shouldAnimateCountUp(text)).toBe(true);
    }
  });

  it('reproduces the previously observed transient numbers at the same animation timestamp', () => {
    // At 1,050 ms of the old 1,100-ms cubic easing, both values were just below the truth.
    const elapsedMs = 1050;
    const k = elapsedMs / 1100;
    const ease = 1 - Math.pow(1 - k, 3);
    expect(Math.round(218849.99 * ease)).toBe(218829);
    expect(Math.round(835622 * ease)).toBe(835544);
    // A fraction of a millisecond earlier produces the reported browser ₹8,35,543.
    const earlierEase = 1 - Math.pow(1 - 1049.8 / 1100, 3);
    expect(Math.round(835622 * earlierEase)).toBe(835543);
  });
});
