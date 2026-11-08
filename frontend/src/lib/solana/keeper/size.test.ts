import { describe, it, expect } from 'vitest';
import { bestSize, fitLeg, legOut, nearMiss, shortShare } from './size';

describe('nearMiss: whether a smaller trip is worth asking about', () => {
  it('is a trip short by at most 1% of what goes in', () => {
    expect(nearMiss(10_000n, 9_950n, 10_050n)).toBe(true); // short 100 = 1%
    expect(nearMiss(10_000n, 9_949n, 10_050n)).toBe(false); // short 101
    expect(nearMiss(10_000n, 10_050n, 10_050n)).toBe(false); // pays
    expect(nearMiss(1n, 0n, 1n)).toBe(false); // nothing smaller to try
  });
});

describe('shortShare', () => {
  it('is how far short, as a share of what went in; 0 when it pays', () => {
    expect(shortShare(1_000n, 990n, 1_010n)).toBeCloseTo(0.02);
    expect(shortShare(1_000n, 1_010n, 1_010n)).toBe(0);
    expect(shortShare(0n, 0n, 1n)).toBe(0);
  });
});

describe('fitLeg: Jupiter leg as one x·y = k pool through two quotes', () => {
  // A pool 1,000 deep each side with a 0.3% fee: out = 997·u / (1000 + 0.997·u).
  const pool = (u: number) => (997 * u) / (1000 + 0.997 * u);

  it('gives back the pool the quotes came from', () => {
    const f = fitLeg(100, pool(100), 50, pool(50))!;
    for (const u of [10, 75, 200]) expect(legOut(f, u)).toBeCloseTo(pool(u), 6);
  });

  it('fits nothing to quotes no such pool could give', () => {
    expect(fitLeg(100, 90, 100, 90)).toBeNull(); // one size twice
    expect(fitLeg(100, 0, 50, 40)).toBeNull();
    expect(fitLeg(100, 200, 50, 50)).toBeNull(); // twice the size, four times the out
  });
});

describe('bestSize', () => {
  it('finds the top of a gain that rises then falls', () => {
    const gain = (x: bigint) => 0.02 * Number(x) - 1e-10 * Number(x) ** 2; // top at 1e8
    const x = bestSize(400_000_000n, gain);
    expect(Number(x)).toBeGreaterThan(0.999e8);
    expect(Number(x)).toBeLessThan(1.001e8);
  });

  it('stays inside [1, most]', () => {
    expect(bestSize(1_000n, (x) => Number(x))).toBeLessThanOrEqual(1_000n);
    expect(bestSize(1_000n, (x) => -Number(x))).toBeGreaterThanOrEqual(1n);
    expect(bestSize(1n, () => 0)).toBe(1n);
  });
});
