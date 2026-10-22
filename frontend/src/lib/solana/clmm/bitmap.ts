import { ClmmMathError, MAX_TICK, MIN_TICK } from './math';
import { TICK_ARRAY_SIZE, type BitmapExtensionView, type PoolStateView } from './program';

/**
 * Which bands of prices (tick arrays) a pool has, and how a swap finds the next one. A
 * by-hand port of the program's own search, so the quote and the account list a swap needs
 * walk the bands exactly as the program does:
 *
 *   solana/tegridy-clmm/programs/amm/src/libraries/tick_array_bit_map.rs
 *   solana/tegridy-clmm/programs/amm/src/states/tickarray_bitmap_extension.rs
 *   solana/tegridy-clmm/programs/amm/src/states/pool.rs          (the pool-level search)
 *   solana/tegridy-clmm/programs/amm/src/states/tick_array.rs    (start indexes)
 *
 * A pool's own 1024-bit map covers ±(spacing × 60 × 512) ticks, which is the whole price
 * range from spacing 15 up; past it, the pool's extension account holds 14 more maps a side.
 */

export const TICK_ARRAY_BITMAP_SIZE = 512;
const fail = (code: string): never => {
  throw new ClmmMathError(code);
};

/** Rust's `/` on i32: toward zero. */
const idiv = (a: number, b: number) => Math.trunc(a / b);

/** `TickArrayState::tick_count`: ticks in one band. */
export function tickCount(tickSpacing: number): number {
  return TICK_ARRAY_SIZE * tickSpacing;
}

/** `TickArrayState::get_array_start_index`: the band a tick sits in. */
export function getArrayStartIndex(tickIndex: number, tickSpacing: number): number {
  const ticksInArray = tickCount(tickSpacing);
  let start = idiv(tickIndex, ticksInArray);
  if (tickIndex < 0 && tickIndex % ticksInArray !== 0) start -= 1;
  return start * ticksInArray;
}

/** `TickArrayState::check_is_valid_start_index`. */
export function checkIsValidStartIndex(tickIndex: number, tickSpacing: number): boolean {
  if (tickIndex < MIN_TICK || tickIndex > MAX_TICK) {
    if (tickIndex > MAX_TICK) return false;
    return tickIndex === getArrayStartIndex(MIN_TICK, tickSpacing);
  }
  return tickIndex % tickCount(tickSpacing) === 0;
}

/** `max_tick_in_tickarray_bitmap`: the reach of one 512-bit map. */
export function maxTickInTickarrayBitmap(tickSpacing: number): number {
  return tickSpacing * TICK_ARRAY_SIZE * TICK_ARRAY_BITMAP_SIZE;
}

/** `PoolState::tick_array_start_index_range`: the band starts the pool's own map can hold. */
export function tickArrayStartIndexRange(tickSpacing: number): [number, number] {
  let maxTickBoundary = maxTickInTickarrayBitmap(tickSpacing);
  let minTickBoundary = -maxTickBoundary;
  if (maxTickBoundary > MAX_TICK) {
    maxTickBoundary = getArrayStartIndex(MAX_TICK, tickSpacing) + tickCount(tickSpacing);
  }
  if (minTickBoundary < MIN_TICK) minTickBoundary = getArrayStartIndex(MIN_TICK, tickSpacing);
  return [minTickBoundary, maxTickBoundary];
}

/** `PoolState::is_overflow_default_tickarray_bitmap`: true when the extension account is needed. */
export function isOverflowDefaultTickarrayBitmap(tickSpacing: number, tickIndexes: number[]): boolean {
  const [min, max] = tickArrayStartIndexRange(tickSpacing);
  return tickIndexes.some((t) => {
    const start = getArrayStartIndex(t, tickSpacing);
    return start >= max || start < min;
  });
}

/* ───────────────────────── big bitmaps as BigInt ────────────────────────── */

/** Little-endian u64 words as one integer, as uint's U512/U1024 hold them. */
export function wordsToBigInt(words: readonly bigint[]): bigint {
  let v = 0n;
  for (let i = words.length - 1; i >= 0; i--) v = (v << 64n) | BigInt.asUintN(64, words[i]!);
  return v;
}

const bitLength = (v: bigint) => (v === 0n ? 0 : v.toString(2).length);
const leadingZeros = (v: bigint, bits: number) => bits - bitLength(v);
function trailingZeros(v: bigint): number {
  let n = 0;
  while (((v >> BigInt(n)) & 1n) === 0n) n++;
  return n;
}
/** uint's `<<`: bits pushed past the top are lost. */
const shl = (v: bigint, by: number, bits: number) => BigInt.asUintN(bits, v << BigInt(by));

/* ─────────────────────────── the pool's own map ─────────────────────────── */

/** `check_current_tick_array_is_initialized`: is the band holding this tick in use? */
export function checkCurrentTickArrayIsInitialized(bitmap: bigint, tickCurrent: number, tickSpacing: number): [boolean, number] {
  if (tickCurrent < MIN_TICK || tickCurrent > MAX_TICK) fail('InvalidTickIndex');
  const multiplier = tickSpacing * TICK_ARRAY_SIZE;
  let compressed = idiv(tickCurrent, multiplier) + 512;
  if (tickCurrent < 0 && tickCurrent % multiplier !== 0) compressed -= 1;
  const bitPos = Math.abs(compressed);
  const initialized = ((bitmap >> BigInt(bitPos)) & 1n) !== 0n;
  return [initialized, (compressed - 512) * multiplier];
}

/** tick_array_bit_map.rs `next_initialized_tick_array_start_index`: the next band in use, in the pool's own map. */
export function nextInitializedTickArrayStartIndexInPool(bitmap: bigint, lastTickArrayStartIndex: number, tickSpacing: number, zeroForOne: boolean): [boolean, number] {
  if (!checkIsValidStartIndex(lastTickArrayStartIndex, tickSpacing)) fail('InvalidTickArrayBoundary');
  const tickBoundary = maxTickInTickarrayBitmap(tickSpacing);
  const next = zeroForOne ? lastTickArrayStartIndex - tickCount(tickSpacing) : lastTickArrayStartIndex + tickCount(tickSpacing);
  if (next < -tickBoundary || next >= tickBoundary) return [false, lastTickArrayStartIndex];
  const multiplier = tickSpacing * TICK_ARRAY_SIZE;
  let compressed = idiv(next, multiplier) + 512;
  if (next < 0 && next % multiplier !== 0) compressed -= 1;
  const bitPos = Math.abs(compressed);
  if (zeroForOne) {
    const offset = shl(bitmap, 1024 - bitPos - 1, 1024);
    if (offset === 0n) return [false, -tickBoundary];
    return [true, (bitPos - leadingZeros(offset, 1024) - 512) * multiplier];
  }
  const offset = bitmap >> BigInt(bitPos);
  if (offset === 0n) return [false, tickBoundary - tickCount(tickSpacing)];
  return [true, (bitPos + trailingZeros(offset) - 512) * multiplier];
}

/* ──────────────────────────── the extension ─────────────────────────────── */

/** `TickArrayBitmapExtension::check_extension_boundary`. */
export function checkExtensionBoundary(tickIndex: number, tickSpacing: number): void {
  const positive = maxTickInTickarrayBitmap(tickSpacing);
  const negative = -positive;
  if (!(MAX_TICK > positive)) fail('RequireGtViolated');
  if (!(negative > MIN_TICK)) fail('RequireGtViolated');
  if (tickIndex >= negative && tickIndex < positive) fail('InvalidTickArrayBoundary');
}

/** `TickArrayBitmapExtension::get_bitmap_offset`: which of the 14 maps a far band is in. */
export function getBitmapOffset(tickIndex: number, tickSpacing: number): number {
  if (!checkIsValidStartIndex(tickIndex, tickSpacing)) fail('InvalidTickIndex');
  checkExtensionBoundary(tickIndex, tickSpacing);
  const ticksInOneBitmap = maxTickInTickarrayBitmap(tickSpacing);
  let offset = idiv(Math.abs(tickIndex), ticksInOneBitmap) - 1;
  if (tickIndex < 0 && Math.abs(tickIndex) % ticksInOneBitmap === 0) offset -= 1;
  return offset;
}

function getBitmap(ext: BitmapExtensionView, tickIndex: number, tickSpacing: number): bigint {
  const offset = getBitmapOffset(tickIndex, tickSpacing);
  const maps = tickIndex < 0 ? ext.negativeTickArrayBitmap : ext.positiveTickArrayBitmap;
  const words = maps[offset];
  if (!words) fail('IndexOutOfBounds');
  return wordsToBigInt(words!);
}

/** `get_bitmap_tick_boundary`. */
export function getBitmapTickBoundary(tickArrayStartIndex: number, tickSpacing: number): [number, number] {
  const ticksInOneBitmap = maxTickInTickarrayBitmap(tickSpacing);
  let m = idiv(Math.abs(tickArrayStartIndex), ticksInOneBitmap);
  if (tickArrayStartIndex < 0 && Math.abs(tickArrayStartIndex) % ticksInOneBitmap !== 0) m += 1;
  const minValue = ticksInOneBitmap * m;
  return tickArrayStartIndex < 0 ? [-minValue, -minValue + ticksInOneBitmap] : [minValue, minValue + ticksInOneBitmap];
}

/** `TickArrayBitmapExtension::tick_array_offset_in_bitmap`. */
export function tickArrayOffsetInBitmap(tickArrayStartIndex: number, tickSpacing: number): number {
  const m = Math.abs(tickArrayStartIndex) % maxTickInTickarrayBitmap(tickSpacing);
  let offset = idiv(m, tickCount(tickSpacing));
  if (tickArrayStartIndex < 0 && m !== 0) offset = TICK_ARRAY_BITMAP_SIZE - offset;
  return offset;
}

/** `TickArrayBitmapExtension::check_tick_array_is_initialized`. */
export function extensionTickArrayIsInitialized(ext: BitmapExtensionView, tickArrayStartIndex: number, tickSpacing: number): [boolean, number] {
  const bitmap = getBitmap(ext, tickArrayStartIndex, tickSpacing);
  const offset = tickArrayOffsetInBitmap(tickArrayStartIndex, tickSpacing);
  return [((bitmap >> BigInt(offset)) & 1n) !== 0n, tickArrayStartIndex];
}

/** `next_initialized_tick_array_in_bitmap`. */
export function nextInitializedTickArrayInBitmap(bitmap: bigint, nextTickArrayStartIndex: number, tickSpacing: number, zeroForOne: boolean): [boolean, number] {
  const [minBoundary, maxBoundary] = getBitmapTickBoundary(nextTickArrayStartIndex, tickSpacing);
  const offset = tickArrayOffsetInBitmap(nextTickArrayStartIndex, tickSpacing);
  if (zeroForOne) {
    const shifted = shl(bitmap, TICK_ARRAY_BITMAP_SIZE - 1 - offset, 512);
    if (shifted === 0n) return [false, minBoundary];
    return [true, nextTickArrayStartIndex - leadingZeros(shifted, 512) * tickCount(tickSpacing)];
  }
  const shifted = bitmap >> BigInt(offset);
  if (shifted === 0n) return [false, maxBoundary - tickCount(tickSpacing)];
  return [true, nextTickArrayStartIndex + trailingZeros(shifted) * tickCount(tickSpacing)];
}

/** `TickArrayBitmapExtension::next_initialized_tick_array_from_one_bitmap`. */
export function nextInitializedTickArrayFromOneBitmap(ext: BitmapExtensionView, lastTickArrayStartIndex: number, tickSpacing: number, zeroForOne: boolean): [boolean, number] {
  const multiplier = tickCount(tickSpacing);
  const next = zeroForOne ? lastTickArrayStartIndex - multiplier : lastTickArrayStartIndex + multiplier;
  const minStart = getArrayStartIndex(MIN_TICK, tickSpacing);
  const maxStart = getArrayStartIndex(MAX_TICK, tickSpacing);
  if (next < minStart || next > maxStart) return [false, next];
  return nextInitializedTickArrayInBitmap(getBitmap(ext, next, tickSpacing), next, tickSpacing, zeroForOne);
}

/* ─────────────────────────── the pool-level search ──────────────────────── */

type PoolBits = Pick<PoolStateView, 'tickArrayBitmap' | 'tickSpacing' | 'tickCurrent'>;

/**
 * pool.rs `next_initialized_tick_array_start_index`: the next band in use, through the
 * pool's map and then its extension. null = no more liquidity that way.
 */
export function nextInitializedTickArrayStartIndex(pool: PoolBits, ext: BitmapExtensionView | null, lastTickArrayStartIndex: number, zeroForOne: boolean): number | null {
  const bitmap = wordsToBigInt(pool.tickArrayBitmap);
  let last = getArrayStartIndex(lastTickArrayStartIndex, pool.tickSpacing);
  for (;;) {
    const [found, start] = nextInitializedTickArrayStartIndexInPool(bitmap, last, pool.tickSpacing, zeroForOne);
    if (found) return start;
    // From spacing 15 up the pool's own map spans every tick, so a miss is the end.
    if (pool.tickSpacing >= 15) return null;
    last = start;
    if (!ext) fail('MissingTickArrayBitmapExtensionAccount');
    const [foundExt, startExt] = nextInitializedTickArrayFromOneBitmap(ext!, last, pool.tickSpacing, zeroForOne);
    if (foundExt) return startExt;
    last = startExt;
    if (last < MIN_TICK || last > MAX_TICK) return null;
  }
}

/**
 * pool.rs `get_first_initialized_tick_array`: the band a swap starts in, and whether it is
 * the band holding the current price. Throws `InsufficientLiquidityForDirection` when
 * there is none, as the program does.
 */
export function firstInitializedTickArray(pool: PoolBits, ext: BitmapExtensionView | null, zeroForOne: boolean): [boolean, number] {
  const currentStart = getArrayStartIndex(pool.tickCurrent, pool.tickSpacing);
  let found: [boolean, number];
  if (isOverflowDefaultTickarrayBitmap(pool.tickSpacing, [pool.tickCurrent])) {
    if (!ext) fail('MissingTickArrayBitmapExtensionAccount');
    found = extensionTickArrayIsInitialized(ext!, currentStart, pool.tickSpacing);
  } else {
    found = checkCurrentTickArrayIsInitialized(wordsToBigInt(pool.tickArrayBitmap), pool.tickCurrent, pool.tickSpacing);
  }
  if (found[0]) return [true, found[1]];
  const next = nextInitializedTickArrayStartIndex(pool, ext, currentStart, zeroForOne);
  if (next === null) fail('InsufficientLiquidityForDirection');
  return [false, next!];
}

/**
 * Every band a pool marks as in use, lowest first: the pool's own map, then the extension
 * when given. What a reader fetches to see a pool's whole liquidity.
 */
export function initializedTickArrayStarts(pool: Pick<PoolStateView, 'tickArrayBitmap' | 'tickSpacing'>, ext: BitmapExtensionView | null): number[] {
  const spacing = pool.tickSpacing;
  const multiplier = spacing * TICK_ARRAY_SIZE;
  const out = new Set<number>();
  const bitmap = wordsToBigInt(pool.tickArrayBitmap);
  for (let bit = 0; bit < 1024; bit++) {
    if (((bitmap >> BigInt(bit)) & 1n) !== 0n) out.add((bit - 512) * multiplier);
  }
  if (ext) {
    // Walked through the program's own forward mapping, so no inverse is guessed at.
    const [min, max] = tickArrayStartIndexRange(spacing);
    const last = getArrayStartIndex(MAX_TICK, spacing);
    for (let start = getArrayStartIndex(MIN_TICK, spacing); start <= last; start += multiplier) {
      if (start >= min && start < max) continue;
      if (extensionTickArrayIsInitialized(ext, start, spacing)[0]) out.add(start);
    }
  }
  return [...out].sort((a, b) => a - b);
}
