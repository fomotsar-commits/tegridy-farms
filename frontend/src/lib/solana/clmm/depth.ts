import { getArrayStartIndex, initializedTickArrayStarts } from './bitmap';
import { MIN_SQRT_PRICE_X64, MAX_SQRT_PRICE_X64, getSqrtPriceAtTick, isqrt, usableTickBounds } from './math';
import { quoteSwap } from './quote';
import { TICK_ARRAY_SIZE, tickHasLimitOrders, tickIsInitialized, type AmmConfigView, type BitmapExtensionView, type PoolStateView, type TickArrayView } from './program';

/**
 * A pool's depth, walked from the chain: the liquidity in use at each price step, from the
 * pool's own `liquidity` at `tick_current` through each tick's `liquidityNet`, and the
 * orders resting at each tick. Only bands that were read are walked. A band that did not
 * read ends the walk on its side; past the read window nothing is drawn as empty.
 */

/** The used bands read on each side of the price, beside the band at the price. */
export const WINDOW_BANDS_EACH_SIDE = 8;

export type WindowBand = { start: number; band: TickArrayView } | { start: number; band: null; detail: string };

/** What one read of the window holds: the pool and its bands, at one time. */
export interface BandsWindow {
  /** The pool as read in the same call as its bands, so the walk is at one slot. */
  pool: PoolStateView;
  extension: BitmapExtensionView | null;
  /** Lowest start first. */
  bands: WindowBand[];
  /** The start of the nearest used band past the window on each side; null when none. */
  beyondBelow: number | null;
  beyondAbove: number | null;
  /** When the answer came (ms since 1970). */
  at: number;
}

/** Which used bands the window reads: the one at the price and `each` on each side. */
export function bandWindow(
  pool: Pick<PoolStateView, 'tickArrayBitmap' | 'tickSpacing' | 'tickCurrent'>,
  ext: BitmapExtensionView | null,
  each = WINDOW_BANDS_EACH_SIDE,
): { starts: number[]; beyondBelow: number | null; beyondAbove: number | null } {
  const here = getArrayStartIndex(pool.tickCurrent, pool.tickSpacing);
  const used = initializedTickArrayStarts(pool, ext);
  const below = used.filter((s) => s < here);
  const above = used.filter((s) => s > here);
  return {
    starts: [...below.slice(below.length - Math.min(each, below.length)), ...(used.includes(here) ? [here] : []), ...above.slice(0, each)],
    beyondBelow: below.length > each ? below[below.length - each - 1]! : null,
    beyondAbove: above.length > each ? above[each]! : null,
  };
}

/** Ticks `[from, to)` where the liquidity in use is one value. */
export interface DepthRun {
  from: number;
  to: number;
  liquidity: bigint;
}

/**
 * Ticks `[from, to)` that are not known: a band that did not read (`unread`), past the
 * window (`not-read`), or past a band that did not read, where the walk cannot go on.
 */
export interface DepthGap {
  from: number;
  to: number;
  kind: 'unread' | 'not-read' | 'not-known';
}

export interface RestingOrder {
  tick: number;
  /** What rests there, in the coin it sells. */
  amount: bigint;
  /** Above the price only token 0 rests for sale; at or below it, only token 1. */
  sellsToken0: boolean;
}

export interface Depth {
  spacing: number;
  tickCurrent: number;
  /** Known liquidity, lowest first, end to end. */
  runs: DepthRun[];
  gaps: DepthGap[];
  orders: RestingOrder[];
  bandsRead: number;
  bandsUnread: number;
  /** Used bands exist past the window on that side. */
  beyond: { below: boolean; above: boolean };
  /** The pool marks no band and has no liquidity: nothing was ever put in. */
  empty: boolean;
}

/** One walk of the window's bands, out from the price on each side. */
export function walkDepth(w: BandsWindow): Depth {
  const { pool } = w;
  const s = pool.tickSpacing;
  const span = s * TICK_ARRAY_SIZE;
  const tc = pool.tickCurrent;
  const here = getArrayStartIndex(tc, s);
  const k0 = Math.floor(tc / s) * s;
  const { min: lowest, max: highest } = usableTickBounds(s);
  const gaps = new Map<number, DepthGap>();
  const orders: RestingOrder[] = [];

  const ticksOf = (b: TickArrayView) =>
    b.ticks.map((t, i) => ({ t, tick: b.startTickIndex + i * s })).filter((x) => tickIsInitialized(x.t));
  const noteOrders = (b: TickArrayView, side: (tick: number) => boolean) => {
    for (const { t, tick } of ticksOf(b)) {
      if (side(tick) && tickHasLimitOrders(t)) orders.push({ tick, amount: t.ordersAmount + t.partFilledOrdersRemaining, sellsToken0: tick > tc });
    }
  };

  // Up from the price: crossing tick t rightward adds its net.
  const right: DepthRun[] = [];
  {
    let L = pool.liquidity;
    let from = k0;
    const close = (to: number) => {
      if (to > from) right.push({ from, to, liquidity: L });
      from = to;
    };
    let ended = false;
    for (const b of w.bands.filter((x) => x.start >= here)) {
      if (b.band === null) {
        close(Math.max(b.start, k0));
        gaps.set(b.start, { from: b.start, to: b.start + span, kind: 'unread' });
        if (b.start + span < highest) gaps.set(b.start + span, { from: b.start + span, to: highest, kind: 'not-known' });
        ended = true;
        break;
      }
      noteOrders(b.band, (tick) => tick > tc);
      for (const { t, tick } of ticksOf(b.band)) {
        if (tick <= tc || t.liquidityNet === 0n) continue;
        close(tick);
        L += t.liquidityNet;
      }
    }
    if (!ended) {
      if (w.beyondAbove !== null) {
        close(w.beyondAbove);
        gaps.set(w.beyondAbove, { from: w.beyondAbove, to: highest, kind: 'not-read' });
      } else close(highest);
    }
  }

  // Down from the price: below tick t (t at or under the price) the liquidity is less its net.
  const left: DepthRun[] = [];
  {
    let L = pool.liquidity;
    let to = k0;
    const close = (from: number) => {
      if (from < to) left.push({ from, to, liquidity: L });
      to = from;
    };
    let ended = false;
    for (const b of w.bands.filter((x) => x.start <= here).reverse()) {
      if (b.band === null) {
        if (b.start !== here) close(b.start + span);
        gaps.set(b.start, { from: b.start, to: b.start + span, kind: 'unread' });
        if (b.start > lowest) gaps.set(lowest - 1, { from: lowest, to: b.start, kind: 'not-known' });
        ended = true;
        break;
      }
      if (b.start !== here) noteOrders(b.band, () => true);
      else noteOrders(b.band, (tick) => tick <= tc);
      for (const { t, tick } of ticksOf(b.band).reverse()) {
        if (tick > tc || t.liquidityNet === 0n) continue;
        close(tick);
        L -= t.liquidityNet;
      }
    }
    if (!ended) {
      if (w.beyondBelow !== null) {
        close(w.beyondBelow + span);
        gaps.set(w.beyondBelow, { from: lowest, to: w.beyondBelow + span, kind: 'not-read' });
      } else close(lowest);
    }
  }

  // The band at the price did not read: nothing on either side of it is known.
  const hereGap = gaps.get(here);
  const runs = mergeRuns(hereGap?.kind === 'unread' ? [] : [...left.reverse(), ...right]);
  const unread = w.bands.filter((b) => b.band === null).length;
  return {
    spacing: s,
    tickCurrent: tc,
    runs,
    gaps: [...gaps.values()].sort((a, b) => a.from - b.from),
    orders: orders.sort((a, b) => a.tick - b.tick),
    bandsRead: w.bands.length - unread,
    bandsUnread: unread,
    beyond: { below: w.beyondBelow !== null, above: w.beyondAbove !== null },
    empty: w.bands.length === 0 && w.beyondBelow === null && w.beyondAbove === null && pool.liquidity === 0n,
  };
}

function mergeRuns(runs: DepthRun[]): DepthRun[] {
  const out: DepthRun[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && last.to === r.from && last.liquidity === r.liquidity) last.to = r.to;
    else out.push({ ...r });
  }
  return out;
}

/** The liquidity in use on the step starting at `tick`, or null where it is not known. */
export function liquidityAt(d: Pick<Depth, 'runs'>, tick: number): bigint | null {
  const r = d.runs.find((x) => x.from <= tick && tick < x.to);
  return r ? r.liquidity : null;
}

/**
 * What crossing ticks `[from, to)` with `liquidity` in use trades, rounded down: token 0
 * and token 1. Exact bigint maths, with no u64 cap, so a wide run still reads.
 */
export function runAmounts(from: number, to: number, liquidity: bigint): { amount0: bigint; amount1: bigint } {
  if (liquidity <= 0n || to <= from) return { amount0: 0n, amount1: 0n };
  const a = getSqrtPriceAtTick(from);
  const b = getSqrtPriceAtTick(to);
  return { amount0: ((liquidity << 64n) * (b - a)) / (a * b), amount1: (liquidity * (b - a)) >> 64n };
}

/**
 * What each run holds now, valued in token 1 at the pool's price: token 0 above the price,
 * token 1 below it, both on the step at the price. For "where most of the money sits".
 */
export function runValues(d: Pick<Depth, 'runs'>, pool: Pick<PoolStateView, 'sqrtPriceX64' | 'tickCurrent'>): bigint[] {
  const p = pool.sqrtPriceX64;
  const in1 = (amount0: bigint) => (amount0 * p * p) >> 128n;
  return d.runs.map((r) => {
    if (r.liquidity <= 0n) return 0n;
    const a = getSqrtPriceAtTick(r.from);
    const b = getSqrtPriceAtTick(r.to);
    if (p <= a) return in1(runAmounts(r.from, r.to, r.liquidity).amount0);
    if (p >= b) return runAmounts(r.from, r.to, r.liquidity).amount1;
    const amount0 = ((r.liquidity << 64n) * (b - p)) / (p * b);
    const amount1 = (r.liquidity * (p - a)) >> 64n;
    return in1(amount0) + amount1;
  });
}

/** The ticks between which a share of the value sits, from `lowShare` to `highShare` of it. */
export function valueSpan(d: Pick<Depth, 'runs'>, pool: Pick<PoolStateView, 'sqrtPriceX64' | 'tickCurrent'>, lowShare: number, highShare: number): { from: number; to: number } | null {
  const v = runValues(d, pool);
  const total = v.reduce((a, b) => a + b, 0n);
  if (total === 0n) return null;
  const at = (share: number) => (total * BigInt(Math.round(share * 10_000))) / 10_000n;
  const lo = at(lowShare);
  const hi = at(highShare);
  let sum = 0n;
  let from: number | null = null;
  let to: number | null = null;
  d.runs.forEach((r, i) => {
    if (v[i] === 0n) return;
    const before = sum;
    sum += v[i]!;
    if (from === null && sum > lo) from = r.from;
    if (to === null && before < hi && sum >= hi) to = r.to;
  });
  return from !== null && to !== null ? { from, to } : null;
}

/** What it takes to move the pool's price by a factor: the coin in, fee and resting orders included. */
export type MoveCost =
  | { kind: 'ok'; amountIn: bigint; inIsToken0: boolean }
  /** Nothing is in use as far as that price: it moves for next to nothing. */
  | { kind: 'free' }
  /** Nothing is in use from some price on that way, and no band past it: the program refuses a swap that far. */
  | { kind: 'none-that-way' }
  | { kind: 'paused' }
  | { kind: 'not-open' }
  | { kind: 'unread'; detail: string };

/** A probe far larger than any pool: the swap stops at the price limit, and what it used is the answer. */
const MOVE_PROBE = 1n << 62n;

/**
 * The swap that takes the pool's own price (token 1 per token 0) to `factor` times itself,
 * run through the program's swap maths (quote.ts) with that price as its limit.
 */
export function moveCost(w: BandsWindow, config: Pick<AmmConfigView, 'tradeFeeRate' | 'protocolFeeRate' | 'fundFeeRate'>, factor: { num: bigint; den: bigint }): MoveCost {
  const sqrt = w.pool.sqrtPriceX64;
  const limit = isqrt((sqrt * sqrt * factor.num) / factor.den);
  if (limit <= MIN_SQRT_PRICE_X64 || limit >= MAX_SQRT_PRICE_X64) return { kind: 'unread', detail: 'the price cannot move that far' };
  const zeroForOne = factor.num < factor.den;
  const bands = new Map<number, TickArrayView>();
  for (const b of w.bands) if (b.band) bands.set(b.start, b.band);
  const q = quoteSwap({
    pool: w.pool,
    config,
    band: (start) => bands.get(start),
    extension: w.extension,
    zeroForOne,
    isBaseInput: true,
    amount: MOVE_PROBE,
    sqrtPriceLimitX64: limit,
    blockTimestamp: Math.floor(w.at / 1000),
  });
  if (q.kind === 'ok') return { kind: 'ok', amountIn: q.amountIn, inIsToken0: zeroForOne };
  if (q.kind === 'needs-band') return { kind: 'unread', detail: 'a band it crosses was not read' };
  if (q.code === 'TooSmallInputOrOutputAmount') return { kind: 'free' };
  // No band that way (bitmap.ts), or no used tick past the last one crossed (swap.rs:598): one fact.
  if (q.code === 'InsufficientLiquidityForDirection' || q.code === 'LiquidityInsufficient') return { kind: 'none-that-way' };
  if (q.code === 'NotApproved') return { kind: 'paused' };
  if (q.code === 'RequireGtViolated') return { kind: 'not-open' };
  return { kind: 'unread', detail: `the swap maths stopped (${q.code})` };
}
