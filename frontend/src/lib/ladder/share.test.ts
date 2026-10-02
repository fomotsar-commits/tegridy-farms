// @vitest-environment node
//
// YOUR SHARE OF POOL WEIGHT — a fact read off the chain, never a yield.
//
// Rewards are split by WEIGHT, so the only share the program actually defines is
// Σ(your positions' weight) / pool.totalWeighted. This pins three things a card could
// get wrong in a direction that flatters the reader:
//
//   1. ROUNDING UP. 70.89% must print 70.8%, never 70.9% — the penaltyPct precedent,
//      applied the other way round: a share must never read larger than it is.
//   2. AN UNREAD READ AS A NUMBER. A partial position list (walletView.truncated) or a
//      missing total is "could not be read", never 0% and never 100%.
//   3. A REAL BUT TINY SHARE AS ZERO. A wallet with weight in the pool is not at 0.0%.
import { describe, it, expect } from 'vitest';
import { sharePct } from './program';

describe('sharePct', () => {
  it('is Σ weight / totalWeighted, in tenths of a percent, FLOORED', () => {
    // 708.9‰ → 70.8%, not 70.9%.
    expect(sharePct({ mineWeight: 7_089n, totalWeighted: 10_000n, truncated: false }))
      .toEqual({ pct: 70.8, label: '70.8%' });
    expect(sharePct({ mineWeight: 1n, totalWeighted: 3n, truncated: false }))
      .toEqual({ pct: 33.3, label: '33.3%' });
    // 2/3 = 66.66…% → 66.6%, where rounding would say 66.7%.
    expect(sharePct({ mineWeight: 2n, totalWeighted: 3n, truncated: false })!.label).toBe('66.6%');
  });

  it('prints a whole share without a trailing ".0"', () => {
    expect(sharePct({ mineWeight: 5n, totalWeighted: 10n, truncated: false })!.label).toBe('50%');
    expect(sharePct({ mineWeight: 10n, totalWeighted: 10n, truncated: false })!.label).toBe('100%');
  });

  it('⚠️ wallet weight ABOVE the pool total is null — the two reads disagree, never 100%', () => {
    // The wallet read and the pool read land separately. Right after a stake the wallet's
    // new weight can exceed a not-yet-refreshed total. Clamping would print up to 100% —
    // a share BETTER than the truth. (earnedNow keeps its own clamp: that one mirrors the
    // program's accrual, lib.rs `position.weight.min(pool.total_weighted)`. Display refuses.)
    expect(sharePct({ mineWeight: 14n, totalWeighted: 10n, truncated: false })).toBeNull();
    expect(sharePct({ mineWeight: 11n, totalWeighted: 10n, truncated: false })).toBeNull();
    // Equal is still a real, readable 100%.
    expect(sharePct({ mineWeight: 10n, totalWeighted: 10n, truncated: false })!.label).toBe('100%');
  });

  it('a real share that floors to 0.0 reads "<0.1%", never "0%"', () => {
    expect(sharePct({ mineWeight: 1n, totalWeighted: 1_000_000n, truncated: false }))
      .toEqual({ pct: 0, label: '<0.1%' });
  });

  it('a wallet with NO weight is a real 0%, because the read landed', () => {
    expect(sharePct({ mineWeight: 0n, totalWeighted: 1_000n, truncated: false }))
      .toEqual({ pct: 0, label: '0%' });
  });

  it('⚠️ UNREADABLE is null — never 0%, never 100%', () => {
    expect(sharePct({ mineWeight: null, totalWeighted: 1_000n, truncated: false })).toBeNull();
    expect(sharePct({ mineWeight: 5n, totalWeighted: null, truncated: false })).toBeNull();
    // A partial position list is a partial SUM: printing it would understate a share
    // the reader really holds, so it is not printed at all.
    expect(sharePct({ mineWeight: 5n, totalWeighted: 10n, truncated: true })).toBeNull();
    // No weight in the pool at all: there is no denominator, not a 0% or 100% share.
    expect(sharePct({ mineWeight: 0n, totalWeighted: 0n, truncated: false })).toBeNull();
    expect(sharePct({ mineWeight: 5n, totalWeighted: 0n, truncated: false })).toBeNull();
  });
});
