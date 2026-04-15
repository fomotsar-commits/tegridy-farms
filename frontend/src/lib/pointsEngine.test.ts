import { describe, it, expect } from 'vitest';
import {
  computeOnChainPoints,
  getStreakMultiplier,
  getTier,
  getNextTier,
  type OnChainMetrics,
} from './pointsEngine';

describe('computeOnChainPoints', () => {
  const base: OnChainMetrics = {
    swapCount: 0, stakedAmount: 0n, stakeDurationSec: 0,
    lpBalance: 0n, referralCount: 0,
  };

  it('returns 0 for zero metrics', () => {
    expect(computeOnChainPoints(base)).toBe(0);
  });

  it('awards 10 points per swap', () => {
    expect(computeOnChainPoints({ ...base, swapCount: 5 })).toBe(50);
  });

  it('awards stake points plus duration bonus', () => {
    const pts = computeOnChainPoints({
      ...base, stakedAmount: 1000n, stakeDurationSec: 86400 * 10,
    });
    // 25 (stake) + 10*2 (duration) = 45
    expect(pts).toBe(45);
  });

  it('awards LP points', () => {
    const pts = computeOnChainPoints({
      ...base, lpBalance: 10n * 10n ** 18n,
    });
    // 50 (lp_provide) + min(200, 10*5) = 50 + 50 = 100
    expect(pts).toBe(100);
  });

  it('is deterministic', () => {
    const metrics = { ...base, swapCount: 3, referralCount: 2 };
    const a = computeOnChainPoints(metrics);
    const b = computeOnChainPoints(metrics);
    expect(a).toBe(b);
  });
});

describe('getStreakMultiplier', () => {
  it('returns 1 for < 7 days', () => expect(getStreakMultiplier(3)).toBe(1));
  it('returns 1.5 for 7 days', () => expect(getStreakMultiplier(7)).toBe(1.5));
  it('returns 2 for 14 days', () => expect(getStreakMultiplier(14)).toBe(2));
  it('returns 3 for 30+ days', () => expect(getStreakMultiplier(30)).toBe(3));
});

describe('getTier / getNextTier', () => {
  it('returns Bronze at 0 points', () => expect(getTier(0)!.name).toBe('Bronze'));
  it('returns Gold at 2000 points', () => expect(getTier(2000)!.name).toBe('Gold'));
  it('returns Diamond at 5000 points', () => expect(getTier(5000)!.name).toBe('Diamond'));
  it('next tier from 0 is Silver', () => expect(getNextTier(0)!.name).toBe('Silver'));
  it('next tier from 5000 is null', () => expect(getNextTier(5000)).toBeNull());
});
