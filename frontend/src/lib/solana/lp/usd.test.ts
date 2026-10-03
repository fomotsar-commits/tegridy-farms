// @vitest-environment node
//
// Dollar lines are a convenience: they exist only when every price behind them was read.
import { describe, it, expect } from 'vitest';
import { usdOfPair, usdOfPool, usdOfSol, usdText } from './usd';

describe('usd lines', () => {
  it('gives no figure without a read SOL price: null, never $0', () => {
    expect(usdOfSol(1_000_000_000n, null)).toBeNull();
    expect(usdOfSol(1_000_000_000n, 0)).toBeNull();
    expect(usdOfSol(1_000_000_000n, Number.NaN)).toBeNull();
    expect(usdOfPool(5_000_000_000n, null)).toBeNull();
    expect(usdOfPair(1n, 1n, 6, 0.001, null)).toBeNull();
    expect(usdText(null)).toBeNull();
  });

  it('values SOL at the price given, a pool at twice its SOL side, a pair at the pool price', () => {
    expect(usdOfSol(2_000_000_000n, 150)).toBe(300);
    expect(usdOfPool(1_000_000_000n, 150)).toBe(300);
    // 0.5 SOL plus 1,000 tokens at 0.0001 SOL each is 0.6 SOL: $90 at $150 a SOL.
    expect(usdOfPair(500_000_000n, 1_000_000_000n, 6, 0.0001, 150)).toBeCloseTo(90, 9);
  });

  it('a pair needs the token decimals and the pool price, or there is no figure', () => {
    expect(usdOfPair(500_000_000n, 1n, null, 0.0001, 150)).toBeNull();
    expect(usdOfPair(500_000_000n, 1n, 6, null, 150)).toBeNull();
    expect(usdOfPair(500_000_000n, 1n, 6, -1, 150)).toBeNull();
  });

  it('writes "about", whole dollars from a thousand up, cents below, and "under" for dust', () => {
    expect(usdText(1234.56)).toBe('about $1,235');
    expect(usdText(12.345)).toBe('about $12.35');
    expect(usdText(0.004)).toBe('under $0.01');
    expect(usdText(0)).toBe('about $0.00');
    expect(usdText(-1)).toBeNull();
    expect(usdText(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
