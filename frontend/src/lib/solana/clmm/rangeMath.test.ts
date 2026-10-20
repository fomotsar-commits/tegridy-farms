// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { BAYLA_MINT, WSOL_MINT } from '../lp/tokenSafety';
import { getSqrtPriceAtTick, getTickAtSqrtPrice } from './math';
import {
  depositFrom,
  holdsNow,
  lessTolerance,
  pairOf,
  parsePrice,
  presetRange,
  priceAtSqrt,
  priceNumber,
  rangeFromPrices,
  rangePrices,
  withTolerance,
  type Pair,
  type TickRange,
} from './rangeMath';

/**
 * The Range tab's maths in a person's words. Each case is run with the token as the pool's
 * token 0 and again as its token 1, because the pool keeps its price the other way round
 * then and every end of a range swaps over.
 */

// BAYLA (6 decimals) against SOL (9): the real pair, both ways round.
const tokenIs0 = { tokenMint0: BAYLA_MINT, tokenMint1: WSOL_MINT, mintDecimals0: 6, mintDecimals1: 9, tickSpacing: 120 };
const tokenIs1 = { tokenMint0: WSOL_MINT, tokenMint1: BAYLA_MINT, mintDecimals0: 9, mintDecimals1: 6, tickSpacing: 120 };
const PAIRS: [string, Pair][] = [
  ['token is token 0', pairOf(tokenIs0)!],
  ['token is token 1', pairOf(tokenIs1)!],
];

/** A pool whose price is 0.0003 SOL per BAYLA, in each orientation. */
function poolAt(p: Pair, price = { num: 3n, den: 10_000n }) {
  const raw = p.tokenIsToken0 ? price : { num: price.den, den: price.num };
  const [d0, d1] = p.tokenIsToken0 ? [6, 9] : [9, 6];
  // sqrt(raw * 10^d1 / 10^d0) as Q64.64, rounded down, the way the site writes an opening price.
  const n = (raw.num * 10n ** BigInt(d1)) << 128n;
  const d = raw.den * 10n ** BigInt(d0);
  let x = 1n << 100n;
  for (let i = 0; i < 200; i++) x = (x + n / d / x) >> 1n;
  while (x * x > n / d) x -= 1n;
  const sqrt = x;
  return { sqrtPriceX64: sqrt, tickCurrent: getTickAtSqrtPrice(sqrt) };
}

describe.each(PAIRS)('%s', (_, p) => {
  const pool = poolAt(p);

  it('reads the pair this site reads: BAYLA priced in SOL', () => {
    expect(p.quote.symbol).toBe('SOL');
    expect(p.tokenMint).toBe(BAYLA_MINT);
    expect([p.tokenDecimals, p.quoteDecimals]).toEqual([6, 9]);
    expect(priceNumber(priceAtSqrt(p, pool.sqrtPriceX64))).toBeCloseTo(0.0003, 9);
  });

  it('a range from two prices comes back as those prices, rounded to usable ones, lowest first', () => {
    const r = rangeFromPrices(p, parsePrice('0.0002')!, parsePrice('0.0005')!) as TickRange;
    expect(Math.abs(r.tickLower % 120)).toBe(0);
    expect(Math.abs(r.tickUpper % 120)).toBe(0);
    expect(r.tickLower).toBeLessThan(r.tickUpper);
    const back = rangePrices(p, r);
    expect(priceNumber(back.min)).toBeCloseTo(0.0002, 5);
    expect(priceNumber(back.max)).toBeCloseTo(0.0005, 5);
    expect(priceNumber(back.min)).toBeLessThan(priceNumber(back.max));
    expect(holdsNow(p, pool, r)).toBe('both');
  });

  it('two prices that round to the same usable price are moved one step apart', () => {
    const r = rangeFromPrices(p, parsePrice('0.00030000')!, parsePrice('0.00030001')!) as TickRange;
    expect(r.tickUpper - r.tickLower).toBe(120);
  });

  it('refuses a minimum at or above the maximum', () => {
    expect(rangeFromPrices(p, parsePrice('0.0005')!, parsePrice('0.0002')!)).toBe('min-not-below-max');
    expect(rangeFromPrices(p, parsePrice('0.0003')!, parsePrice('0.0003')!)).toBe('min-not-below-max');
  });

  it('the token-only preset sits above the price and holds the token; the coin-only one below, holding SOL', () => {
    const up = presetRange(p, pool, 'token-above') as TickRange;
    const down = presetRange(p, pool, 'coin-below') as TickRange;
    expect(holdsNow(p, pool, up)).toBe('token-only');
    expect(holdsNow(p, pool, down)).toBe('coin-only');
    const now = priceNumber(priceAtSqrt(p, pool.sqrtPriceX64));
    expect(priceNumber(rangePrices(p, up).min)).toBeGreaterThan(now);
    expect(priceNumber(rangePrices(p, down).max)).toBeLessThanOrEqual(now);
    // About twice and half today's price at the far ends.
    expect(priceNumber(rangePrices(p, up).max) / now).toBeGreaterThan(1.9);
    expect(now / priceNumber(rangePrices(p, down).min)).toBeGreaterThan(1.9);
    // A deposit into each takes only its own coin.
    const t = depositFrom(p, pool, up, 'token', 1_000_000n)!;
    expect(p.tokenIsToken0 ? t.amount1 : t.amount0).toBe(0n);
    expect(depositFrom(p, pool, up, 'coin', 1_000_000_000n)).toBeNull();
    const c = depositFrom(p, pool, down, 'coin', 1_000_000_000n)!;
    expect(p.tokenIsToken0 ? c.amount0 : c.amount1).toBe(0n);
    expect(depositFrom(p, pool, down, 'token', 1_000_000n)).toBeNull();
  });

  it('the close and wide presets straddle the price', () => {
    for (const preset of ['close', 'wide'] as const) {
      const r = presetRange(p, pool, preset) as TickRange;
      expect(holdsNow(p, pool, r)).toBe('both');
    }
  });

  it('an in-range deposit from the token takes about the matching SOL, and never more of the token than typed', () => {
    const r = rangeFromPrices(p, parsePrice('0.0002')!, parsePrice('0.0005')!) as TickRange;
    const plan = depositFrom(p, pool, r, 'token', 10_000_000n)!;
    const token = p.tokenIsToken0 ? plan.amount0 : plan.amount1;
    const coin = p.tokenIsToken0 ? plan.amount1 : plan.amount0;
    expect(token).toBeLessThanOrEqual(10_000_000n);
    expect(token).toBeGreaterThan(9_990_000n);
    expect(coin > 0n).toBe(true);
    expect(plan.baseIsToken0).toBe(p.tokenIsToken0);
    // The same deposit worked out from that SOL gives (about) the same liquidity back.
    const back = depositFrom(p, pool, r, 'coin', coin)!;
    expect(Number(back.liquidity) / Number(plan.liquidity)).toBeCloseTo(1, 4);
  });
});

describe('prices typed in', () => {
  it('parses plain decimals and grouped thousands, and nothing else', () => {
    expect(parsePrice('0.0003')).toEqual({ num: 3n, den: 10_000n });
    expect(parsePrice('1,500.25')).toEqual({ num: 150025n, den: 100n });
    for (const bad of ['', '0', '-1', '1e-4', 'abc', '0.']) expect(parsePrice(bad), bad).toBeNull();
  });
});

describe('tolerances', () => {
  it('a ceiling rounds up and a floor rounds down', () => {
    expect(withTolerance(1_000n, 100)).toBe(1_010n);
    expect(withTolerance(1n, 1)).toBe(2n);
    expect(withTolerance(0n, 100)).toBe(0n);
    expect(lessTolerance(1_000n, 100)).toBe(990n);
    expect(lessTolerance(1n, 1)).toBe(0n);
    expect(() => withTolerance(1n, -1)).toThrow();
    expect(getSqrtPriceAtTick(0)).toBe(1n << 64n);
  });
});
