// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { encodeAmmConfig, encodePool, encodeTickArray, type TickFields } from './encode.fixture';
import { decodeAmmConfig, decodePoolState, decodeTickArray } from './program';
import { getDeltaAmount1Unsigned, getSqrtPriceAtTick, isqrt, usableTickBounds } from './math';
import { bandWindow, liquidityAt, moveCost, valueSpan, walkDepth, type BandsWindow } from './depth';

/**
 * The depth chart's walk on bands built by the program's own byte layout. What each test
 * holds: every liquidity drawn is the chain's (the summed `liquidityNet`), a band that did
 * not read ends its side and only its side, and nothing past the window is drawn as empty.
 */

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const POOL = key(4);
const S = 120;
const SPAN = S * 60;
const TC = 600;

// Positions: [lower, upper, liquidity]. The pool's liquidity is the sum of those holding 600.
const POSITIONS: [number, number, bigint][] = [
  [-14_400, -7_200, 2_000_000_000n],
  [-1_200, 1_200, 5_000_000_000n],
  [0, 2_400, 3_000_000_000n],
  [7_200, 9_600, 1_000_000_000n],
  [14_400, 21_600, 4_000_000_000n],
];
const ORDERS: TickFields[] = [
  { tick: 3_600, liquidityNet: 0n, liquidityGross: 0n, ordersAmount: 7_000_000n },
  { tick: -2_400, liquidityNet: 0n, liquidityGross: 0n, partFilledOrdersRemaining: 9_000_000n },
];

function ticksFrom(positions: [number, number, bigint][]): TickFields[] {
  const m = new Map<number, TickFields>();
  for (const [lo, hi, l] of positions) {
    for (const [t, net] of [[lo, l], [hi, -l]] as const) {
      const x = m.get(t) ?? { tick: t, liquidityNet: 0n, liquidityGross: 0n };
      x.liquidityNet += net;
      x.liquidityGross += l;
      m.set(t, x);
    }
  }
  return [...m.values()];
}

const startOf = (t: number) => Math.floor(t / SPAN) * SPAN;

function chain(o: { positions?: [number, number, bigint][]; orders?: TickFields[]; tc?: number } = {}) {
  const positions = o.positions ?? POSITIONS;
  const tc = o.tc ?? TC;
  const ticks = [...ticksFrom(positions), ...(o.orders ?? ORDERS)];
  const starts = [...new Set(ticks.map((t) => startOf(t.tick)))].sort((a, b) => a - b);
  const liquidity = positions.filter(([lo, hi]) => lo <= tc && tc < hi).reduce((a, [, , l]) => a + l, 0n);
  const pool = decodePoolState(POOL.toBase58(), encodePool({
    ammConfig: key(3), mint0: key(10), mint1: key(11), vault0: key(5), vault1: key(6), observation: key(7),
    decimals0: 6, decimals1: 9, tickSpacing: S, liquidity, sqrtPriceX64: getSqrtPriceAtTick(tc) + 99n, tickCurrent: tc,
    bitmapBits: starts.map((s) => s / SPAN + 512),
  }))!;
  const bands = new Map(starts.map((s) => [s, decodeTickArray(key(100).toBase58(), encodeTickArray(POOL, s, S, ticks.filter((t) => startOf(t.tick) === s)))!]));
  return { pool, ticks, bands };
}

function windowOf(c: ReturnType<typeof chain>, o: { each?: number; unread?: number[] } = {}): BandsWindow {
  const picked = bandWindow(c.pool, null, o.each);
  return {
    pool: c.pool,
    extension: null,
    bands: picked.starts.map((start) => (o.unread?.includes(start) ? { start, band: null, detail: 'did not read' } : { start, band: c.bands.get(start)! })),
    beyondBelow: picked.beyondBelow,
    beyondAbove: picked.beyondAbove,
    at: 1_800_000_000_000,
  };
}

const sumNetUpTo = (ticks: TickFields[], t: number) => ticks.filter((x) => x.tick <= t).reduce((a, x) => a + x.liquidityNet, 0n);

describe('the depth walk', () => {
  it('equals the summed liquidityNet on every step, end to end', () => {
    const c = chain();
    const d = walkDepth(windowOf(c));
    const { min, max } = usableTickBounds(S);
    expect(d.runs[0]!.from).toBe(min);
    expect(d.runs[d.runs.length - 1]!.to).toBe(max);
    for (let i = 1; i < d.runs.length; i++) expect(d.runs[i]!.from).toBe(d.runs[i - 1]!.to);
    for (const r of d.runs) expect(r.liquidity).toBe(sumNetUpTo(c.ticks, r.from));
    // Spot checks against the positions themselves.
    expect(liquidityAt(d, 600)).toBe(8_000_000_000n);
    expect(liquidityAt(d, 1_200)).toBe(3_000_000_000n);
    expect(liquidityAt(d, -1_200)).toBe(5_000_000_000n);
    expect(liquidityAt(d, -10_000)).toBe(2_000_000_000n);
    expect(liquidityAt(d, 5_000)).toBe(0n);
    expect(liquidityAt(d, 20_000)).toBe(4_000_000_000n);
    expect(d.gaps).toEqual([]);
    expect(d.bandsRead).toBe(6);
  });

  it('marks resting orders at their tick, token 0 for sale above the price and token 1 at or below it', () => {
    const d = walkDepth(windowOf(chain()));
    expect(d.orders).toEqual([
      { tick: -2_400, amount: 9_000_000n, sellsToken0: false },
      { tick: 3_600, amount: 7_000_000n, sellsToken0: true },
    ]);
  });

  it('an unread band is a hatched gap, the walk stops there, and the other side still draws', () => {
    const c = chain();
    const d = walkDepth(windowOf(c, { unread: [7_200] }));
    expect(d.gaps).toEqual([
      { from: 7_200, to: 14_400, kind: 'unread' },
      { from: 14_400, to: usableTickBounds(S).max, kind: 'not-known' },
    ]);
    expect(d.runs[d.runs.length - 1]!.to).toBe(7_200);
    expect(d.runs.some((r) => r.to > 7_200)).toBe(false);
    // Below the price, all of it.
    expect(d.runs[0]!.from).toBe(usableTickBounds(S).min);
    for (const r of d.runs) expect(r.liquidity).toBe(sumNetUpTo(c.ticks, r.from));
    expect(d.bandsUnread).toBe(1);
  });

  it('the band at the price unread: nothing on either side is drawn', () => {
    const d = walkDepth(windowOf(chain(), { unread: [0] }));
    expect(d.runs).toEqual([]);
    const { min, max } = usableTickBounds(S);
    expect(d.gaps).toEqual([
      { from: min, to: 0, kind: 'not-known' },
      { from: 0, to: SPAN, kind: 'unread' },
      { from: SPAN, to: max, kind: 'not-known' },
    ]);
  });

  it('past the window, the walk stops at the next band not read and says so', () => {
    const c = chain();
    const d = walkDepth(windowOf(c, { each: 2 }));
    expect(d.beyond).toEqual({ below: false, above: true });
    expect(d.gaps).toEqual([{ from: 21_600, to: usableTickBounds(S).max, kind: 'not-read' }]);
    // Known up to that band: the last position is still in use there.
    expect(d.runs[d.runs.length - 1]).toEqual({ from: 14_400, to: 21_600, liquidity: 4_000_000_000n });
  });

  it('the window is the band at the price and 8 used bands each side, never more', () => {
    const positions: [number, number, bigint][] = Array.from({ length: 12 }, (_, i) => [(i + 1) * SPAN, (i + 1) * SPAN + S, 1n] as [number, number, bigint]);
    const c = chain({ positions, orders: [] });
    const w = bandWindow(c.pool, null);
    expect(w.starts).toEqual(Array.from({ length: 8 }, (_, i) => (i + 1) * SPAN));
    expect(w.beyondAbove).toBe(9 * SPAN);
    expect(w.beyondBelow).toBeNull();
  });

  it('a window of no bands each side reads only the band at the price', () => {
    const w = bandWindow(chain().pool, null, 0);
    expect(w.starts).toEqual([0]);
    expect(w.beyondBelow).toBe(-SPAN);
    expect(w.beyondAbove).toBe(SPAN);
  });

  it('a pool with no band and no liquidity is empty', () => {
    const c = chain({ positions: [], orders: [] });
    expect(walkDepth(windowOf(c)).empty).toBe(true);
    expect(walkDepth(windowOf(chain())).empty).toBe(false);
  });

  it('most of the value sits where most of the liquidity is', () => {
    const c = chain();
    const span = valueSpan(walkDepth(windowOf(c)), c.pool, 0.1, 0.9)!;
    expect(span.from).toBeLessThanOrEqual(-1_200);
    expect(span.to).toBeGreaterThanOrEqual(1_200);
  });
});

describe('what moves the price 2%', () => {
  const tier = decodeAmmConfig(key(3).toBase58(), encodeAmmConfig({ index: 0, tradeFeeRate: 10_000, protocolFeeRate: 104_000, fundFeeRate: 56_000, tickSpacing: S }))!;
  const UP = { num: 102n, den: 100n };

  it('is the program’s own swap to that price limit, the fee included', () => {
    const c = chain();
    const cost = moveCost(windowOf(c), tier, UP);
    const sqrt = c.pool.sqrtPriceX64;
    const limit = isqrt((sqrt * sqrt * 102n) / 100n);
    const into = getDeltaAmount1Unsigned(sqrt, limit, 8_000_000_000n, true);
    const fee = (into * 10_000n + 989_999n) / 990_000n;
    expect(cost).toEqual({ kind: 'ok', amountIn: into + fee, inIsToken0: false });
  });

  it('counts the orders resting on the way', () => {
    const resting = 50_000_000n;
    const without = moveCost(windowOf(chain({ orders: [] })), tier, UP);
    const withOrders = moveCost(windowOf(chain({ orders: [{ tick: 720, liquidityNet: 0n, liquidityGross: 0n, ordersAmount: resting }] })), tier, UP);
    if (without.kind !== 'ok' || withOrders.kind !== 'ok') throw new Error('both should quote');
    const expected = (Number(resting) * 1.0001 ** 720) / 0.99;
    expect(Number(withOrders.amountIn - without.amountIn) / expected).toBeCloseTo(1, 2);
  });

  it('with nothing in use that far, it moves for next to nothing; a band it needs that did not read is unread', () => {
    const thin = chain({ positions: [[6_000, 7_200, 1_000_000n]], orders: [] });
    expect(moveCost(windowOf(thin), tier, UP)).toEqual({ kind: 'free' });
    expect(moveCost(windowOf(chain(), { unread: [0] }), tier, UP).kind).toBe('unread');
  });
});
