import { readPair, type QuoteCoin } from '../lp/quotes';
import {
  ClmmMathError,
  getDeltaAmountsSigned,
  getLiquidityFromSingleAmount0,
  getLiquidityFromSingleAmount1,
  getSqrtPriceAtTick,
  getTickAtSqrtPrice,
  nearestUsableTick,
  priceFromSqrtPriceX64,
  sqrtPriceX64FromPrice,
  usableTickBounds,
} from './math';
import type { PoolStateView } from './program';

/**
 * The Range tab's maths, in the words a person uses: a price is "coin per token" (SOL per
 * BAYLA), whichever way round the pool sorts its two mints. The pool keeps token 1 per
 * token 0; when the token is token 1, a higher price here is a LOWER tick there, and the
 * two ends of a range swap over. Every conversion goes through this file so that swap is
 * made in one place.
 *
 * Every amount that rides a transaction is worked out with the program's own maths
 * (math.ts), rounded as the program rounds. A figure that cannot be worked out is null.
 */

export interface Pair {
  quote: QuoteCoin;
  /** The token priced in the quote coin (BAYLA in BAYLA/SOL). */
  tokenMint: string;
  tokenIsToken0: boolean;
  tokenDecimals: number;
  quoteDecimals: number;
  tickSpacing: number;
}

/** How this site reads a pool, or null for a pool of two coins it does not pair (`readPair`). */
export function pairOf(pool: Pick<PoolStateView, 'tokenMint0' | 'tokenMint1' | 'mintDecimals0' | 'mintDecimals1' | 'tickSpacing'>): Pair | null {
  const r = readPair(pool.tokenMint0, pool.tokenMint1);
  if (!r) return null;
  const tokenIsToken0 = !r.quoteIsToken0;
  return {
    quote: r.quote,
    tokenMint: r.tokenMint,
    tokenIsToken0,
    tokenDecimals: tokenIsToken0 ? pool.mintDecimals0 : pool.mintDecimals1,
    quoteDecimals: tokenIsToken0 ? pool.mintDecimals1 : pool.mintDecimals0,
    tickSpacing: pool.tickSpacing,
  };
}

/** A price as an exact fraction of whole coins: `num / den` quote coins for one whole token. */
export interface Price {
  num: bigint;
  den: bigint;
}

/** The price at a pool's sqrt price, coin per token. */
export function priceAtSqrt(p: Pair, sqrtPriceX64: bigint): Price {
  // The pool's own price: whole token 1 for one whole token 0.
  const raw = p.tokenIsToken0
    ? priceFromSqrtPriceX64(sqrtPriceX64, p.tokenDecimals, p.quoteDecimals)
    : priceFromSqrtPriceX64(sqrtPriceX64, p.quoteDecimals, p.tokenDecimals);
  return p.tokenIsToken0 ? raw : { num: raw.den, den: raw.num };
}

export function priceAtTick(p: Pair, tick: number): Price {
  return priceAtSqrt(p, getSqrtPriceAtTick(tick));
}

/** A price as a number, for display only. */
export function priceNumber(price: Price): number {
  if (price.den === 0n) return Number.NaN;
  // Scale both down together so neither overflows a double.
  const shift = Math.max(0, Math.max(price.num.toString(2).length, price.den.toString(2).length) - 1000);
  return Number(price.num >> BigInt(shift)) / Number(price.den >> BigInt(shift));
}

/** Parse "0.0003" or "1,500.25" into an exact fraction; null for anything else or a price at or below zero. */
export function parsePrice(text: string): Price | null {
  const t = text.replace(/[,\s]/g, '');
  const m = /^(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > 30) return null;
  const num = BigInt(m[1]! + frac);
  const den = 10n ** BigInt(frac.length);
  return num > 0n ? { num, den } : null;
}

/** The pool's sqrt price (Q64.64) at a price in coin per token, in the pool's own order. */
export function sqrtAtPrice(p: Pair, price: Price): bigint {
  return p.tokenIsToken0
    ? sqrtPriceX64FromPrice(price.num, price.den, p.tokenDecimals, p.quoteDecimals)
    : sqrtPriceX64FromPrice(price.den, price.num, p.quoteDecimals, p.tokenDecimals);
}

/** The tick at (or just below) a price, in the pool's own tick order. */
function rawTickAt(p: Pair, price: Price): number {
  return getTickAtSqrtPrice(sqrtAtPrice(p, price));
}

/** A range as the program keeps it: two usable ticks, lower below upper. */
export interface TickRange {
  tickLower: number;
  tickUpper: number;
}

export type RangeProblem = 'unreadable-price' | 'min-not-below-max' | 'outside-the-pool';

/**
 * The range for a lowest and a highest price (coin per token), each moved to the nearest
 * price a position may use. Equal ends after rounding are moved apart by one step.
 */
export function rangeFromPrices(p: Pair, min: Price, max: Price): TickRange | RangeProblem {
  if (min.num * max.den >= max.num * min.den) return 'min-not-below-max';
  let a: number;
  let b: number;
  try {
    a = nearestUsableTick(rawTickAt(p, min), p.tickSpacing);
    b = nearestUsableTick(rawTickAt(p, max), p.tickSpacing);
  } catch (e) {
    if (e instanceof ClmmMathError) return 'outside-the-pool';
    throw e;
  }
  // A higher coin-per-token price is a higher tick when the token is token 0, a lower one otherwise.
  let [lower, upper] = p.tokenIsToken0 ? [a, b] : [b, a];
  const { min: lo, max: hi } = usableTickBounds(p.tickSpacing);
  if (lower === upper) {
    if (upper + p.tickSpacing <= hi) upper += p.tickSpacing;
    else lower -= p.tickSpacing;
  }
  if (lower < lo || upper > hi || lower >= upper) return 'outside-the-pool';
  return { tickLower: lower, tickUpper: upper };
}

/** The range's two ends as prices, lowest first, coin per token. */
export function rangePrices(p: Pair, r: TickRange): { min: Price; max: Price } {
  const atLower = priceAtTick(p, r.tickLower);
  const atUpper = priceAtTick(p, r.tickUpper);
  return p.tokenIsToken0 ? { min: atLower, max: atUpper } : { min: atUpper, max: atLower };
}

/** What a range holds at the pool's price now. */
export type Holds = 'both' | 'token-only' | 'coin-only';

export function holdsNow(p: Pair, pool: Pick<PoolStateView, 'tickCurrent'>, r: TickRange): Holds {
  // Below the range the program holds only token 0; at or above it, only token 1.
  if (pool.tickCurrent < r.tickLower) return p.tokenIsToken0 ? 'token-only' : 'coin-only';
  if (pool.tickCurrent >= r.tickUpper) return p.tokenIsToken0 ? 'coin-only' : 'token-only';
  return 'both';
}

export type Preset = 'close' | 'wide' | 'token-above' | 'coin-below';

const scale = (price: Price, n: bigint, d: bigint): Price => ({ num: price.num * n, den: price.den * d });

/**
 * The presets, from the pool's price now. `close` is 0.8 to 1.25 times today's price, `wide`
 * 0.5 to 2 times. `token-above` holds the token only, from the first usable price above
 * today's to twice it: it sells the token as the price rises into it. `coin-below` holds
 * the coin only, from half today's price up to the last usable price below it: it buys the
 * token as the price falls into it.
 */
export function presetRange(p: Pair, pool: Pick<PoolStateView, 'tickCurrent' | 'sqrtPriceX64'>, preset: Preset): TickRange | RangeProblem {
  const now = priceAtSqrt(p, pool.sqrtPriceX64);
  if (preset === 'close') return rangeFromPrices(p, scale(now, 4n, 5n), scale(now, 5n, 4n));
  if (preset === 'wide') return rangeFromPrices(p, scale(now, 1n, 2n), scale(now, 2n, 1n));
  const s = p.tickSpacing;
  // The first usable tick strictly above the price, and the last at or below it.
  const above = Math.floor(pool.tickCurrent / s) * s + s;
  const atOrBelow = Math.floor(pool.tickCurrent / s) * s;
  const { min: lo, max: hi } = usableTickBounds(s);
  const clamp = (t: number) => Math.min(hi, Math.max(lo, t));
  const twice = (t: number, up: boolean) => {
    // ln(2) / ln(1.0001) ticks is a doubling of the price.
    const step = Math.max(s, Math.round(6931.8 / s) * s);
    return clamp(up ? t + step : t - step);
  };
  // Holding only the token means the range sits where the program holds only the token's side.
  const tokenAbove: TickRange = p.tokenIsToken0
    ? { tickLower: above, tickUpper: twice(above, true) }
    : { tickLower: twice(atOrBelow, false), tickUpper: atOrBelow };
  const coinBelow: TickRange = p.tokenIsToken0
    ? { tickLower: twice(atOrBelow, false), tickUpper: atOrBelow }
    : { tickLower: above, tickUpper: twice(above, true) };
  const r = preset === 'token-above' ? tokenAbove : coinBelow;
  if (r.tickLower >= r.tickUpper || r.tickLower < lo || r.tickUpper > hi) return 'outside-the-pool';
  return r;
}

/** The coins a deposit takes, and the liquidity the program will make of them. */
export interface DepositPlan {
  liquidity: bigint;
  /** What the program charges for that liquidity now, rounded up as it rounds. */
  amount0: bigint;
  amount1: bigint;
  /** Which side the program works the liquidity out from (`base_flag`): true = token 0. */
  baseIsToken0: boolean;
}

/**
 * A deposit worked out from the amount of ONE coin, as the program does when it is given
 * liquidity 0 and a base side: the liquidity that amount buys, then what both sides cost.
 * Null when that coin buys nothing in this range (a token-only range given coin, say).
 */
export function depositFrom(
  p: Pair,
  pool: Pick<PoolStateView, 'tickCurrent' | 'sqrtPriceX64'>,
  r: TickRange,
  side: 'token' | 'coin',
  amount: bigint,
): DepositPlan | null {
  if (amount <= 0n) return null;
  const baseIsToken0 = (side === 'token') === p.tokenIsToken0;
  try {
    const a = getSqrtPriceAtTick(r.tickLower);
    const b = getSqrtPriceAtTick(r.tickUpper);
    const liquidity = baseIsToken0
      ? getLiquidityFromSingleAmount0(pool.sqrtPriceX64, a, b, amount)
      : getLiquidityFromSingleAmount1(pool.sqrtPriceX64, a, b, amount);
    if (liquidity === 0n) return null;
    const [amount0, amount1] = getDeltaAmountsSigned(pool.tickCurrent, pool.sqrtPriceX64, r.tickLower, r.tickUpper, liquidity);
    if (amount0 === 0n && amount1 === 0n) return null;
    return { liquidity, amount0, amount1, baseIsToken0 };
  } catch (e) {
    if (e instanceof ClmmMathError) return null;
    throw e;
  }
}

/** A ceiling `bps` above an amount, rounded up: the most a deposit may take if the price moves. */
export function withTolerance(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new RangeError('tolerance must be 0 to 10,000 basis points');
  return (amount * BigInt(10_000 + bps) + 9_999n) / 10_000n;
}

/** A floor `bps` below an amount, rounded down: the least a removal must return. */
export function lessTolerance(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new RangeError('tolerance must be 0 to 10,000 basis points');
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}
