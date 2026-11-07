// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import {
  CLMM_PROGRAM, DLMM_PROGRAM, WHIRLPOOL_PROGRAM, ORCA_TICKS_PER_ARRAY, DLMM_BINS_PER_ARRAY, ORCA_FEE_RATE_HARD_LIMIT,
  decodeBinArray, decodeOrcaOracle, decodeOrcaTickArray, dlmmArrayAddress, dlmmArrayIndex, dlmmArrayInUse, dlmmArraysNear, dlmmBaseFee, dlmmDepth, dlmmPow, dlmmPrice, dlmmQuote, dlmmTotalFee, dlmmVariableFee,
  dammBaseFee, dammPoint, dammQuote, dammState,
  orcaAdaptiveFeeRate, orcaArrayAddress, orcaArrayStart, orcaArraysNear, orcaOracleAddress, orcaQuote, whirlpoolState,
} from './arb-venues.mjs';
import { DEXES, SOL_MINT, USDC_MINT, decodePool, depthOf, tripsFor } from './arb-chain.mjs';
import { getSqrtPriceAtTick } from '../../src/lib/solana/clmm/math.ts';

const tag = (name) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
const put = (b, at, mint) => Buffer.from(bs58.decode(mint)).copy(b, at);
const u128 = (b, at, v) => {
  b.writeBigUInt64LE(v & ((1n << 64n) - 1n), at);
  b.writeBigUInt64LE(v >> 64n, at + 8);
};
const i128 = (b, at, v) => u128(b, at, BigInt.asUintN(128, v));
const ONE = 1n << 64n;
/** A cap no gap reaches, so a trip is sized by the gap itself. */
const SETTINGS = { maxTradeUsd: 1e9, minProfitUsd: 0.01, microLamports: 10_000, lighthouseProven: true };

/** The DLMM SOL/USDC pool and bin array read on 2026-11-07 (scratch probe): the address a quote derives must be the chain's. */
const DLMM_POOL = 'HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR';
const DLMM_ARRAY_344 = 'DTafUYdTzr9Rm324YNqb3vmu6NyUBssVX2rWzaXoxzFL';

describe('the programs', () => {
  it('are the scanner’s own venue keys', () => {
    expect(WHIRLPOOL_PROGRAM).toBe(DEXES.whirlpool.program);
    expect(CLMM_PROGRAM).toBe(DEXES.clmm.program);
    expect(DLMM_PROGRAM).toBe(DEXES.dlmm.program);
  });
});

describe('Meteora DLMM', () => {
  it('prices a bin as the program does: the stored price of bin -24073 at step 1, and 1 + step/10,000 to the unit', () => {
    expect(dlmmPrice(-24073, 1)).toBe(1661479115254759910n);
    expect(dlmmPrice(0, 25)).toBe(ONE);
    const oneStep = dlmmPrice(1, 100);
    const exact = ONE + (100n << 64n) / 10_000n;
    expect(oneStep >= exact - 2n && oneStep <= exact + 2n).toBe(true);
    expect(dlmmPow(ONE, 0)).toBe(ONE);
    expect(dlmmPow(ONE + 1n, 0x80000)).toBeNull();
  });

  it('finds a bin’s array and its address on chain', () => {
    expect(dlmmArrayIndex(-24073)).toBe(-344);
    expect(dlmmArrayIndex(-1)).toBe(-1);
    expect(dlmmArrayIndex(69)).toBe(0);
    expect(dlmmArrayIndex(70)).toBe(1);
    expect(dlmmArrayAddress(DLMM_POOL, -344)).toBe(DLMM_ARRAY_344);
  });

  it('reads the pool’s map of arrays in use', () => {
    const bitmap = Array(16).fill(0n);
    bitmap[8] |= 1n; // index 0 → bit 512 → word 8, bit 0
    bitmap[7] |= 1n << 63n; // index -1 → bit 511
    const p = { bitmap };
    expect(dlmmArrayInUse(p, 0)).toBe(true);
    expect(dlmmArrayInUse(p, -1)).toBe(true);
    expect(dlmmArrayInUse(p, 1)).toBe(false);
    expect(dlmmArrayInUse(p, 600)).toBeNull();
  });

  /** A pool at bin 0, step 10 (0.1% base fee, no variable fee), one bin array in use. */
  const pair = (over = {}) => ({
    baseFactor: 10_000, binStep: 10, baseFeePowerFactor: 0, filterPeriod: 10, decayPeriod: 120, reductionFactor: 5_000, variableFeeControl: 0, maxVolatilityAccumulator: 100_000,
    minBinId: -1_000, maxBinId: 1_000, protocolShare: 1_000, volatilityAccumulator: 0, volatilityReference: 0, indexReference: 0, lastUpdateTimestamp: 0n, pairType: 0, activeId: 0, binStep10: true, status: 0,
    bitmap: (() => {
      const b = Array(16).fill(0n);
      b[8] = 1n;
      return b;
    })(),
    ...over,
  });
  const binArray = (index, bins) => ({ index, lbPair: DLMM_POOL, bins: Array.from({ length: DLMM_BINS_PER_ARRAY }, (_, i) => bins[i] ?? { x: 0n, y: 0n, price: 0n }) });

  it('swaps within a bin at its price, the fee taken from what goes in, rounded as the program rounds', () => {
    const p = pair();
    expect(dlmmBaseFee(p)).toBe(1_000_000n);
    const arrays = new Map([[0, binArray(0, [{ x: 0n, y: 1_000_000n, price: ONE }])]]);
    const q = dlmmQuote(p, 500_000n, true, 1_000, (i) => arrays.get(i));
    // fee = ceil(500,000 × 1e6 / 1e9) = 500; 499,500 in at price 1 → 499,500 out
    expect(q).toMatchObject({ out: 499_500n, used: 500_000n, needs: null });
  });

  it('empties a bin and walks on; past the last array in use the rest goes unplaced', () => {
    const p = pair();
    const arrays = new Map([[0, binArray(0, [{ x: 0n, y: 1_000_000n, price: ONE }])]]);
    const q = dlmmQuote(p, 2_000_000n, true, 1_000, (i) => arrays.get(i));
    // the whole bin: 1,000,000 in plus its fee ceil(1e6 × 1e6 / (1e9 − 1e6)) = 1,002; then no array in use below
    expect(q).toMatchObject({ out: 1_000_000n, used: 1_001_002n, needs: null });
  });

  it('asks for the array it needs and was not given', () => {
    const q = dlmmQuote(pair(), 1_000n, true, 1_000, () => undefined);
    expect(q).toMatchObject({ out: 0n, used: 0n, needs: 0 });
  });

  it('charges the variable fee as the volatility accumulator moves, and not within the filter period', () => {
    const p = pair({ variableFeeControl: 2_000_000, volatilityAccumulator: 16_640, volatilityReference: 6_640, indexReference: 0, lastUpdateTimestamp: 1_000n, binStep: 1 });
    expect(dlmmVariableFee(p, 16_640)).toBe((2_000_000n * 16_640n ** 2n + 99_999_999_999n) / 100_000_000_000n);
    expect(dlmmTotalFee(p)).toBe(dlmmBaseFee(p) + dlmmVariableFee(p, 16_640));
    // Within the filter period the references hold: the accumulator is the reference plus the bins crossed (none at bin 0).
    const arrays = new Map([[0, binArray(0, [{ x: 0n, y: 10n ** 12n, price: ONE }])]]);
    const q = dlmmQuote(p, 1_000_000n, true, 1_005, (i) => arrays.get(i));
    expect(q.fee).toBe(dlmmTotalFee(p, 6_640));
    // Past the decay period the reference resets to zero: only the base fee at the active bin.
    const later = dlmmQuote(p, 1_000_000n, true, 1_200, (i) => arrays.get(i));
    expect(later.fee).toBe(dlmmBaseFee(p));
  });

  it('decodes a bin array and sums its sides as the pool’s depth', () => {
    const b = Buffer.alloc(10136);
    tag('BinArray').copy(b, 0);
    b.writeBigInt64LE(-344n, 8);
    put(b, 24, DLMM_POOL);
    b.writeBigUInt64LE(5n, 56);
    b.writeBigUInt64LE(7n, 64);
    u128(b, 72, ONE);
    b.writeBigUInt64LE(11n, 56 + 144);
    const a = decodeBinArray(b);
    expect(a.index).toBe(-344);
    expect(a.lbPair).toBe(DLMM_POOL);
    expect(a.bins[0]).toEqual({ x: 5n, y: 7n, price: ONE });
    expect(a.bins[1].x).toBe(11n);
    expect(dlmmDepth([a])).toEqual({ a: 16, b: 7 });
    expect(decodeBinArray(Buffer.alloc(10136))).toBeNull();
  });

  it('names the arrays near the active bin that the map marks in use', () => {
    expect(dlmmArraysNear(DLMM_POOL, pair({ activeId: 10 })).map((x) => x.index)).toEqual([0]);
    const wider = pair({ activeId: 10 });
    wider.bitmap[8] |= 2n; // index 1 in use too
    expect(dlmmArraysNear(DLMM_POOL, wider).map((x) => x.index)).toEqual([0, 1]);
    expect(dlmmArraysNear(DLMM_POOL, wider)[0].address).toBe(dlmmArrayAddress(DLMM_POOL, 0));
  });
});

describe('Orca Whirlpools', () => {
  it('finds a tick’s array (88 ticks of the spacing, floored) and names it as the program does', () => {
    expect(orcaArrayStart(-24075, 1)).toBe(-24112);
    expect(orcaArrayStart(-24077, 4)).toBe(-24288);
    expect(orcaArrayStart(0, 64)).toBe(0);
    expect(orcaArrayStart(-1, 64)).toBe(-5632);
    const a = orcaArrayAddress(DLMM_POOL, -24112);
    expect(a).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(orcaArrayAddress(DLMM_POOL, -24112)).toBe(a);
    expect(orcaArrayAddress(DLMM_POOL, -24200)).not.toBe(a);
  });

  const fixedArray = (start, ticks = {}) => {
    const b = Buffer.alloc(9988);
    tag('TickArray').copy(b, 0);
    b.writeInt32LE(start, 8);
    for (const [offset, net] of Object.entries(ticks)) {
      const at = 12 + Number(offset) * 113;
      b[at] = 1;
      i128(b, at + 1, net);
      u128(b, at + 17, net < 0n ? -net : net);
    }
    put(b, 9956, DLMM_POOL);
    return b;
  };

  it('decodes a fixed array and a dynamic one alike', () => {
    const f = decodeOrcaTickArray(fixedArray(-88, { 3: 5n, 87: -5n }));
    expect(f.start).toBe(-88);
    expect(f.dynamic).toBe(false);
    expect(f.ticks[3]).toEqual({ initialized: true, liquidityNet: 5n, liquidityGross: 5n });
    expect(f.ticks[87].liquidityNet).toBe(-5n);
    expect(f.ticks[4].initialized).toBe(false);
    // dynamic: [8][start][pool][bitmap][a tag a tick, 112 bytes more when set]
    const d = Buffer.alloc(60 + 88 + 112);
    tag('DynamicTickArray').copy(d, 0);
    d.writeInt32LE(176, 8);
    put(d, 12, DLMM_POOL);
    d[60 + 10] = 1;
    i128(d, 60 + 11, -9n);
    u128(d, 60 + 27, 9n);
    const v = decodeOrcaTickArray(d);
    expect(v.start).toBe(176);
    expect(v.dynamic).toBe(true);
    expect(v.whirlpool).toBe(DLMM_POOL);
    expect(v.ticks[10]).toEqual({ initialized: true, liquidityNet: -9n, liquidityGross: 9n });
    expect(v.ticks.filter((t) => t.initialized)).toHaveLength(1);
    expect(decodeOrcaTickArray(Buffer.alloc(9988))).toBeNull();
  });

  /** A pool at price 1 (tick 0) with liquidity L in its band: in-band it is x·y = k on L/√P and L·√P. */
  const w = (over = {}) => ({ tickSpacing: 1, feeTierIndex: 1, adaptive: false, feeRate: 3_000, liquidity: 10n ** 12n, sqrtPriceX64: ONE, tickCurrent: 0, ...over });
  const empty = (start) => decodeOrcaTickArray(fixedArray(start));

  it('within its band pays what x·y = k on the band’s liquidity pays, the fee on what goes in', () => {
    const arrays = new Map([[-88, empty(-88)], [0, empty(0)], [88, empty(88)]]);
    const q = orcaQuote(w(), 1_000_000_000n, true, (s) => arrays.get(s));
    const xin = 1e9 * (1 - 0.003);
    const expected = (1e12 * xin) / (1e12 + xin);
    expect(q.used).toBe(1_000_000_000n);
    expect(Number(q.out) / expected).toBeCloseTo(1, 9);
    expect(q.needs).toBeNull();
  });

  it('crossing a tick changes the liquidity, as the tick’s liquidity_net says', () => {
    // Below tick 0 only half the liquidity remains: a trade that crosses it gets less than one that need not.
    const half = 5n * 10n ** 11n;
    const crossing = new Map([[-88, empty(-88)], [0, decodeOrcaTickArray(fixedArray(0, { 0: half }))], [88, empty(88)]]);
    const plain = new Map([[-88, empty(-88)], [0, empty(0)], [88, empty(88)]]);
    const pool = w({ sqrtPriceX64: getSqrtPriceAtTick(5), tickCurrent: 5 });
    const small = 10_000_000n;
    expect(orcaQuote(pool, small, true, (s) => crossing.get(s)).out).toBe(orcaQuote(pool, small, true, (s) => plain.get(s)).out);
    // Past tick 0 and about 50 ticks on at half the liquidity: within the arrays given.
    const big = 1_500_000_000n;
    const a = orcaQuote(pool, big, true, (s) => crossing.get(s));
    const b = orcaQuote(pool, big, true, (s) => plain.get(s));
    expect(a.used).toBe(big);
    expect(b.used).toBe(big);
    expect(a.out).toBeLessThan(b.out);
  });

  it('asks for the array it reaches and was not given, walks through one the chain has none of, and fills to the last one’s boundary', () => {
    const pool = w({ sqrtPriceX64: getSqrtPriceAtTick(5), tickCurrent: 5 });
    const only = new Map([[0, empty(0)]]);
    expect(orcaQuote(pool, 10n ** 13n, true, (s) => only.get(s)).needs).toBe(-88);
    // -88 is not on chain: the program swaps through it as empty and asks for the one after.
    const sparse = new Map([[0, empty(0)], [-88, null]]);
    expect(orcaQuote(pool, 10n ** 13n, true, (s) => sparse.get(s)).needs).toBe(-176);
    // Nothing on chain below: the fill stops at the boundary of the last array looked at, the rest unplaced.
    const r = orcaQuote(pool, 10n ** 13n, true, (s) => (s === 0 ? empty(0) : null));
    expect(r.needs).toBeNull();
    expect(r.used).toBeLessThan(10n ** 13n);
    expect(r.used).toBeGreaterThan(0n);
    expect(r.out).toBeGreaterThan(0n);
    // A trade that stays in its band needs nothing beyond it.
    expect(orcaQuote(pool, 1_000_000n, true, (s) => only.get(s))).toMatchObject({ used: 1_000_000n, needs: null });
  });

  it('reads the pool’s tick, spacing and adaptive fee tier from its account, and names the arrays near its price', () => {
    const b = Buffer.alloc(653);
    tag('Whirlpool').copy(b, 0);
    b.writeUInt16LE(16, 41);
    b.writeUInt16LE(1030, 43);
    b.writeUInt16LE(1600, 45);
    u128(b, 49, 7n);
    u128(b, 65, ONE);
    b.writeInt32LE(25793, 81);
    put(b, 101, SOL_MINT);
    put(b, 181, USDC_MINT);
    const s = whirlpoolState(b);
    expect(s).toMatchObject({ tickSpacing: 16, feeTierIndex: 1030, adaptive: true, feeRate: 1600, liquidity: 7n, tickCurrent: 25793 });
    expect(orcaArraysNear(DLMM_POOL, s).map((x) => x.start)).toEqual([23936, 25344, 26752]);
    // An adaptive pool trades (its Oracle gives the fee the quote adds); its `fee` here is the static part.
    const pool = decodePool('whirlpool', DLMM_POOL, b);
    expect(pool.adaptive).toBe(true);
    expect(pool.stopped).toBeNull();
    expect(pool.fee).toBe(0.0016);
    b.writeUInt16LE(16, 43);
    expect(decodePool('whirlpool', DLMM_POOL, b).adaptive).toBe(false);
  });
});

describe('exact quotes in a trip (arb-chain.mjs tripsFor)', () => {
  const key = (n) => bs58.encode(Buffer.alloc(32, n));
  const TOKEN = key(7);
  /** A band pool of TOKEN against USDC and a bin pool of the same, both priced only through `ctx.exact`. */
  const band = { address: key(1), dex: 'whirlpool', kind: 'band', fee: 0.003, liquidity: 10n ** 12n, sqrtPriceX64: ONE, tickCurrent: 0, tickSpacing: 1, adaptive: false, mintA: TOKEN, mintB: USDC_MINT, stopped: null, config: null, owedA: 0n, owedB: 0n };
  const bins = { address: key(2), dex: 'dlmm', kind: 'bins', fee: 0.001, activeId: 0, binStep: 10, mintA: TOKEN, mintB: USDC_MINT, vaultA: key(3), vaultB: key(4), stopped: null, config: null, owedA: 0n, owedB: 0n };
  const depths = new Map([[band.address, { a: 1e12, b: 1e12 }], [bins.address, { a: 1e12, b: 1e12 }]]);
  const ctx = (exact) => ({ token: TOKEN, decimals: 6, depths, usd: new Map([[USDC_MINT, 1], [SOL_MINT, 100]]), holds: new Map(), quotes: new Map(), bridge: null, settings: SETTINGS, tokenCut: 0, exact });

  it('leaves a band or bin pool out without one, and sizes by it with one', () => {
    // With no `exact` at all (the scanner), a band pool is priced from its band as before.
    expect(tripsFor([band, bins], ctx(undefined)).length).toBe(2);
    // With one that has nothing for them (arrays not read), they are left out.
    expect(tripsFor([band, bins], ctx(() => null))).toEqual([]);
    // The bin pool pays 2% more for the token than the band pool asks: a gap, in its spot price and its quote alike.
    const exact = (p, from) => (x) => (p === bins && from === TOKEN ? (1.02e12 * x * 0.999) / (1e12 + x * 0.999) : (1e12 * x * 0.997) / (1e12 + x * 0.997));
    const gapDepths = new Map([[band.address, { a: 1e12, b: 1e12 }], [bins.address, { a: 1e12, b: 1.02e12 }]]);
    const trips = tripsFor([band, bins], { ...ctx(exact), depths: gapDepths });
    // Only the way that pays at zero size is sized at all: the other is screened out, unsized.
    expect(trips.length).toBe(1);
    const best = trips[0];
    expect(best.legs.map((l) => l.pool)).toEqual([band.address, bins.address]);
    expect(best.pays).toBe(true);
    expect(best.sizedBy).toBe('gap');
  });

  it('screens by the price at zero size: a gap under the pools’ fees is never sized', () => {
    const same = () => (x) => (1e12 * x * 0.997) / (1e12 + x * 0.997);
    expect(tripsFor([band, bins], ctx(same))).toEqual([]);
    // A bin pool's spot price comes from its active bin, not from what its arrays hold (whose ratio here would screen the trip out).
    const lopsided = new Map([[band.address, { a: 1e12, b: 1e12 }], [bins.address, { a: 1e12, b: 1e10, spot: 1.02 }]]);
    const bigGap = (p, from) => (x) => (p === bins && from === TOKEN ? (1.02e12 * x * 0.999) / (1e12 + x * 0.999) : (1e12 * x * 0.997) / (1e12 + x * 0.997));
    expect(tripsFor([band, bins], { ...ctx(bigGap), depths: lopsided }).length).toBe(1);
  });

  it('a bin pool’s depth is what its arrays hold when given, else rough', () => {
    const amounts = { get: () => 1_000n };
    expect(depthOf(bins, amounts).rough).toBe(true);
    expect(depthOf(bins, amounts, () => ({ a: 5, b: 6 }))).toEqual({ a: 5, b: 6 });
    expect(depthOf(bins, amounts, () => ({ a: 5, b: 6, spot: 1.2 }))).toEqual({ a: 5, b: 6, spot: 1.2 });
    expect(depthOf(bins, amounts, () => null).rough).toBe(true);
  });
});

describe('Meteora DAMM v2', () => {
  /** A pool at price 1 with a Uniswap L of 1e12 (the program's figure carries 64 more bits), a 0.1% fee on the coin out. */
  const pool = (over = {}) => ({
    cliffFeeNumerator: 1_000_000n, baseFeeMode: 0, numberOfPeriod: 0, periodFrequency: 0n, reductionFactor: 0n, dynamic: null,
    liquidity: 10n ** 12n << 64n, sqrtMinPrice: 4295048016n, sqrtMaxPrice: 79226673521066979257578248091n, sqrtPrice: ONE,
    activationPoint: 0n, activationType: 1, status: 0, collectFeeMode: 0, version: 1, ...over,
  });
  const when = { now: 1_000, slot: 500 };
  const xyk = (x, fee) => (1e12 * x) / (1e12 + x) * (1 - fee);

  it('decodes a Pool account, and the chain library sees a band pool with a Uniswap liquidity', () => {
    const b = Buffer.alloc(1112);
    tag('Pool').copy(b, 0);
    b.writeBigUInt64LE(400_000n, 8);
    b[16] = 0;
    b.writeUInt16LE(3, 22);
    b.writeBigUInt64LE(100n, 24);
    b.writeBigUInt64LE(50_000n, 32);
    b[56] = 1;
    b.writeUInt32LE(880_000, 64);
    b.writeUInt32LE(2_000_000, 68);
    b.writeUInt16LE(10, 72);
    b.writeUInt16LE(30, 74);
    b.writeUInt16LE(600, 76);
    b.writeUInt16LE(5_000, 78);
    put(b, 168, SOL_MINT);
    put(b, 200, USDC_MINT);
    put(b, 232, DLMM_POOL);
    put(b, 264, DLMM_ARRAY_344);
    u128(b, 360, 7n << 64n);
    u128(b, 424, 100n);
    u128(b, 440, 1000n);
    u128(b, 456, ONE);
    b.writeBigUInt64LE(1_754_985_927n, 472);
    b[480] = 1;
    b[484] = 1;
    b[486] = 1;
    const s = dammState(b);
    expect(s).toMatchObject({ cliffFeeNumerator: 400_000n, baseFeeMode: 0, numberOfPeriod: 3, periodFrequency: 100n, reductionFactor: 50_000n, liquidity: 7n << 64n, sqrtMinPrice: 100n, sqrtMaxPrice: 1000n, sqrtPrice: ONE, activationPoint: 1_754_985_927n, activationType: 1, status: 0, collectFeeMode: 1, version: 1 });
    expect(s.dynamic).toMatchObject({ maxVolatilityAccumulator: 880_000, variableFeeControl: 2_000_000, binStep: 10, filterPeriod: 30, decayPeriod: 600, reductionFactor: 5_000 });
    const p = decodePool('damm', DLMM_POOL, b);
    expect(p).toMatchObject({ kind: 'band', fee: 0.0004, liquidity: 7n, sqrtPriceX64: ONE, mintA: SOL_MINT, mintB: USDC_MINT, vaultA: DLMM_POOL, vaultB: DLMM_ARRAY_344, stopped: null });
    b[481] = 1;
    expect(decodePool('damm', DLMM_POOL, b).stopped).toBe('trading switched off');
    b[481] = 0;
    b[16] = 2;
    expect(decodePool('damm', DLMM_POOL, b).stopped).toMatch(/rate-limiter/);
    expect(DEXES.damm.program).toBe('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
  });

  it('swaps within its range as x·y = k on its liquidity, the fee taken from the coin out', () => {
    const a = dammQuote(pool(), 1_000_000_000n, true, when);
    expect(a.used).toBe(1_000_000_000n);
    expect(a.fee).toBe(1_000_000n);
    expect(Number(a.out) / xyk(1e9, 0.001)).toBeCloseTo(1, 8);
    const b = dammQuote(pool(), 1_000_000_000n, false, when);
    expect(Number(b.out) / xyk(1e9, 0.001)).toBeCloseTo(1, 8);
  });

  it('in collect mode 1 the fee is in token B: on the coin in when B goes in, on the coin out otherwise', () => {
    const onB = pool({ collectFeeMode: 1 });
    const bIn = dammQuote(onB, 1_000_000_000n, false, when);
    expect(Number(bIn.out) / ((1e12 * 1e9 * 0.999) / (1e12 + 1e9 * 0.999))).toBeCloseTo(1, 8);
    const aIn = dammQuote(onB, 1_000_000_000n, true, when);
    expect(Number(aIn.out) / xyk(1e9, 0.001)).toBeCloseTo(1, 8);
  });

  it('follows the fee schedule from activation: linear, by a factor, and not at all for the rate limiter', () => {
    const linear = pool({ cliffFeeNumerator: 10_000_000n, numberOfPeriod: 10, periodFrequency: 100n, reductionFactor: 1_000_000n, activationPoint: 0n });
    expect(dammBaseFee(linear, 350n)).toBe(7_000_000n);
    expect(dammBaseFee(linear, 5_000n)).toBe(0n);
    const factor = pool({ baseFeeMode: 1, cliffFeeNumerator: 10_000_000n, numberOfPeriod: 10, periodFrequency: 100n, reductionFactor: 5_000n });
    const two = dammBaseFee(factor, 250n);
    expect(two >= 2_499_990n && two <= 2_500_000n).toBe(true);
    expect(dammBaseFee(pool({ baseFeeMode: 2 }), 1n)).toBeNull();
    expect(dammQuote(pool({ baseFeeMode: 2 }), 1n, true, when).refused).toBe('RateLimiterFeeNotRead');
    // On the slot when the pool says so.
    expect(dammPoint(pool({ activationType: 0 }), when)).toBe(500n);
    expect(dammPoint(pool(), when)).toBe(1_000n);
  });

  it('refuses a trade its range cannot hold, and a pool not yet active or switched off', () => {
    const narrow = pool({ sqrtMinPrice: ONE - 1_000n });
    expect(dammQuote(narrow, 10n ** 12n, true, when).refused).toBe('PriceRangeViolation');
    expect(dammQuote(pool({ activationPoint: 2_000n }), 1n, true, when).refused).toBe('PoolNotActive');
    expect(dammQuote(pool({ status: 1 }), 1n, true, when).refused).toBe('PoolDisabled');
  });
});

describe('Orca adaptive fee', () => {
  const oracle = (over = {}) => ({
    whirlpool: DLMM_POOL, tradeEnableTimestamp: 0n, filterPeriod: 30, decayPeriod: 600, reductionFactor: 5_000, adaptiveFeeControlFactor: 80_000, maxVolatilityAccumulator: 880_000, tickGroupSize: 1, majorSwapThresholdTicks: 1,
    lastReferenceUpdateTimestamp: 1_000n, lastMajorSwapTimestamp: 0n, volatilityReference: 0, tickGroupIndexReference: 0, volatilityAccumulator: 0, ...over,
  });

  it('decodes an Oracle account and names it', () => {
    const b = Buffer.alloc(254);
    tag('Oracle').copy(b, 0);
    put(b, 8, DLMM_POOL);
    b.writeBigUInt64LE(5n, 40);
    b.writeUInt16LE(30, 48);
    b.writeUInt16LE(600, 50);
    b.writeUInt16LE(5_000, 52);
    b.writeUInt32LE(80_000, 54);
    b.writeUInt32LE(880_000, 58);
    b.writeUInt16LE(2, 62);
    b.writeUInt16LE(2, 64);
    b.writeBigUInt64LE(1_794_040_073n, 82);
    b.writeBigUInt64LE(1_794_039_710n, 90);
    b.writeUInt32LE(8_755, 98);
    b.writeInt32LE(3_156, 102);
    b.writeUInt32LE(8_755, 106);
    expect(decodeOrcaOracle(b)).toEqual({ whirlpool: DLMM_POOL, tradeEnableTimestamp: 5n, filterPeriod: 30, decayPeriod: 600, reductionFactor: 5_000, adaptiveFeeControlFactor: 80_000, maxVolatilityAccumulator: 880_000, tickGroupSize: 2, majorSwapThresholdTicks: 2, lastReferenceUpdateTimestamp: 1_794_040_073n, lastMajorSwapTimestamp: 1_794_039_710n, volatilityReference: 8_755, tickGroupIndexReference: 3_156, volatilityAccumulator: 8_755 });
    expect(decodeOrcaOracle(Buffer.alloc(254))).toBeNull();
    expect(orcaOracleAddress(DLMM_POOL)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it('adds nothing at rest, 0.62% at this pool’s most volatility, and never past the hard limit', () => {
    expect(orcaAdaptiveFeeRate(oracle(), 0)).toBe(0);
    // 880,000 at control factor 80,000: 80,000 × 880,000² / 1e13 = 6,195.2 → 6,196 per million.
    expect(orcaAdaptiveFeeRate(oracle(), 880_000)).toBe(6_196);
    // 10,000 (one tick group): 80,000 × 10,000² / 1e13 = 0.8 → 1 per million, rounded up.
    expect(orcaAdaptiveFeeRate(oracle(), 10_000)).toBe(1);
    expect(orcaAdaptiveFeeRate(oracle({ adaptiveFeeControlFactor: 4_000_000_000 }), 880_000)).toBe(ORCA_FEE_RATE_HARD_LIMIT);
  });

  const fixedArray = (start) => {
    const b = Buffer.alloc(9988);
    tag('TickArray').copy(b, 0);
    b.writeInt32LE(start, 8);
    put(b, 9956, DLMM_POOL);
    return decodeOrcaTickArray(b);
  };
  const arrays = new Map([[-88, fixedArray(-88)], [0, fixedArray(0)], [88, fixedArray(88)]]);
  const w = { tickSpacing: 1, feeTierIndex: 1026, adaptive: true, feeRate: 100, liquidity: 10n ** 12n, sqrtPriceX64: ONE, tickCurrent: 0 };

  it('a quiet pool pays its static fee plus what its own ticks add; a volatile one pays the adaptive fee too', () => {
    const plain = (amount) => orcaQuote({ ...w, adaptive: false }, amount, true, (s) => arrays.get(s));
    // A trade that stays in its tick group pays the static fee (one group counted at the boundary it starts on: a unit per million).
    const small = orcaQuote(w, 1_000_000n, true, (s) => arrays.get(s), oracle(), 1_010);
    expect(Number(small.out) / Number(plain(1_000_000n).out)).toBeCloseTo(1, 5);
    // One that crosses some twenty tick groups pays a little more each group, as the program charges.
    const quiet = orcaQuote(w, 1_000_000_000n, true, (s) => arrays.get(s), oracle(), 1_010);
    expect(quiet.used).toBe(1_000_000_000n);
    const ratio = Number(quiet.out) / Number(plain(1_000_000_000n).out);
    expect(ratio).toBeLessThan(1);
    expect(ratio).toBeGreaterThan(0.999);
    // Within the filter period the stored accumulator holds: at its most, 6,196 per million on top of the static 100.
    const volatile = orcaQuote(w, 1_000_000_000n, true, (s) => arrays.get(s), oracle({ volatilityAccumulator: 880_000, volatilityReference: 880_000 }), 1_010);
    expect(Number(volatile.out) / Number(plain(1_000_000_000n).out)).toBeCloseTo((1 - 0.006296) / (1 - 0.0001), 4);
    // Past the decay period the references reset: the same swap pays what the quiet pool's does.
    const decayed = orcaQuote(w, 1_000_000_000n, true, (s) => arrays.get(s), oracle({ volatilityAccumulator: 880_000, volatilityReference: 880_000 }), 2_000);
    expect(decayed.out).toBe(quiet.out);
    // Within the decay period the reference is the accumulator reduced by half: between the two.
    const halved = orcaQuote(w, 1_000_000_000n, true, (s) => arrays.get(s), oracle({ volatilityAccumulator: 880_000, volatilityReference: 880_000, lastReferenceUpdateTimestamp: 900n }), 1_010);
    expect(halved.out).toBeGreaterThan(volatile.out);
    expect(halved.out).toBeLessThan(quiet.out);
  });
});
