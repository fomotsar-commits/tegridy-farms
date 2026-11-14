// The island order's own split (owner, 2026-11-01): whole percents that always add up to 100, and
// shares of the order that always add up to exactly what was paid.
import { describe, expect, it } from 'vitest';
import { coinsInOrder, dollarsEach, evenPcts, isSplit, minOrderUsd, reweigh, splitByPcts, splitEvenly, splitOrder } from './islandBasket';

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

describe('evenPcts', () => {
  it('adds up to 100 for every list size the order can have', () => {
    for (let n = 1; n <= 12; n++) expect(sum(evenPcts(n))).toBe(100);
    expect(evenPcts(5)).toEqual([20, 20, 20, 20, 20]);
    expect(evenPcts(7)).toEqual([15, 15, 14, 14, 14, 14, 14]);
  });
});

describe('reweigh', () => {
  it('moves one coin and keeps the others in their sizes against each other', () => {
    expect(reweigh([20, 20, 20, 20, 20], 0, 60)).toEqual([60, 10, 10, 10, 10]);
    expect(reweigh([50, 30, 20], 2, 0)).toEqual([63, 37, 0]);
  });

  it('always adds up to 100, whatever is asked', () => {
    let pcts = evenPcts(7);
    for (const [i, v] of [[3, 41], [0, 99], [6, 0], [2, 100], [5, 13], [1, -20], [4, 250], [0, 33.6]] as const) {
      pcts = reweigh(pcts, i, v);
      expect(sum(pcts)).toBe(100);
      expect(pcts.every((p) => Number.isInteger(p) && p >= 0)).toBe(true);
    }
  });

  it('shares what is left evenly when every other coin is at 0', () => {
    expect(reweigh([100, 0, 0], 0, 40)).toEqual([40, 30, 30]);
  });
});

describe('splitByPcts', () => {
  it('pays out exactly the total, a coin at 0% getting nothing', () => {
    const shares = splitByPcts(100_000_001n, [50, 0, 25, 25])!;
    expect(shares.reduce((s, x) => s + x, 0n)).toBe(100_000_001n);
    expect(shares[1]).toBe(0n);
    expect(shares).toEqual([50_000_001n, 0n, 25_000_000n, 25_000_000n]);
  });

  it('refuses a split that does not add up to 100, and a share too small to be one unit', () => {
    expect(splitByPcts(1000n, [50, 49])).toBeNull();
    expect(splitByPcts(1000n, [50.5, 49.5])).toBeNull();
    expect(splitByPcts(10n, [99, 1])).toBeNull();
    expect(isSplit([60, 40], 2)).toBe(true);
    expect(isSplit([60, 40], 3)).toBe(false);
  });
});

describe('splitOrder', () => {
  it('is the even split until a slider moves', () => {
    expect(splitOrder(1001n, 5, null)).toEqual(splitEvenly(1001n, 5));
    expect(splitOrder(1000n, 2, [70, 30])).toEqual([700n, 300n]);
    // A split kept for another list of coins is never applied to this one.
    expect(splitOrder(1000n, 3, [70, 30])).toBeNull();
  });
});

describe('the order around a split', () => {
  it('counts only the coins it buys, and names the least that buys each one a dollar', () => {
    expect(coinsInOrder(5, null)).toBe(5);
    expect(coinsInOrder(5, [40, 0, 60, 0, 0])).toBe(2);
    expect(minOrderUsd(5, null)).toBe(5);
    // 3% of $33.34 is $1.0002: enough.
    expect(minOrderUsd(3, [3, 48, 49])).toBe(33.34);
    expect(dollarsEach(10, 4, [40, 0, 50, 10])).toEqual([4, 0, 5, 1]);
    expect(dollarsEach(10, 4, null)).toEqual([2.5, 2.5, 2.5, 2.5]);
  });
});
