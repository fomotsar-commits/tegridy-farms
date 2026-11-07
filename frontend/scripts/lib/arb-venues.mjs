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
const TAG = { tickArray: tagOf('TickArray'), dynamicTickArray: tagOf('DynamicTickArray'), binArray: tagOf('BinArray') };

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
 */
export function orcaQuote(w, amountIn, aToB, array) {
  const limit = aToB ? MIN_SQRT_PRICE_X64 : MAX_SQRT_PRICE_X64;
  let remaining = amountIn;
  let out = 0n;
  let sqrtP = w.sqrtPriceX64;
  let tick = w.tickCurrent;
  let L = w.liquidity;
  for (let steps = 0; remaining > 0n && sqrtP !== limit; steps++) {
    if (steps > MAX_STEPS) break;
    const next = orcaNextTick(tick, aToB, w.tickSpacing, array);
    if (next.needs !== undefined) return { out, used: amountIn - remaining, needs: next.needs };
    const nextSqrt = getSqrtPriceAtTick(Math.min(MAX_TICK, Math.max(MIN_TICK, next.tick)));
    const target = aToB ? (nextSqrt < limit ? limit : nextSqrt) : nextSqrt > limit ? limit : nextSqrt;
    let step;
    try {
      step = computeSwap(sqrtP, target, L, remaining, w.feeRate, true, aToB, true);
    } catch (e) {
      if (e instanceof ClmmMathError) break;
      throw e;
    }
    remaining -= step.amountIn + step.feeAmount;
    out += step.amountOut;
    sqrtP = step.sqrtPriceNextX64;
    if (sqrtP === nextSqrt) {
      if (next.initialized) {
        try {
          L = addDelta(L, aToB ? -next.liquidityNet : next.liquidityNet);
        } catch (e) {
          if (e instanceof ClmmMathError) break;
          throw e;
        }
      }
      tick = aToB ? next.tick - 1 : next.tick;
    } else {
      tick = getTickAtSqrtPrice(sqrtP);
    }
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
