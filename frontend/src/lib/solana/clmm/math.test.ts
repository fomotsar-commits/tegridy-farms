// @vitest-environment node
// Reads the program source and the program's own vectors off disk.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as M from './math';

/**
 * THE PORT IS HELD TO THE PROGRAM'S OWN RUST, RUN.
 *
 * __fixtures__/program-vectors.json was computed by the range program's own functions
 * (scripts/clmm-vectors/run.sh runs them on a scratch copy of solana/tegridy-clmm), on
 * inputs drawn across every order of magnitude, edges and failures included. Each port
 * must give the same number, or fail with the same error name; a Rust panic (an overflow
 * the program aborts on) must be a failure here too.
 */

const SRC = resolve(__dirname, '../../../../..', 'solana/tegridy-clmm/programs/amm/src');
const rust = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

type Outcome = { ok: unknown } | { err: string };
const V = JSON.parse(readFileSync(resolve(__dirname, '__fixtures__', 'program-vectors.json'), 'utf8')) as Record<string, unknown[][]>;

/** Codes this port throws for what Rust does by panicking. */
const PANICS = new Set(['ArithmeticOverflow', 'DivideByZero', 'IndexOutOfBounds']);

/** Run `f` and compare with the program's outcome; `show` turns our value into its JSON form. */
function expectSame<T>(want: Outcome, f: () => T, show: (v: T) => unknown, label: string) {
  let got: Outcome;
  try {
    got = { ok: show(f()) };
  } catch (e) {
    if (!(e instanceof M.ClmmMathError)) throw e;
    got = { err: PANICS.has(e.code) ? 'panic' : e.code };
  }
  expect(got, label).toEqual(want);
}

const big = (s: unknown) => BigInt(s as string);
const str = (v: bigint) => v.toString();
const pair = (v: [bigint, bigint]) => [v[0].toString(), v[1].toString()];

describe('constants are the program’s', () => {
  const src = rust('libraries/tick_math.rs');
  it('tick and price bounds', () => {
    expect(src).toContain(`pub const MIN_TICK: i32 = ${M.MIN_TICK};`);
    expect(src).toContain(`pub const MAX_TICK: i32 = ${M.MAX_TICK};`);
    expect(src).toContain(`pub const MIN_SQRT_PRICE_X64: u128 = ${M.MIN_SQRT_PRICE_X64};`);
    expect(src).toContain(`pub const MAX_SQRT_PRICE_X64: u128 = ${M.MAX_SQRT_PRICE_X64};`);
    expect(rust('states/config.rs')).toContain(`pub const FEE_RATE_DENOMINATOR_VALUE: u32 = 1_000_000;`);
    expect(M.FEE_RATE_DENOMINATOR).toBe(1_000_000);
  });
  it('the nineteen factors of get_sqrt_price_at_tick, in order', () => {
    const body = /pub fn get_sqrt_price_at_tick[\s\S]*?\n\}/.exec(src)![0];
    const factors = [...body.matchAll(/U128\(\[(0x[0-9a-f]+), 0\]\)/g)].map((m) => BigInt(m[1]!));
    expect(factors).toHaveLength(19);
    // Factor 0 is the odd-tick start; the even start is 2^64.
    expect(M.getSqrtPriceAtTick(1)).toBe(M.U128_MAX / factors[0]!);
    expect(M.getSqrtPriceAtTick(-1)).toBe(factors[0]);
    for (let i = 1; i < 19; i++) expect(M.getSqrtPriceAtTick(-(1 << i)), `bit ${i}`).toBe((M.Q64 * factors[i]!) >> 64n);
  });
});

describe('tick maths: the program’s own unit tests, ported', () => {
  it('min and max', () => {
    expect(M.getSqrtPriceAtTick(M.MIN_TICK)).toBe(M.MIN_SQRT_PRICE_X64);
    expect(M.getSqrtPriceAtTick(M.MAX_TICK)).toBe(M.MAX_SQRT_PRICE_X64);
    expect(M.getTickAtSqrtPrice(M.MIN_SQRT_PRICE_X64)).toBe(M.MIN_TICK);
    expect(M.getTickAtSqrtPrice(M.MAX_SQRT_PRICE_X64 - 1n)).toBe(M.MAX_TICK - 1);
    expect(() => M.getTickAtSqrtPrice(M.MAX_SQRT_PRICE_X64)).toThrow(/SqrtPriceX64/);
    expect(() => M.getSqrtPriceAtTick(M.MAX_TICK + 1)).toThrow(/TickUpperOverflow/);
  });
  it('tick_round_down', () => {
    for (const t of [-28861, 28861]) {
      const s = M.getSqrtPriceAtTick(t);
      expect(M.getTickAtSqrtPrice(s)).toBe(t);
      expect(M.getTickAtSqrtPrice(s + 1n)).toBe(t);
      expect(M.getTickAtSqrtPrice(M.getSqrtPriceAtTick(t + 1) - 1n)).toBe(t);
      expect(M.getTickAtSqrtPrice(s - 1n)).toBe(t - 1);
    }
  });
  // About 130,000 ticks: mismatches are collected and asserted once, since an `expect` per tick
  // took this past vitest's 5 s under a full parallel run.
  it('round trip and order, every 7th tick across the whole range and every tick near zero', () => {
    const bad: string[] = [];
    let last = 0n;
    const check = (t: number) => {
      const s = M.getSqrtPriceAtTick(t);
      if (M.getTickAtSqrtPrice(s) !== t) bad.push(`tick ${t} does not come back`);
      if (t > M.MIN_TICK && M.getTickAtSqrtPrice(s - 1n) !== t - 1) bad.push(`one below tick ${t} is not tick ${t - 1}`);
      return s;
    };
    for (let t = M.MIN_TICK; t < M.MAX_TICK; t += 7) {
      const s = check(t);
      if (!(s > last)) bad.push(`tick ${t} is not above the one before`);
      last = s;
    }
    for (let t = -3000; t <= 3000; t++) check(t);
    expect(bad).toEqual([]);
  }, 30_000);
});

describe('the program’s vectors', () => {
  it.each([
    ['sqrtPriceAtTick', (r: unknown[]) => expectSame(r[1] as Outcome, () => M.getSqrtPriceAtTick(r[0] as number), str, `tick ${r[0]}`)],
    ['tickAtSqrtPrice', (r: unknown[]) => expectSame(r[1] as Outcome, () => M.getTickAtSqrtPrice(big(r[0])), (v) => v, `sqrt ${r[0]}`)],
    ['priceFromSqrtPrice', (r: unknown[]) => expectSame(r[2] as Outcome, () => M.getPriceFromSqrtPrice(big(r[0]), r[1] as boolean), str, `price ${r[0]}`)],
    ['nextSqrtPrice', (r: unknown[]) => {
      const [s, l, a, zfo, input] = [big(r[0]), big(r[1]), big(r[2]), r[3] as boolean, r[4] as boolean];
      expectSame(r[5] as Outcome, () => (input ? M.getNextSqrtPriceFromInput : M.getNextSqrtPriceFromOutput)(s, l, a, zfo), str, `next ${JSON.stringify(r)}`);
    }],
    ['liquidityFromAmounts', (r: unknown[]) => {
      const [p, a, b, x, y] = r.slice(0, 5).map(big) as [bigint, bigint, bigint, bigint, bigint];
      expectSame(r[5] as Outcome, () => M.getLiquidityFromAmounts(p, a, b, x, y), str, `both ${JSON.stringify(r)}`);
      expectSame(r[6] as Outcome, () => M.getLiquidityFromSingleAmount0(p, a, b, x), str, `single0 ${JSON.stringify(r)}`);
      expectSame(r[7] as Outcome, () => M.getLiquidityFromSingleAmount1(p, a, b, y), str, `single1 ${JSON.stringify(r)}`);
    }],
    ['deltaAmounts', (r: unknown[]) => {
      const [a, b, l] = r.slice(0, 3).map(big) as [bigint, bigint, bigint];
      const [up, zfo] = [r[3] as boolean, r[4] as boolean];
      expectSame(r[5] as Outcome, () => M.getDeltaAmount0Unsigned(a, b, l, up), str, `d0 ${JSON.stringify(r)}`);
      expectSame(r[6] as Outcome, () => M.getDeltaAmount1Unsigned(a, b, l, up), str, `d1 ${JSON.stringify(r)}`);
      expectSame(r[7] as Outcome, () => M.getDeltaAmountsForSwap(a, b, l, zfo), pair, `swap ${JSON.stringify(r)}`);
    }],
    ['deltaAmountsSigned', (r: unknown[]) => {
      expectSame(r[5] as Outcome, () => M.getDeltaAmountsSigned(r[0] as number, big(r[1]), r[2] as number, r[3] as number, big(r[4])), pair, `signed ${JSON.stringify(r)}`);
    }],
    ['addDelta', (r: unknown[]) => expectSame(r[2] as Outcome, () => M.addDelta(big(r[0]), big(r[1])), str, `add ${JSON.stringify(r)}`)],
    ['feeGrowthInside', (r: unknown[]) => {
      const lower = { tick: r[0] as number, feeGrowthOutside0X64: big(r[1]), feeGrowthOutside1X64: big(r[2]) };
      const upper = { tick: r[3] as number, feeGrowthOutside0X64: big(r[4]), feeGrowthOutside1X64: big(r[5]) };
      const inside = M.getFeeGrowthInside(lower, upper, r[6] as number, big(r[7]), big(r[8]));
      expect(pair(inside)).toEqual([r[9], r[10]]);
      expectSame(r[14] as Outcome, () => M.calculateLatestTokenFees(big(r[11]), big(r[12]), inside[0], big(r[13])), str, `fees ${JSON.stringify(r)}`);
    }],
  ] as const)('%s', (section, check) => {
    const rows = V[section]!;
    expect(rows.length).toBeGreaterThan(100);
    // Each section must cover both kinds of outcome somewhere, or it proves less than it says.
    const outcomes = rows.flatMap((r) => r.filter((x): x is Outcome => typeof x === 'object' && x !== null && ('ok' in x || 'err' in x)));
    expect(outcomes.some((o) => 'ok' in o)).toBe(true);
    if (section !== 'feeGrowthInside' && section !== 'deltaAmountsSigned') expect(outcomes.some((o) => 'err' in o), `${section} has a failure case`).toBe(true);
    for (const r of rows) check(r);
  });
});

describe('human prices (the site’s own)', () => {
  it('isqrt is the exact floor', () => {
    for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, (1n << 200n) + 12345n, M.U256_MAX]) {
      const r = M.isqrt(n);
      expect(r * r <= n && (r + 1n) * (r + 1n) > n, n.toString()).toBe(true);
    }
  });

  it('a typed price becomes the sqrt price the program stores, and reads back', () => {
    // 1 BAYLA (6 decimals) = 0.0003 SOL (9 decimals), BAYLA as token 0.
    const s = M.sqrtPriceX64FromPrice(3n, 10_000n, 6, 9);
    const back = M.priceFromSqrtPriceX64(s, 6, 9);
    const asNumber = Number((back.num * 10n ** 12n) / back.den) / 1e12;
    expect(asNumber).toBeCloseTo(0.0003, 10);
    // Rounded down: the stored price never reads above the typed one.
    expect(back.num * 10_000n <= 3n * back.den).toBe(true);
    expect(M.getTickAtSqrtPrice(s)).toBe(Math.floor(Math.log(0.0003 * 1e3) / Math.log(1.0001)));
  });

  it('usable ticks stay on the spacing and inside the program’s bounds, and never read as -0', () => {
    expect(M.usableTickBounds(120)).toEqual({ min: -443520, max: 443520 });
    expect(M.nearestUsableTick(-59, 120)).toBe(0);
    expect(Object.is(M.nearestUsableTick(-59, 120), -0)).toBe(false);
    expect(M.nearestUsableTick(61, 120)).toBe(120);
    expect(M.nearestUsableTick(-1e9, 60)).toBe(M.usableTickBounds(60).min);
    expect(M.nearestUsableTick(1e9, 60)).toBe(M.usableTickBounds(60).max);
  });
});
