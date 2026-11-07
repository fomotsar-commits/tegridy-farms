/**
 * The concentrated and bin venues priced to the unit: Orca Whirlpools, Raydium CLMM and Meteora
 * DLMM (owner 2026-11-07: "shouldn't we be trying to find the opportunities where the volume
 * already is"). Until now a band pool was priced from the liquidity in its current band alone and
 * a bin pool from its vaults, and those readings made the fake gaps of 11-06 (165 of 171). Here
 * each quote walks the pool's own ticks or bins, as its program's swap does, on the accounts the
 * listener holds:
 *
 *   Orca        swap_manager.rs / swap_math.rs: the same price maths as Raydium's (both are
 *               Uniswap v3 in Q64.64, fee per million on the coin in), so each step is the
 *               range-pool port's computeSwap (src/lib/solana/clmm/quote.ts); the ticks come 88
 *               to an array, fixed (9988 bytes) or dynamic (a tag byte a tick), and the walk
 *               crosses each initialized tick's liquidity_net. A pool on an adaptive fee tier
 *               (fee_tier_index ≠ tick_spacing) adds a fee from its Oracle account that is not
 *               read here: it is left unpriced, and said so.
 *   Raydium CLMM the range-pool port itself (quoteSwapAsRaydium: proven on recorded mainnet
 *               swaps, clmm/quoteLive.test.ts), with Raydium's program id for the addresses.
 *   Meteora DLMM lb_pair.rs / bin.rs: each bin trades at one price (constant sum) until its out
 *               side is empty, then the next; the fee is the base fee plus a variable fee from
 *               the volatility accumulator, which the walk advances per bin as the program does
 *               (update_references, update_volatility_accumulator); 70 bins to an array.
 *
 * A quote never guesses: an array it needs and was not given ends it (`needs`), and one the chain
 * does not have ends the fill there (the program could not pass it either). Everything is BigInt
 * in raw units; the listener wraps a quote as the leg's `out` (keeper/rule.ts CpLeg).
 */
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { computeSwap, quoteSwapAsRaydium } from '../../src/lib/solana/clmm/quote.ts';
import { ClmmMathError, MAX_SQRT_PRICE_X64, MAX_TICK, MIN_SQRT_PRICE_X64, MIN_TICK, addDelta, getSqrtPriceAtTick, getTickAtSqrtPrice } from '../../src/lib/solana/clmm/math.ts';
import { decodeAmmConfig, decodeBitmapExtension, decodePoolState, decodeTickArray, deriveBitmapExtension, deriveTickArray } from '../../src/lib/solana/clmm/program.ts';
import { firstInitializedTickArray, getArrayStartIndex, nextInitializedTickArrayStartIndex } from '../../src/lib/solana/clmm/bitmap.ts';

export const WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
export const CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
export const DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

const tagOf = (name) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
const TAG = { tickArray: tagOf('TickArray'), dynamicTickArray: tagOf('DynamicTickArray'), oracle: tagOf('Oracle'), binArray: tagOf('BinArray') };

const key = (d, at) => bs58.encode(d.subarray(at, at + 32));
const u16 = (d, at) => d.readUInt16LE(at);
const u32 = (d, at) => d.readUInt32LE(at);
const i32 = (d, at) => d.readInt32LE(at);
const u64 = (d, at) => d.readBigUInt64LE(at);
const i64 = (d, at) => d.readBigInt64LE(at);
const u128 = (d, at) => d.readBigUInt64LE(at) + (d.readBigUInt64LE(at + 8) << 64n);
const i128 = (d, at) => BigInt.asIntN(128, u128(d, at));
const pda = (program, seeds) => PublicKey.findProgramAddressSync(seeds, new PublicKey(program))[0].toBase58();

/**
 * Derived addresses, remembered: a derivation searches bump seeds with a hash and a curve check
 * each, up to a millisecond, and a quote asks for the same array's address at every step of every
 * size the robot's rule tries. The cache is cleared when it grows past a bound it never reaches.
 */
const derived = new Map();
function remembered(key, derive) {
  let v = derived.get(key);
  if (v === undefined) {
    if (derived.size > 100_000) derived.clear();
    v = derive();
    derived.set(key, v);
  }
  return v;
}
const ceilDiv = (a, b) => (a + b - 1n) / b;
const U64_MAX = (1n << 64n) - 1n;

/** How many steps a walk may take before it is a loop, not a swap. */
const MAX_STEPS = 2_000;

/* ─────────────────────────────── Orca Whirlpools ─────────────────────────────── */

export const ORCA_TICKS_PER_ARRAY = 88;

/** The figures a whirlpool quote needs beyond decodePool's, from the pool's account. */
export function whirlpoolState(data) {
  if (!Buffer.isBuffer(data) || data.length !== 653) return null;
  const tickSpacing = u16(data, 41);
  const feeTierIndex = u16(data, 43);
  return { tickSpacing, feeTierIndex, adaptive: feeTierIndex !== tickSpacing, feeRate: u16(data, 45), liquidity: u128(data, 49), sqrtPriceX64: u128(data, 65), tickCurrent: i32(data, 81) };
}

/** The start tick of the array holding `tick` (88 ticks of `spacing` an array, floored). */
export const orcaArrayStart = (tick, spacing) => Math.floor(tick / (ORCA_TICKS_PER_ARRAY * spacing)) * ORCA_TICKS_PER_ARRAY * spacing;

/** `["tick_array", whirlpool, start as a decimal string]`. */
export const orcaArrayAddress = (pool, start) => remembered(`o:${pool}:${start}`, () => pda(WHIRLPOOL_PROGRAM, [Buffer.from('tick_array'), new PublicKey(pool).toBuffer(), Buffer.from(String(start))]));

/**
 * An Orca tick array, fixed (9988 bytes: 88 ticks of 113) or dynamic (a tag byte a tick, 112
 * bytes more when it is initialized), as { start, whirlpool, ticks[88] }; null when not one.
 */
export function decodeOrcaTickArray(data) {
  if (!Buffer.isBuffer(data) || data.length < 12) return null;
  const disc = data.subarray(0, 8);
  if (disc.equals(TAG.tickArray)) {
    if (data.length !== 9988) return null;
    const ticks = [];
    for (let i = 0; i < ORCA_TICKS_PER_ARRAY; i++) {
      const at = 12 + i * 113;
      ticks.push({ initialized: data[at] !== 0, liquidityNet: i128(data, at + 1), liquidityGross: u128(data, at + 17) });
    }
    return { start: i32(data, 8), whirlpool: key(data, 9956), ticks, dynamic: false };
  }
  if (disc.equals(TAG.dynamicTickArray)) {
    if (data.length < 60 + ORCA_TICKS_PER_ARRAY) return null;
    const ticks = [];
    let at = 60;
    for (let i = 0; i < ORCA_TICKS_PER_ARRAY; i++) {
      if (at >= data.length) return null;
      const set = data[at];
      at += 1;
      if (set === 0) {
        ticks.push({ initialized: false, liquidityNet: 0n, liquidityGross: 0n });
        continue;
      }
      if (at + 112 > data.length) return null;
      ticks.push({ initialized: true, liquidityNet: i128(data, at), liquidityGross: u128(data, at + 16) });
      at += 112;
    }
    return { start: i32(data, 8), whirlpool: key(data, 12), ticks, dynamic: true };
  }
  return null;
}

/** The arrays a whirlpool quote reaches first: the one holding its tick and one each side. */
export function orcaArraysNear(pool, w) {
  const per = ORCA_TICKS_PER_ARRAY * w.tickSpacing;
  const start = orcaArrayStart(w.tickCurrent, w.tickSpacing);
  return [start - per, start, start + per].filter((s) => s >= orcaArrayStart(MIN_TICK, w.tickSpacing) && s <= orcaArrayStart(MAX_TICK, w.tickSpacing)).map((s) => ({ start: s, address: orcaArrayAddress(pool, s) }));
}

/** `["oracle", whirlpool]`: the account an adaptive-fee pool keeps its fee's state in. */
export const orcaOracleAddress = (pool) => remembered(`r:${pool}`, () => pda(WHIRLPOOL_PROGRAM, [Buffer.from('oracle'), new PublicKey(pool).toBuffer()]));

/**
 * An Oracle account (254 bytes, read 2026-11-07 on five live pools): the adaptive fee's
 * constants (filter and decay periods, reduction factor, control factor, the most volatility
 * counts, the tick group size) and its variables (the reference timestamps, the volatility
 * reference, the tick group reference, the accumulator); null when not one.
 */
export function decodeOrcaOracle(data) {
  if (!Buffer.isBuffer(data) || data.length !== 254 || !data.subarray(0, 8).equals(TAG.oracle)) return null;
  return {
    whirlpool: key(data, 8), tradeEnableTimestamp: u64(data, 40),
    filterPeriod: u16(data, 48), decayPeriod: u16(data, 50), reductionFactor: u16(data, 52), adaptiveFeeControlFactor: u32(data, 54), maxVolatilityAccumulator: u32(data, 58), tickGroupSize: u16(data, 62), majorSwapThresholdTicks: u16(data, 64),
    lastReferenceUpdateTimestamp: u64(data, 82), lastMajorSwapTimestamp: u64(data, 90), volatilityReference: u32(data, 98), tickGroupIndexReference: i32(data, 102), volatilityAccumulator: u32(data, 106),
  };
}

/** The most a whirlpool's whole fee rate can be, 10% (fee_rate_manager.rs FEE_RATE_HARD_LIMIT), per million. */
export const ORCA_FEE_RATE_HARD_LIMIT = 100_000;

/** `compute_adaptive_fee_rate`: the fee the volatility adds, per million, capped at the hard limit. */
export function orcaAdaptiveFeeRate(o, volatilityAccumulator) {
  const crossed = BigInt(volatilityAccumulator) * BigInt(o.tickGroupSize);
  const rate = ceilDiv(BigInt(o.adaptiveFeeControlFactor) * crossed * crossed, 100_000n * 10_000n * 10_000n);
  return rate > BigInt(ORCA_FEE_RATE_HARD_LIMIT) ? ORCA_FEE_RATE_HARD_LIMIT : Number(rate);
}

/**
 * The adaptive fee's state as a swap starts (FeeRateManager::new, update_reference): the tick
 * group the price is in, and the references refreshed by the time since the last reference
 * update or major swap (within the filter period they hold; within the decay period the
 * volatility reference is the accumulator reduced; past it, zero). The same design Raydium's
 * dynamic fee ported (src/lib/solana/clmm/quote.ts), followed here step for step.
 */
function adaptiveStart(o, tick, now) {
  const fm = { o, g: o.tickGroupSize, index: Math.floor(tick / o.tickGroupSize), ref: o.tickGroupIndexReference, vRef: o.volatilityReference, acc: o.volatilityAccumulator };
  const t = BigInt(Math.floor(now));
  const last = o.lastReferenceUpdateTimestamp > o.lastMajorSwapTimestamp ? o.lastReferenceUpdateTimestamp : o.lastMajorSwapTimestamp;
  const since = t > last ? t - last : 0n;
  if (since >= BigInt(o.decayPeriod)) {
    fm.ref = fm.index;
    fm.vRef = 0;
  } else if (since >= BigInt(o.filterPeriod)) {
    fm.ref = fm.index;
    fm.vRef = Number((BigInt(o.volatilityAccumulator) * BigInt(o.reductionFactor)) / 10_000n);
  }
  return fm;
}
/** `update_volatility_accumulator`: the reference plus the tick groups crossed since it, capped. */
function adaptiveAccumulate(fm) {
  const acc = fm.vRef + Math.abs(fm.ref - fm.index) * 10_000;
  fm.acc = Math.min(acc, fm.o.maxVolatilityAccumulator);
}
/** `get_bounded_sqrt_price_target`: with a live adaptive fee a step stops at each tick group's edge, so the fee can rise; skipped when nothing would change it. */
function adaptiveBound(fm, target, liquidity, aToB) {
  if (liquidity === 0n || fm.acc === fm.o.maxVolatilityAccumulator) return [true, target, null];
  const edge = Math.min(MAX_TICK, Math.max(MIN_TICK, aToB ? fm.index * fm.g : (fm.index + 1) * fm.g));
  const price = getSqrtPriceAtTick(edge);
  if (aToB) return target > price ? [false, target, null] : [false, price, edge];
  return target < price ? [false, target, null] : [false, price, edge];
}
/** `advance_tick_group` / `advance_tick_group_after_skip`: the next tick group, the accumulator caught up after a skipped step. */
function adaptiveAdvance(fm, skipped, tickAtPrice, aToB) {
  if (skipped) {
    let index = Math.floor(tickAtPrice / fm.g);
    if (!aToB && tickAtPrice % fm.g === 0) index -= 1;
    fm.index = index;
    if (fm.acc !== fm.o.maxVolatilityAccumulator) adaptiveAccumulate(fm);
  }
  fm.index += aToB ? -1 : 1;
}

/** The most arrays one walk looks through: what a swap could carry, and more than a trip of the robot's size reaches. */
const ORCA_MAX_ARRAYS = 8;

/**
 * `SwapTickSequence::get_next_initialized_tick_index`: the next tick with liquidity from `tick`,
 * going down (a to b: this tick counts) or up (the next one on), across arrays. `array(start)`
 * gives a decoded array, undefined when not read, or null when the chain has none: the program
 * walks through one it was not given as empty (a sparse swap), and when the arrays it carries
 * run out it fills to the last one's boundary and no further, so does this (`boundary`).
 */
function orcaNextTick(tick, aToB, spacing, array) {
  const per = ORCA_TICKS_PER_ARRAY * spacing;
  let start = orcaArrayStart(tick, spacing);
  let offset = Math.floor((tick - start) / spacing) + (aToB ? 0 : 1);
  // The boundary tick of array `s` the way the walk goes: where a swap carrying no more arrays stops.
  const edge = (s) => (aToB ? s : s + per - 1);
  for (let hops = 1; ; hops++) {
    const arr = array(start);
    if (arr === undefined) {
      // Not read: fill to the boundary of the array before it first, then ask for it.
      if (hops === 1) return { needs: start };
      return { tick: edge(start - (aToB ? -per : per)), initialized: false, liquidityNet: 0n, then: { needs: start } };
    }
    if (arr !== null) {
      while (offset >= 0 && offset < ORCA_TICKS_PER_ARRAY) {
        const t = arr.ticks[offset];
        if (t.initialized) return { tick: start + offset * spacing, initialized: true, liquidityNet: t.liquidityNet };
        offset += aToB ? -1 : 1;
      }
    }
    if (aToB && start <= orcaArrayStart(MIN_TICK, spacing)) return { tick: MIN_TICK, initialized: false, liquidityNet: 0n };
    if (!aToB && start >= orcaArrayStart(MAX_TICK, spacing)) return { tick: MAX_TICK, initialized: false, liquidityNet: 0n };
    if (hops >= ORCA_MAX_ARRAYS) return { tick: edge(start), initialized: false, liquidityNet: 0n, then: 'end' };
    start += aToB ? -per : per;
    offset = aToB ? ORCA_TICKS_PER_ARRAY - 1 : 0;
  }
}

/**
 * What `amountIn` of one coin pays out of a whirlpool (a to b: coin A in), walking its ticks as
 * swap_manager.rs does. { out, used, needs }: `used` is the input the walk could place (all of it
 * unless an array was missing on chain), `needs` a start tick whose array must be read first.
 * `oracle` (decodeOrcaOracle) is an adaptive-fee pool's: each step then pays the static rate
 * plus the fee its volatility adds, stopping at tick group edges so the fee can rise mid-swap,
 * exactly as the program's fee rate manager does; `now` is the swap's time in unix seconds.
 */
export function orcaQuote(w, amountIn, aToB, array, oracle = null, now = Date.now() / 1000) {
  const limit = aToB ? MIN_SQRT_PRICE_X64 : MAX_SQRT_PRICE_X64;
  let remaining = amountIn;
  let out = 0n;
  let sqrtP = w.sqrtPriceX64;
  let tick = w.tickCurrent;
  let L = w.liquidity;
  const fm = oracle ? adaptiveStart(oracle, tick, now) : null;
  let steps = 0;
  walk: while (remaining > 0n && sqrtP !== limit) {
    if (++steps > MAX_STEPS) break;
    const next = orcaNextTick(tick, aToB, w.tickSpacing, array);
    if (next.needs !== undefined) return { out, used: amountIn - remaining, needs: next.needs };
    const nextSqrt = getSqrtPriceAtTick(Math.min(MAX_TICK, Math.max(MIN_TICK, next.tick)));
    const target = aToB ? (nextSqrt < limit ? limit : nextSqrt) : nextSqrt > limit ? limit : nextSqrt;
    let liquidityNext = L;
    for (;;) {
      if (++steps > MAX_STEPS) break walk;
      if (fm) adaptiveAccumulate(fm);
      const feeRate = fm ? Math.min(w.feeRate + orcaAdaptiveFeeRate(fm.o, fm.acc), ORCA_FEE_RATE_HARD_LIMIT) : w.feeRate;
      const [skipped, bounded, edge] = fm ? adaptiveBound(fm, target, L, aToB) : [true, target, null];
      let step;
      if (sqrtP !== bounded) {
        try {
          step = computeSwap(sqrtP, bounded, L, remaining, feeRate, true, aToB, true);
        } catch (e) {
          if (e instanceof ClmmMathError) break walk;
          throw e;
        }
        remaining -= step.amountIn + step.feeAmount;
        out += step.amountOut;
      } else {
        step = { sqrtPriceNextX64: bounded, amountIn: 0n, amountOut: 0n, feeAmount: 0n };
      }
      if (step.sqrtPriceNextX64 === nextSqrt) {
        if (next.initialized) {
          try {
            liquidityNext = addDelta(L, aToB ? -next.liquidityNet : next.liquidityNet);
          } catch (e) {
            if (e instanceof ClmmMathError) break walk;
            throw e;
          }
        }
        tick = aToB ? next.tick - 1 : next.tick;
      } else if (step.sqrtPriceNextX64 !== sqrtP) {
        tick = edge !== null && step.sqrtPriceNextX64 === bounded ? edge : getTickAtSqrtPrice(step.sqrtPriceNextX64);
      }
      sqrtP = step.sqrtPriceNextX64;
      if (fm) adaptiveAdvance(fm, skipped, sqrtP === nextSqrt ? next.tick : tick, aToB);
      if (remaining === 0n || sqrtP === target) break;
    }
    L = liquidityNext;
    if (next.then === 'end') break;
    if (next.then?.needs !== undefined) {
      if (remaining > 0n) return { out, used: amountIn - remaining, needs: next.then.needs };
      break;
    }
  }
  return { out, used: amountIn - remaining, needs: null };
}

/* ─────────────────────────────── Raydium CLMM ────────────────────────────────── */

const CLMM_PK = new PublicKey(CLMM_PROGRAM);
export const decodeClmmPool = (address, data) => (Buffer.isBuffer(data) ? decodePoolState(address, data) : null);
export const decodeClmmConfig = (address, data) => (Buffer.isBuffer(data) ? decodeAmmConfig(address, data) : null);
export const decodeClmmExtension = (address, data) => (Buffer.isBuffer(data) ? decodeBitmapExtension(address, data) : null);
export const decodeClmmArray = (address, data) => (Buffer.isBuffer(data) ? decodeTickArray(address, data) : null);
export const clmmExtensionAddress = (pool) => remembered(`x:${pool}`, () => deriveBitmapExtension(CLMM_PK, new PublicKey(pool)).toBase58());
export const clmmArrayAddress = (pool, start) => remembered(`c:${pool}:${start}`, () => deriveTickArray(CLMM_PK, new PublicKey(pool), start).toBase58());
export const clmmArrayStart = (tick, spacing) => getArrayStartIndex(tick, spacing);

/**
 * The tick arrays a Raydium CLMM quote reaches first, each way: the first array in use from the
 * price (the one holding it when in use) and the next one, from the pool's map and its extension.
 */
export function clmmArraysNear(address, pool, ext) {
  const starts = new Set();
  for (const zeroForOne of [true, false]) {
    try {
      const [, first] = firstInitializedTickArray(pool, ext, zeroForOne);
      starts.add(first);
      const next = nextInitializedTickArrayStartIndex(pool, ext, first, zeroForOne);
      if (next !== null) starts.add(next);
    } catch {
      // no liquidity that way, or the extension is needed and not read
    }
  }
  return [...starts].map((start) => ({ start, address: clmmArrayAddress(address, start) }));
}

/**
 * What `amountIn` pays out of a Raydium CLMM pool, through the range-pool port with Raydium's
 * fee ceiling. `band(start)` gives a decoded tick array or undefined. A refusal (no liquidity
 * that far, a stopped pool) is a fill of nothing, named in `refused`.
 */
export function clmmQuote(pool, config, ext, amountIn, zeroForOne, now, band) {
  const q = quoteSwapAsRaydium({ pool, config, extension: ext, band, zeroForOne, isBaseInput: true, amount: amountIn, sqrtPriceLimitX64: 0n, blockTimestamp: now });
  if (q.kind === 'needs-band') return { out: 0n, used: 0n, needs: q.startTickIndex };
  if (q.kind === 'refused') return { out: 0n, used: 0n, needs: null, refused: q.code };
  return { out: q.amountOut, used: q.amountIn, needs: null };
}

/* ─────────────────────────────── Meteora DLMM ────────────────────────────────── */

export const DLMM_BINS_PER_ARRAY = 70;
const ONE = 1n << 64n;
const U128_MAX = (1n << 128n) - 1n;
const BPS = 10_000n;
const FEE_PRECISION = 1_000_000_000n;
const MAX_FEE_RATE = 100_000_000n;
const MAX_EXPONENTIAL = 0x80000;

/** The figures a DLMM quote needs, from the LbPair account (904 bytes). */
export function lbPairState(data) {
  if (!Buffer.isBuffer(data) || data.length !== 904) return null;
  const bitmap = [];
  for (let i = 0; i < 16; i++) bitmap.push(u64(data, 584 + i * 8));
  return {
    baseFactor: u16(data, 8), filterPeriod: u16(data, 10), decayPeriod: u16(data, 12), reductionFactor: u16(data, 14),
    variableFeeControl: u32(data, 16), maxVolatilityAccumulator: u32(data, 20), minBinId: i32(data, 24), maxBinId: i32(data, 28),
    protocolShare: u16(data, 32), baseFeePowerFactor: data[34],
    volatilityAccumulator: u32(data, 40), volatilityReference: u32(data, 44), indexReference: i32(data, 48), lastUpdateTimestamp: i64(data, 56),
    pairType: data[75], activeId: i32(data, 76), binStep: u16(data, 80), status: data[82], bitmap,
  };
}

/** The bin array holding `binId`: 70 bins an array, floored. */
export const dlmmArrayIndex = (binId) => Math.floor(binId / DLMM_BINS_PER_ARRAY);

/** `["bin_array", lb_pair, index as a little-endian i64]`. */
export function dlmmArrayAddress(pool, index) {
  return remembered(`d:${pool}:${index}`, () => {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(index));
    return pda(DLMM_PROGRAM, [Buffer.from('bin_array'), new PublicKey(pool).toBuffer(), b]);
  });
}

/** Whether the pool's own map (bin arrays -512 to 511) marks `index` as in use; null past the map (an extension account, not read). */
export function dlmmArrayInUse(p, index) {
  if (index < -512 || index > 511) return null;
  const bit = index + 512;
  return ((p.bitmap[bit >> 6] >> BigInt(bit & 63)) & 1n) === 1n;
}

/** A bin array (10136 bytes: 70 bins of 144) as { index, lbPair, bins[70] }, each bin its two amounts and stored price; null when not one. */
export function decodeBinArray(data) {
  if (!Buffer.isBuffer(data) || data.length !== 10136 || !data.subarray(0, 8).equals(TAG.binArray)) return null;
  const bins = [];
  for (let i = 0; i < DLMM_BINS_PER_ARRAY; i++) {
    const at = 56 + i * 144;
    bins.push({ x: u64(data, at), y: u64(data, at + 8), price: u128(data, at + 16) });
  }
  return { index: Number(i64(data, 8)), lbPair: key(data, 24), bins };
}

/** u128x128_math.rs `pow`: base^exp in Q64.64, as the program computes it; null where it gives None. */
export function dlmmPow(base, exp) {
  let invert = exp < 0;
  if (exp === 0) return ONE;
  const e = Math.abs(exp);
  if (e >= MAX_EXPONENTIAL) return null;
  let squared = base;
  let result = ONE;
  if (squared >= result) {
    squared = U128_MAX / squared;
    invert = !invert;
  }
  for (let bit = 1; bit < MAX_EXPONENTIAL; bit <<= 1) {
    if (e & bit) result = (result * squared) >> 64n;
    squared = (squared * squared) >> 64n;
  }
  if (result === 0n) return null;
  return invert ? U128_MAX / result : result;
}

/** `get_price_from_id`: (1 + bin_step / 10,000)^bin_id in Q64.64. */
export function dlmmPrice(binId, binStep) {
  return dlmmPow(ONE + (BigInt(binStep) << 64n) / BPS, binId);
}

/** `get_base_fee`, `compute_variable_fee`, `get_total_fee`: rates in billionths. */
export const dlmmBaseFee = (p) => BigInt(p.baseFactor) * BigInt(p.binStep) * 10n * 10n ** BigInt(p.baseFeePowerFactor);
export function dlmmVariableFee(p, volatilityAccumulator) {
  if (!(p.variableFeeControl > 0)) return 0n;
  const square = (BigInt(volatilityAccumulator) * BigInt(p.binStep)) ** 2n;
  return (BigInt(p.variableFeeControl) * square + 99_999_999_999n) / 100_000_000_000n;
}
export function dlmmTotalFee(p, volatilityAccumulator = p.volatilityAccumulator) {
  const total = dlmmBaseFee(p) + dlmmVariableFee(p, volatilityAccumulator);
  return total < MAX_FEE_RATE ? total : MAX_FEE_RATE;
}

/** The arrays a DLMM quote reaches first: the active bin's and one each side, those the map marks in use. */
export function dlmmArraysNear(pool, p) {
  const idx = dlmmArrayIndex(p.activeId);
  return [idx - 1, idx, idx + 1].filter((i) => dlmmArrayInUse(p, i) !== false).map((i) => ({ index: i, address: dlmmArrayAddress(pool, i) }));
}

/**
 * What `amountIn` pays out of a DLMM pool (swapForY: coin X in), bin by bin as lb_pair.rs's swap
 * does, with the fee's references advanced from `now` (unix seconds) and its accumulator per bin.
 * `array(index)` gives a decoded bin array, undefined when not read, null when the chain has none.
 */
export function dlmmQuote(p, amountIn, swapForY, now, array) {
  const baseFee = dlmmBaseFee(p);
  let vRef = BigInt(p.volatilityReference);
  let idxRef = p.indexReference;
  let vAcc = BigInt(p.volatilityAccumulator);
  const elapsed = BigInt(Math.floor(now)) - p.lastUpdateTimestamp;
  if (elapsed >= BigInt(p.filterPeriod)) {
    idxRef = p.activeId;
    vRef = elapsed < BigInt(p.decayPeriod) ? (vAcc * BigInt(p.reductionFactor)) / BPS : 0n;
  }
  let active = p.activeId;
  let left = amountIn;
  let out = 0n;
  let fee = dlmmTotalFee(p);
  for (let steps = 0; left > 0n; steps++) {
    if (steps > MAX_STEPS) break;
    const index = dlmmArrayIndex(active);
    const inUse = dlmmArrayInUse(p, index);
    if (inUse === null) break;
    let arr = inUse ? array(index) : null;
    if (arr === undefined) return { out, used: amountIn - left, needs: index, fee };
    if (arr !== null && arr.index !== index) arr = null;
    if (arr === null) {
      // No liquidity in this array: the program's walk jumps to the next array in use.
      let next = index;
      for (;;) {
        next += swapForY ? -1 : 1;
        const use = dlmmArrayInUse(p, next);
        if (use === null) return { out, used: amountIn - left, needs: null, fee };
        if (use) break;
      }
      active = swapForY ? next * DLMM_BINS_PER_ARRAY + DLMM_BINS_PER_ARRAY - 1 : next * DLMM_BINS_PER_ARRAY;
      if (active < p.minBinId || active > p.maxBinId) break;
      continue;
    }
    const bin = arr.bins[active - index * DLMM_BINS_PER_ARRAY];
    const has = swapForY ? bin.y > 0n : bin.x > 0n;
    if (has) {
      const delta = BigInt(Math.abs(idxRef - active));
      const acc = vRef + delta * BPS;
      const max = BigInt(p.maxVolatilityAccumulator);
      vAcc = acc < max ? acc : max;
      fee = dlmmTotalFee(p, vAcc);
      const price = bin.price > 0n ? bin.price : dlmmPrice(active, p.binStep);
      if (!price) break;
      const maxOut = swapForY ? bin.y : bin.x;
      const maxIn = swapForY ? ceilDiv(bin.y << 64n, price) : ceilDiv(bin.x * price, ONE);
      if (maxIn > U64_MAX) break;
      const maxFee = ceilDiv(maxIn * fee, FEE_PRECISION - fee);
      if (left > maxIn + maxFee) {
        left -= maxIn + maxFee;
        out += maxOut;
      } else {
        const f = ceilDiv(left * fee, FEE_PRECISION);
        const inAfter = left - f;
        const got = swapForY ? (inAfter * price) >> 64n : (inAfter << 64n) / price;
        out += got < maxOut ? got : maxOut;
        left = 0n;
      }
    }
    if (left > 0n) {
      active += swapForY ? -1 : 1;
      if (active < p.minBinId || active > p.maxBinId) break;
    }
  }
  return { out, used: amountIn - left, needs: null, fee };
}

/* ─────────────────────────────── Meteora DAMM v2 ─────────────────────────────── */

export const DAMM_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
const DAMM_FEE_DENOMINATOR = 1_000_000_000n;
/** The most a DAMM v2 total fee can be, 50% (constants.rs MAX_FEE_NUMERATOR). */
const DAMM_MAX_FEE_NUMERATOR = 500_000_000n;

/**
 * The figures a DAMM v2 quote needs, from its Pool account (1112 bytes, read 2026-11-07: the
 * layout accounts for every byte). One position range [sqrt_min, sqrt_max] on Uniswap v3's
 * maths in Q64.64, with `liquidity` carrying 64 more bits than a Uniswap L. The base fee may
 * follow a schedule from the pool's activation (linear or exponential); a dynamic fee, when
 * initialized, follows the price's volatility as DLMM's does.
 */
export function dammState(data) {
  if (!Buffer.isBuffer(data) || data.length !== 1112) return null;
  return {
    cliffFeeNumerator: u64(data, 8), baseFeeMode: data[16], numberOfPeriod: u16(data, 22), periodFrequency: u64(data, 24), reductionFactor: u64(data, 32),
    dynamic: data[56] !== 0
      ? { maxVolatilityAccumulator: u32(data, 64), variableFeeControl: u32(data, 68), binStep: u16(data, 72), filterPeriod: u16(data, 74), decayPeriod: u16(data, 76), reductionFactor: u16(data, 78), lastUpdateTimestamp: u64(data, 80), binStepU128: u128(data, 88), sqrtPriceReference: u128(data, 104), volatilityAccumulator: u128(data, 120), volatilityReference: u128(data, 136) }
      : null,
    liquidity: u128(data, 360), sqrtMinPrice: u128(data, 424), sqrtMaxPrice: u128(data, 440), sqrtPrice: u128(data, 456),
    activationPoint: u64(data, 472), activationType: data[480], status: data[481], collectFeeMode: data[484], version: data[486],
  };
}

/** The point a DAMM v2 pool's schedule runs on: the slot or the unix time, by its activation type. */
export const dammPoint = (p, { now, slot }) => (p.activationType === 0 ? BigInt(slot ?? 0) : BigInt(Math.floor(now)));

/**
 * `get_current_base_fee_numerator`: the cliff fee, lowered each period since activation,
 * linearly (mode 0) or by a factor (mode 1, the program's own pow). Null for the rate-limiter
 * mode (2), whose fee depends on the amount and is not read here.
 */
export function dammBaseFee(p, point) {
  if (p.baseFeeMode > 1) return null;
  if (p.periodFrequency === 0n || p.numberOfPeriod === 0) return p.cliffFeeNumerator;
  const elapsed = point > p.activationPoint ? point - p.activationPoint : 0n;
  const periods = elapsed / p.periodFrequency;
  const period = periods < BigInt(p.numberOfPeriod) ? periods : BigInt(p.numberOfPeriod);
  if (p.baseFeeMode === 0) {
    const cut = period * p.reductionFactor;
    return cut < p.cliffFeeNumerator ? p.cliffFeeNumerator - cut : 0n;
  }
  const factor = dlmmPow(ONE - (p.reductionFactor << 64n) / BPS, Number(period));
  return factor === null ? null : (p.cliffFeeNumerator * factor) >> 64n;
}

/** The dynamic fee at this price and time, as the program sets it before a swap (update_pre_swap); 0 without one. */
export function dammVariableFee(p, now) {
  const d = p.dynamic;
  if (!d || !(d.variableFeeControl > 0)) return 0n;
  let vRef = d.volatilityReference;
  let sqrtRef = d.sqrtPriceReference;
  const elapsed = BigInt(Math.floor(now)) - d.lastUpdateTimestamp;
  if (elapsed >= BigInt(d.filterPeriod)) {
    sqrtRef = p.sqrtPrice;
    vRef = elapsed < BigInt(d.decayPeriod) ? (d.volatilityAccumulator * BigInt(d.reductionFactor)) / BPS : 0n;
  }
  const [upper, lower] = p.sqrtPrice > sqrtRef ? [p.sqrtPrice, sqrtRef] : [sqrtRef, p.sqrtPrice];
  const ratio = lower > 0n ? (upper << 64n) / lower : ONE;
  const deltaBin = d.binStepU128 > 0n ? ((ratio - ONE) / d.binStepU128) * 2n : 0n;
  const acc = vRef + deltaBin * BPS;
  const max = BigInt(d.maxVolatilityAccumulator);
  const square = ((acc < max ? acc : max) * BigInt(d.binStep)) ** 2n;
  return (BigInt(d.variableFeeControl) * square + 99_999_999_999n) / 100_000_000_000n;
}

/** The whole fee a swap pays now, in billionths; null when it cannot be read (the rate-limiter mode). */
export function dammFee(p, when) {
  const base = dammBaseFee(p, dammPoint(p, when));
  if (base === null) return null;
  const total = base + dammVariableFee(p, when.now);
  return total < DAMM_MAX_FEE_NUMERATOR ? total : DAMM_MAX_FEE_NUMERATOR;
}

/**
 * What `amountIn` pays out of a DAMM v2 pool (a to b: token A in), as swap.rs's get_swap_result
 * does: the fee on the coin out (collect mode 0: both tokens) or on token B (mode 1), then one
 * Uniswap v3 step within the pool's range. A trade the range cannot hold is refused, as the
 * program refuses it (PriceRangeViolation).
 */
export function dammQuote(p, amountIn, aToB, when) {
  if (p.status !== 0) return { out: 0n, used: 0n, needs: null, refused: 'PoolDisabled' };
  if (dammPoint(p, when) < p.activationPoint) return { out: 0n, used: 0n, needs: null, refused: 'PoolNotActive' };
  const fee = dammFee(p, when);
  if (fee === null) return { out: 0n, used: 0n, needs: null, refused: 'RateLimiterFeeNotRead' };
  if (p.liquidity === 0n) return { out: 0n, used: 0n, needs: null, refused: 'ZeroLiquidity' };
  const feesOnInput = p.collectFeeMode === 1 && !aToB;
  const feeOf = (amount) => ceilDiv(amount * fee, DAMM_FEE_DENOMINATOR);
  const actualIn = feesOnInput ? amountIn - feeOf(amountIn) : amountIn;
  const L = p.liquidity;
  let out;
  if (aToB) {
    const next = ceilDiv(L * p.sqrtPrice, L + actualIn * p.sqrtPrice);
    if (next < p.sqrtMinPrice) return { out: 0n, used: 0n, needs: null, refused: 'PriceRangeViolation', fee };
    out = (L * (p.sqrtPrice - next)) >> 128n;
  } else {
    const next = p.sqrtPrice + (actualIn << 128n) / L;
    if (next > p.sqrtMaxPrice) return { out: 0n, used: 0n, needs: null, refused: 'PriceRangeViolation', fee };
    out = (L * (next - p.sqrtPrice)) / (p.sqrtPrice * next);
  }
  return { out: feesOnInput ? out : out - feeOf(out), used: amountIn, needs: null, fee };
}

/** What the loaded bin arrays hold on each side: a bin pool's depth, in raw units. */
export function dlmmDepth(arrays) {
  let x = 0n;
  let y = 0n;
  for (const a of arrays) for (const b of a.bins) {
    x += b.x;
    y += b.y;
  }
  return { a: Number(x), b: Number(y) };
}
