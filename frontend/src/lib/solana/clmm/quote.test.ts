// @vitest-environment node
// Reads the program's own vectors off disk.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ClmmMathError, MAX_SQRT_PRICE_X64, MIN_SQRT_PRICE_X64, getSqrtPriceAtTick } from './math';
import { MAX_FEE_RATE_NUMERATOR, computeSwap, quoteSwap, quoteSwapAsRaydium, swapInternal, tickSpacingIndexFromTick, type SwapQuoteArgs } from './quote';
import { getArrayStartIndex } from './bitmap';
import { TICK_ARRAY_SIZE, type TickArrayView, type TickStateView } from './program';

/**
 * THE QUOTE IS HELD TO THE PROGRAM'S OWN SWAP, RUN.
 *
 * __fixtures__/program-vectors.json holds 1,500 single steps of `compute_swap` and 360 whole
 * swaps of `swap_internal`, each computed by the range program's own Rust on a scratch copy
 * (scripts/clmm-vectors/run.sh): random pools with positions across many bands, resting
 * limit orders (part-filled cohorts too), dynamic fees, all three fee-on modes, the far-band
 * map, and price limits. The quote must give the same amounts, fees, price, tick and
 * liquidity, or refuse with the same error. quoteLive.test.ts then replays real swaps.
 */

type Outcome = { ok: unknown } | { err: string };
const V = JSON.parse(readFileSync(resolve(__dirname, '__fixtures__', 'program-vectors.json'), 'utf8')) as {
  programSource: { sha256: string };
  computeSwap: unknown[][];
  swapInternal: SwapCase[];
};
const PANICS = new Set(['ArithmeticOverflow', 'DivideByZero', 'IndexOutOfBounds']);

interface SwapCase {
  spacing: number;
  tick: number;
  sqrt: string;
  liquidity: string;
  feeOn: number;
  bitmap: number[];
  ext: [number[][], number[][]];
  dyn: [number, number, number, number, number, number, number, number, number] | null;
  cfg: [number, number, number];
  ticks: [number, string, string, string, string, string, string][];
  zfo: boolean;
  baseIn: boolean;
  amount: string;
  limit: string;
  ts: number;
  out: Outcome;
  feesAfter: [string, string, string, string];
}

function words(bits: number[], count: number): bigint[] {
  const w = new Array<bigint>(count).fill(0n);
  for (const b of bits) w[b >> 6] = w[b >> 6]! | (1n << BigInt(b & 63));
  return w;
}

const emptyTick = (): TickStateView => ({
  tick: 0, liquidityNet: 0n, liquidityGross: 0n, feeGrowthOutside0X64: 0n, feeGrowthOutside1X64: 0n,
  rewardGrowthsOutsideX64: [0n, 0n, 0n], orderPhase: 0n, ordersAmount: 0n, partFilledOrdersRemaining: 0n, unfilledRatioX64: 0n,
});

/** A program-run swap case as the quote's inputs. */
function argsOf(c: SwapCase): Omit<SwapQuoteArgs, 'sqrtPriceLimitX64'> & { sqrtPriceLimitX64: bigint } {
  const bands = new Map<number, TickArrayView>();
  for (const [tick, net, gross, orders, part, ratio, phase] of c.ticks) {
    const start = getArrayStartIndex(tick, c.spacing);
    let b = bands.get(start);
    if (!b) {
      b = { address: `band ${start}`, poolId: 'pool', startTickIndex: start, ticks: Array.from({ length: TICK_ARRAY_SIZE }, emptyTick), initializedTickCount: 0 };
      bands.set(start, b);
    }
    b.ticks[(tick - start) / c.spacing] = {
      ...emptyTick(), tick, liquidityNet: BigInt(net), liquidityGross: BigInt(gross),
      ordersAmount: BigInt(orders), partFilledOrdersRemaining: BigInt(part), unfilledRatioX64: BigInt(ratio), orderPhase: BigInt(phase),
    };
    b.initializedTickCount += 1;
  }
  const d = c.dyn;
  return {
    pool: {
      tickCurrent: c.tick, sqrtPriceX64: BigInt(c.sqrt), liquidity: BigInt(c.liquidity), tickSpacing: c.spacing, feeOn: c.feeOn, status: 0,
      tickArrayBitmap: words(c.bitmap, 16), openTime: 0n,
      dynamicFeeInfo: d && {
        filterPeriod: d[0], decayPeriod: d[1], reductionFactor: d[2], dynamicFeeControl: d[3], maxVolatilityAccumulator: d[4],
        tickSpacingIndexReference: d[5], volatilityReference: d[6], volatilityAccumulator: d[7], lastUpdateTimestamp: BigInt(d[8]),
      },
    },
    config: { tradeFeeRate: c.cfg[0], protocolFeeRate: c.cfg[1], fundFeeRate: c.cfg[2] },
    band: (s) => bands.get(s),
    extension: { address: 'ext', poolId: 'pool', positiveTickArrayBitmap: c.ext[0].map((b) => words(b, 8)), negativeTickArrayBitmap: c.ext[1].map((b) => words(b, 8)) },
    zeroForOne: c.zfo,
    isBaseInput: c.baseIn,
    amount: BigInt(c.amount),
    sqrtPriceLimitX64: BigInt(c.limit),
    blockTimestamp: c.ts,
  };
}

describe('compute_swap, step for step', () => {
  it('matches the program on every vector, failures included', () => {
    const rows = V.computeSwap;
    expect(rows.length).toBeGreaterThan(1000);
    let errors = 0;
    for (const r of rows) {
      const [cur, target, l, amount] = (r.slice(0, 4) as string[]).map(BigInt);
      const [fee, baseIn, zfo, feeIn] = r.slice(4, 8) as [number, boolean, boolean, boolean];
      const want = r[8] as Outcome;
      let got: Outcome;
      try {
        const s = computeSwap(cur!, target!, l!, amount!, fee, baseIn, zfo, feeIn);
        got = { ok: [s.sqrtPriceNextX64, s.amountIn, s.amountOut, s.feeAmount].map(String) };
      } catch (e) {
        if (!(e instanceof ClmmMathError)) throw e;
        got = { err: PANICS.has(e.code) ? 'panic' : e.code };
        errors++;
      }
      expect(got, JSON.stringify(r)).toEqual(want);
    }
    expect(errors).toBeGreaterThan(0);
  });
});

describe('swap_internal, swap for swap', () => {
  const cases = V.swapInternal;

  it('covers what it claims: orders, part-filled orders, dynamic fees, every fee mode, the far map, refusals', () => {
    expect(cases.length).toBeGreaterThanOrEqual(300);
    expect(cases.filter((c) => c.ticks.some((t) => t[3] !== '0')).length).toBeGreaterThan(50);
    expect(cases.filter((c) => c.ticks.some((t) => t[4] !== '0')).length).toBeGreaterThan(20);
    expect(cases.filter((c) => c.dyn).length).toBeGreaterThan(50);
    expect(new Set(cases.map((c) => c.feeOn))).toEqual(new Set([0, 1, 2]));
    expect(cases.filter((c) => c.ext.flat().some((m) => m.length)).length).toBeGreaterThan(10);
    expect(cases.filter((c) => 'err' in c.out).length).toBeGreaterThan(10);
    expect(cases.filter((c) => 'ok' in c.out).length).toBeGreaterThan(200);
  });

  it.each(cases.map((c, i) => [i, c] as const))('case %i', (_, c) => {
    let got: Outcome;
    let split: [bigint, bigint] | null = null;
    try {
      const r = swapInternal(argsOf(c));
      got = { ok: [r.amount0, r.amount1, r.tradeFee0, r.tradeFee1, r.sqrtPriceX64, r.liquidity].map(String).concat([r.tick as unknown as string]) };
      split = [r.protocolFee, r.fundFee];
    } catch (e) {
      if (!(e instanceof ClmmMathError)) throw e;
      got = { err: PANICS.has(e.code) ? 'panic' : e.code };
    }
    expect(got).toEqual(c.out);
    if (split && 'ok' in c.out) {
      // What the venue's accounts take from this swap: the pool's protocol and fund fees after.
      const feeIn0 = (c.out.ok as string[])[2] !== '0';
      const [p0, p1, f0, f1] = c.feesAfter.map(BigInt);
      expect(split[0]).toBe(feeIn0 ? p0 : p1);
      expect(split[1]).toBe(feeIn0 ? f0 : f1);
      expect(feeIn0 ? p1! + f1! : p0! + f0!).toBe(0n);
    }
  });
});

describe('quoteSwap, the checks swap_v2 adds', () => {
  const okCase = V.swapInternal.find((c) => 'ok' in c.out && BigInt(c.limit) === (c.zfo ? MIN_SQRT_PRICE_X64 + 1n : MAX_SQRT_PRICE_X64 - 1n) && c.ticks.length > 2)!;

  it('a filled quote reports what goes in, what comes out, the fee and the bands to pass', () => {
    const a = { ...argsOf(okCase), sqrtPriceLimitX64: 0n };
    const q = quoteSwap(a);
    const [a0, a1] = (okCase.out as { ok: string[] }).ok.map(BigInt);
    if (q.kind !== 'ok') {
      // A no-limit swap that cannot fill in full is refused, exactly as swap_v2 refuses it.
      expect(q).toEqual({ kind: 'refused', code: 'RequireEqViolated' });
      return;
    }
    expect([q.amountIn, q.amountOut]).toEqual(okCase.zfo ? [a0, a1] : [a1, a0]);
    expect(q.filled).toBe(true);
    expect(q.bands.length).toBeGreaterThan(0);
  });

  it('a band the caller did not read ends the quote with its start, never a guess', () => {
    const a = argsOf(okCase);
    const q = quoteSwap({ ...a, band: () => undefined });
    expect(q.kind).toBe('needs-band');
  });

  it('refuses what the program refuses: before open time, nothing to swap, a price limit on the wrong side, a paused swap', () => {
    const a = argsOf(okCase);
    expect(quoteSwap({ ...a, pool: { ...a.pool, openTime: BigInt(a.blockTimestamp) } })).toEqual({ kind: 'refused', code: 'RequireGtViolated' });
    expect(quoteSwap({ ...a, amount: 0n })).toEqual({ kind: 'refused', code: 'ZeroAmountSpecified' });
    const wrongSide = a.zeroForOne ? a.pool.sqrtPriceX64 + 1n : a.pool.sqrtPriceX64 - 1n;
    expect(quoteSwap({ ...a, sqrtPriceLimitX64: wrongSide })).toEqual({ kind: 'refused', code: 'SqrtPriceLimitOverflow' });
    expect(quoteSwap({ ...a, pool: { ...a.pool, status: 1 << 4 } })).toEqual({ kind: 'refused', code: 'NotApproved' });
  });

  it('a one-unit swap whose output rounds to nothing is refused, as swap_v2 refuses it', () => {
    const a = argsOf(okCase);
    const q = quoteSwap({ ...a, amount: 1n, isBaseInput: true });
    expect(q).toEqual({ kind: 'refused', code: 'TooSmallInputOrOutputAmount' });
  });

  it('never changes what it was given', () => {
    const a = argsOf(okCase);
    const before = JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    const band0 = a.band(getArrayStartIndex(okCase.ticks[0]![0], okCase.spacing))!;
    const tick0 = JSON.stringify(band0.ticks, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    quoteSwap(a);
    swapInternal(a);
    expect(JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(before);
    expect(JSON.stringify(band0.ticks, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(tick0);
  });
});

describe('the dynamic fee index', () => {
  it('rounds toward minus infinity off the spacing, as pool_fee.rs does', () => {
    expect(tickSpacingIndexFromTick(0, 60)).toBe(0);
    expect(tickSpacingIndexFromTick(59, 60)).toBe(0);
    expect(tickSpacingIndexFromTick(-1, 60)).toBe(-1);
    expect(tickSpacingIndexFromTick(-60, 60)).toBe(-1);
    expect(tickSpacingIndexFromTick(-61, 60)).toBe(-2);
    expect(getSqrtPriceAtTick(0)).toBe(1n << 64n);
  });
});

describe('the vectors were made from this repo’s program source', () => {
  // run.sh stamps the hash of everything that decides the program's maths: the .rs files under
  // programs/amm/src, vendor/, both Cargo.toml and Cargo.lock (by path then content, carriage
  // returns dropped). This holds that stamp to the repo's copy, so a change to any of it without
  // new vectors fails here. It neither re-runs the Rust nor reads the program on chain.
  it('the fixture’s stamp is the hash of the program source in this repo', () => {
    const root = resolve(__dirname, '../../../../../solana/tegridy-clmm');
    const files: string[] = ['Cargo.toml', 'Cargo.lock', 'programs/amm/Cargo.toml'];
    const walk = (dir: string, keep: (name: string) => boolean) => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p, keep);
        else if (keep(e.name)) files.push(p);
      }
    };
    walk('programs/amm/src', (n) => n.endsWith('.rs'));
    walk('vendor', () => true);
    files.sort();
    const h = createHash('sha256');
    for (const f of files) {
      h.update(`${f}\n`);
      h.update(readFileSync(join(root, f), 'utf8').replace(/\r/g, ''));
    }
    expect(files.filter((f) => f.startsWith('vendor/')).length).toBeGreaterThan(10);
    expect(files.length).toBeGreaterThan(60);
    expect(h.digest('hex')).toBe(V.programSource.sha256);
  });
});

describe('the fee ceiling', () => {
  it('our program’s ceiling is the one its source declares: 4% of a swap', () => {
    const src = readFileSync(resolve(__dirname, '../../../../../solana/tegridy-clmm/programs/amm/src/states/pool_fee.rs'), 'utf8');
    const declared = /pub const MAX_FEE_RATE_NUMERATOR: u32 = ([\d_]+);/.exec(src)?.[1];
    expect(Number(declared?.replace(/_/g, ''))).toBe(MAX_FEE_RATE_NUMERATOR);
    expect(MAX_FEE_RATE_NUMERATOR).toBe(40_000);
  });

  it('a dynamic fee stops at our 4%, and at 10% only when a swap in Raydium’s program is replayed', () => {
    const spacing = 60;
    const L = 10n ** 15n;
    const ticks = Array.from({ length: TICK_ARRAY_SIZE }, emptyTick);
    ticks[0] = { ...emptyTick(), tick: 0, liquidityNet: L, liquidityGross: L };
    ticks[59] = { ...emptyTick(), tick: 3_540, liquidityNet: -L, liquidityGross: L };
    const band: TickArrayView = { address: 'band 0', poolId: 'pool', startTickIndex: 0, ticks, initializedTickCount: 2 };
    const ts = 1_800_000_000;
    const a: SwapQuoteArgs = {
      pool: {
        tickCurrent: 1_800, sqrtPriceX64: getSqrtPriceAtTick(1_800), liquidity: L, tickSpacing: spacing, feeOn: 0, status: 0,
        tickArrayBitmap: words([512], 16), openTime: 0n,
        // A volatility far past the ceiling: 360,000 per million before any cap.
        dynamicFeeInfo: {
          filterPeriod: 10, decayPeriod: 60, reductionFactor: 5_000, dynamicFeeControl: 100_000, maxVolatilityAccumulator: 1_000_000,
          tickSpacingIndexReference: tickSpacingIndexFromTick(1_800, spacing), volatilityReference: 100_000, volatilityAccumulator: 100_000, lastUpdateTimestamp: BigInt(ts),
        },
      },
      config: { tradeFeeRate: 10_000, protocolFeeRate: 104_000, fundFeeRate: 56_000 },
      band: (s) => (s === 0 ? band : undefined),
      extension: null,
      zeroForOne: false,
      isBaseInput: true,
      amount: 1_000_000n,
      sqrtPriceLimitX64: 0n,
      blockTimestamp: ts,
    };
    const ours = quoteSwap(a);
    const raydiums = quoteSwapAsRaydium(a);
    if (ours.kind !== 'ok' || raydiums.kind !== 'ok') throw new Error('quote');
    // Exact in, one step: the fee is the amount times the rate, rounded up.
    expect(ours.tradeFee).toBe(40_000n);
    expect(raydiums.tradeFee).toBe(100_000n);
    // Our pools' quote and walk take no ceiling from their arguments: one smuggled in, Raydium's
    // real 10% included, is ignored (at 10% a slippage floor would come out looser than ours).
    for (const smuggledCap of [1, 100_000]) {
      const smuggled = quoteSwap({ ...a, maxFeeRate: smuggledCap } as SwapQuoteArgs);
      expect(smuggled.kind === 'ok' && smuggled.tradeFee, String(smuggledCap)).toBe(40_000n);
      const walked = (swapInternal as (x: unknown, cap?: number) => ReturnType<typeof swapInternal>)({ ...a, sqrtPriceLimitX64: getSqrtPriceAtTick(3_540) }, smuggledCap);
      expect(walked.tradeFee1, `walk ${smuggledCap}`).toBe(40_000n);
    }
  });

  it('no app code quotes with Raydium’s ceiling: the replay quote and the 10% ceiling are for tests only', () => {
    const root = resolve(__dirname, '../../../..');
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name) && !/\.test\.[cm]?[jt]sx?$/.test(e.name)) {
          const text = readFileSync(join(root, p), 'utf8');
          if (/quoteSwapAsRaydium|UPSTREAM_MAX_FEE_RATE_NUMERATOR|swapInternalWith/.test(text)) callers.push(p);
        }
      }
    };
    walk('src');
    walk('api');
    expect(callers).toEqual(['src/lib/solana/clmm/quote.ts']);
  });
});

