import { formatSolPrice } from '../../../lib/solana/lp/format';
import { priceAtTick, priceNumber, type Pair, type TickRange } from '../../../lib/solana/clmm/rangeMath';
import { usableTickBounds } from '../../../lib/solana/clmm/math';
import { runAmounts, valueSpan, type Depth, type RestingOrder } from '../../../lib/solana/clmm/depth';
import type { PoolStateView } from '../../../lib/solana/clmm/program';
import { tokenWord } from './rangeText';

/**
 * The depth chart's words and axis. The chart draws on "u", a tick turned so that u grows
 * with the price as shown: coin per token, or token per coin once flipped. A price step is
 * one tick spacing, and a log price axis is a straight line in ticks.
 */

/** +1 when the shown price rises with the tick, -1 when it falls. */
export function axisSign(pair: Pair, flipped: boolean): 1 | -1 {
  return pair.tokenIsToken0 !== flipped ? 1 : -1;
}

export const tokenUnit = (pair: Pair) => (tokenWord(pair) === 'tokens' ? 'token' : tokenWord(pair));

/** "SOL per BAYLA", or "BAYLA per SOL" once flipped. */
export function unitText(pair: Pair, flipped: boolean): string {
  return flipped ? `${tokenUnit(pair)} per ${pair.quote.symbol}` : `${pair.quote.symbol} per ${tokenUnit(pair)}`;
}

/** The shown price at a tick, as a number (for drawing and words only). */
export function shownPrice(pair: Pair, flipped: boolean, tick: number): number {
  const p = priceNumber(priceAtTick(pair, tick));
  return flipped ? 1 / p : p;
}

export function priceWords(pair: Pair, flipped: boolean, tick: number): string {
  return formatSolPrice(shownPrice(pair, flipped, tick));
}

/** A tick, possibly between two, for a price in coin per token: where a line is drawn. */
export function tickOfPrice(pair: Pair, coinPerToken: number): number | null {
  if (!Number.isFinite(coinPerToken) || coinPerToken <= 0) return null;
  // The pool keeps whole-unit price token 1 per token 0; a tick is a 0.01% step of the raw ratio.
  const raw = pair.tokenIsToken0
    ? coinPerToken * 10 ** (pair.quoteDecimals - pair.tokenDecimals)
    : (1 / coinPerToken) * 10 ** (pair.tokenDecimals - pair.quoteDecimals);
  const t = Math.log(raw) / Math.log(1.0001);
  return Number.isFinite(t) ? t : null;
}

/** The tick at the pool's own price, between two whole ticks, for drawing its line. */
export function tickOfSqrt(sqrtPriceX64: bigint): number {
  return (2 * Math.log(Number(sqrtPriceX64) / 2 ** 64)) / Math.log(1.0001);
}

/** A span of u, lowest first. */
export interface View {
  lo: number;
  hi: number;
}

export const toU = (sign: 1 | -1, from: number, to: number): View => (sign > 0 ? { lo: from, hi: to } : { lo: -to, hi: -from });

/** The u bounds a position may use at this spacing. */
export function uBounds(spacing: number, sign: 1 | -1): View {
  const { min, max } = usableTickBounds(spacing);
  return toU(sign, min, max);
}

const pad = (v: View, share: number, spacing: number, minSteps: number, b: View): View => {
  const mid = (v.lo + v.hi) / 2;
  const half = Math.max(((v.hi - v.lo) / 2) * (1 + share), (minSteps * spacing) / 2);
  return { lo: Math.max(b.lo, mid - half), hi: Math.min(b.hi, mid + half) };
};

/** The view around a range and the pool's price. */
export function fitRange(r: TickRange, tickNow: number, spacing: number, sign: 1 | -1): View {
  const u = toU(sign, r.tickLower, r.tickUpper);
  const now = sign * tickNow;
  return pad({ lo: Math.min(u.lo, now), hi: Math.max(u.hi, now) }, 0.5, spacing, 12, uBounds(spacing, sign));
}

/** The view holding nearly all of the value in use (0.5% to 99.5% of it) and the pool's price. */
export function fitLiquidity(d: Depth, pool: Pick<PoolStateView, 'sqrtPriceX64' | 'tickCurrent'>, sign: 1 | -1): View {
  const span = valueSpan(d, pool, 0.005, 0.995);
  const now = sign * pool.tickCurrent;
  const b = uBounds(d.spacing, sign);
  if (!span) return pad({ lo: now, hi: now }, 0, d.spacing, 32, b);
  const u = toU(sign, span.from, span.to);
  return pad({ lo: Math.min(u.lo, now), hi: Math.max(u.hi, now) }, 0.2, d.spacing, 16, b);
}

/** An edge moved to u, snapped to a price step, kept inside the bounds and one step clear of the other edge. */
export function moveEdge(r: TickRange, which: 'lo' | 'hi', u: number, spacing: number, sign: 1 | -1): TickRange {
  const e = toU(sign, r.tickLower, r.tickUpper);
  const b = uBounds(spacing, sign);
  let x = Math.round(u / spacing) * spacing;
  x = Math.min(b.hi, Math.max(b.lo, x));
  const lo = which === 'lo' ? Math.min(x, e.hi - spacing) : e.lo;
  const hi = which === 'hi' ? Math.max(x, e.lo + spacing) : e.hi;
  const [t1, t2] = [sign * lo, sign * hi];
  const tickLower = Math.min(t1, t2);
  const tickUpper = Math.max(t1, t2);
  return { tickLower: tickLower === 0 ? 0 : tickLower, tickUpper: tickUpper === 0 ? 0 : tickUpper };
}

/** An amount to three figures, for a line read at a glance: "41,200", "12.9", "0.00413". */
export function roughAmount(raw: bigint, decimals: number): string {
  if (raw === 0n) return '0';
  const v = Number(raw) / 10 ** decimals;
  if (!Number.isFinite(v)) return 'more than this page can write';
  if (v < 0.001) return 'under 0.001';
  return Number(v.toPrecision(3)).toLocaleString('en-US', { maximumFractionDigits: 20 });
}

const sellsToken = (pair: Pair, o: RestingOrder) => o.sellsToken0 === pair.tokenIsToken0;

/** "12,000 BAYLA to sell at 0.000431 SOL per BAYLA" or "4.1 SOL to buy BAYLA at …". */
export function orderWords(pair: Pair, flipped: boolean, o: RestingOrder): string {
  const at = `${priceWords(pair, flipped, o.tick)} ${unitText(pair, flipped)}`;
  return sellsToken(pair, o)
    ? `${roughAmount(o.amount, pair.tokenDecimals)} ${tokenUnit(pair)} to sell at ${at}`
    : `${roughAmount(o.amount, pair.quoteDecimals)} ${pair.quote.symbol} to buy ${tokenUnit(pair)} at ${at}`;
}

export const orderSellsToken = sellsToken;

/** Both coins a span of ticks trades, token first: "41,200 BAYLA and 12.9 SOL". */
export function spanAmounts(pair: Pair, from: number, to: number, liquidity: bigint): string {
  const { amount0, amount1 } = runAmounts(from, to, liquidity);
  const [token, coin] = pair.tokenIsToken0 ? [amount0, amount1] : [amount1, amount0];
  return `${roughAmount(token, pair.tokenDecimals)} ${tokenUnit(pair)} and ${roughAmount(coin, pair.quoteDecimals)} ${pair.quote.symbol}`;
}

/** Two ticks as shown prices, lowest first: "0.000410 and 0.000415". */
export function spanPrices(pair: Pair, flipped: boolean, from: number, to: number): [string, string] {
  const a = shownPrice(pair, flipped, from);
  const b = shownPrice(pair, flipped, to);
  return a <= b ? [formatSolPrice(a), formatSolPrice(b)] : [formatSolPrice(b), formatSolPrice(a)];
}

/** What tapping one price step says. */
export function stepWords(pair: Pair, flipped: boolean, from: number, to: number, liquidity: bigint | null, orders: RestingOrder[]): string {
  const [a, b] = spanPrices(pair, flipped, from, to);
  const head = `Between ${a} and ${b} ${unitText(pair, flipped)}: `;
  const body =
    liquidity === null
      ? 'this part of the pool was not read.'
      : liquidity === 0n
        ? 'no liquidity is in use here.'
        : `${spanAmounts(pair, from, to, liquidity)} of liquidity would trade here.`;
  const resting = orders.length ? ` Resting orders here: ${orders.map((o) => orderWords(pair, flipped, o)).join('; ')}.` : '';
  return head + body + resting;
}

/** The chart in one paragraph, for a screen reader. */
export function summaryWords(o: { pair: Pair; flipped: boolean; depth: Depth; pool: Pick<PoolStateView, 'sqrtPriceX64' | 'tickCurrent'>; range: TickRange | null; nowWords: string }): string {
  const { pair, flipped, depth: d, range } = o;
  const unit = unitText(pair, flipped);
  const parts: string[] = [];
  if (range) {
    const [a, b] = spanPrices(pair, flipped, range.tickLower, range.tickUpper);
    const tc = o.pool.tickCurrent;
    const inside = range.tickLower <= tc && tc < range.tickUpper;
    const poolBelow = tc < range.tickLower;
    const shownBelow = poolBelow === (axisSign(pair, flipped) > 0);
    const where = inside ? 'inside' : shownBelow ? 'below' : 'above';
    parts.push(`This pool’s price, ${o.nowWords} ${unit}, is ${where} your range, ${a} to ${b}.`);
  } else {
    parts.push(`This pool’s price is ${o.nowWords} ${unit}.`);
  }
  const most = valueSpan(d, o.pool, 0.1, 0.9);
  if (most) {
    const [a, b] = spanPrices(pair, flipped, most.from, most.to);
    parts.push(`Most liquidity sits between ${a} and ${b}.`);
  } else {
    parts.push('No liquidity is in use in what was read.');
  }
  const prices = new Set(d.orders.map((x) => x.tick)).size;
  if (prices) parts.push(`Resting orders at ${prices} ${prices === 1 ? 'price' : 'prices'}.`);
  if (d.bandsUnread) parts.push(`${d.bandsUnread} ${d.bandsUnread === 1 ? 'band' : 'bands'} could not be read.`);
  if (d.beyond.below || d.beyond.above) parts.push('Bands beyond this window were not read.');
  return parts.join(' ');
}

/** The read time as the card stamps it: "14:02:11 UTC". */
export function stampWords(at: number): string {
  return `${new Date(at).toISOString().slice(11, 19)} UTC`;
}
