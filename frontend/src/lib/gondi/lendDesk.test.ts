import { describe, expect, it } from 'vitest';
import { FLOOR_SHARES, floorShareAmount, lendLinkCollection, lenderLink, rateRank } from './lendDesk';

describe('floorShareAmount: one-tap amounts as a share of the floor', () => {
  it('offers 60, 75 and 90 percent', () => {
    expect(FLOOR_SHARES).toEqual([60, 75, 90]);
  });

  it.each([
    [0.3, 90, '0.2700'],
    [0.3, 60, '0.1800'],
    [0.078, 75, '0.0585'],
    [0.078, 90, '0.0702'],
    [5.8, 60, '3.4800'],
  ])('%s floor at %s%% is %s WETH', (floor, pct, out) => {
    expect(floorShareAmount(floor, pct)).toBe(out);
  });

  it('rounds DOWN, so a chip never lends more than the share it names', () => {
    // 0.0123 * 75% = 0.009225
    expect(floorShareAmount(0.0123, 75)).toBe('0.0092');
    expect(Number(floorShareAmount(0.0123, 75))).toBeLessThanOrEqual(0.0123 * 0.75);
  });

  it.each([[null], [undefined], [0], [-1], [NaN], [Infinity]])('no usable floor (%s) gives no amount', (floor) => {
    expect(floorShareAmount(floor as number | null, 75)).toBeNull();
  });

  it('a share that rounds to nothing gives no amount', () => {
    expect(floorShareAmount(0.0001, 60)).toBeNull();
  });
});

describe('rateRank: where a new rate sits among the open offers', () => {
  const others = [{ aprBps: '900' }, { aprBps: '1400' }, { aprBps: '2000' }];

  it('the lowest rate ranks first', () => {
    expect(rateRank(800n, others)).toEqual({ rank: 1, of: 4 });
    expect(rateRank(1500n, others)).toEqual({ rank: 3, of: 4 });
    expect(rateRank(2500n, others)).toEqual({ rank: 4, of: 4 });
  });

  it('a tie ranks with the offer it ties', () => {
    expect(rateRank(1400n, others)).toEqual({ rank: 2, of: 4 });
  });

  it('an empty book makes it the first', () => {
    expect(rateRank(1400n, [])).toEqual({ rank: 1, of: 1 });
  });
});

describe('the link a borrower sends a lender', () => {
  it('opens the Lend tab on the named collection, any letter case', () => {
    expect(lenderLink('https://example.test', 'NAKA')).toBe('https://example.test/nft-finance?lend=NAKA');
    expect(lendLinkCollection('?lend=NAKA')?.symbol).toBe('NAKA');
    expect(lendLinkCollection('?section=amm&lend=gnss')?.symbol).toBe('GNSS');
  });

  it('ignores a collection the venue does not lend on, and a missing one', () => {
    expect(lendLinkCollection('?lend=BAYC')).toBeNull();
    expect(lendLinkCollection('?lend=')).toBeNull();
    expect(lendLinkCollection('')).toBeNull();
  });
});
