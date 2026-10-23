/**
 * A BigInt port of the range-pool program's price and liquidity maths, ported by hand,
 * line for line, from the Apache-2.0 program source. Raydium's SDK is GPL-3.0 and is
 * never read for this file.
 *
 *   solana/tegridy-clmm/programs/amm/src/libraries/tick_math.rs
 *   solana/tegridy-clmm/programs/amm/src/libraries/sqrt_price_math.rs
 *   solana/tegridy-clmm/programs/amm/src/libraries/liquidity_math.rs
 *   solana/tegridy-clmm/programs/amm/src/libraries/full_math.rs
 *   solana/tegridy-clmm/programs/amm/src/libraries/swap_math.rs     (compute_swap)
 *   solana/tegridy-clmm/programs/amm/src/states/tick_array.rs       (fee growth inside)
 *
 * ROUNDING AND OVERFLOW ARE THE WHOLE JOB. The program builds with `overflow-checks = true`
 * and its U128/U256 types panic on overflow, and a panic is a failed transaction. BigInt
 * has no ceiling, so every step that has one in Rust checks it here and throws a
 * `ClmmMathError` named after the program's error. A number the program cannot produce is
 * never returned. Callers that show numbers catch it and say the amount cannot be worked out.
 *
 * This module imports nothing, so it is tested against the program's own vectors with no
 * Solana runtime in the room.
 */

export const Q64 = 1n << 64n;
export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;
export const U256_MAX = (1n << 256n) - 1n;
const I128_MAX = (1n << 127n) - 1n;

/** tick_math.rs */
export const MIN_TICK = -443636;
export const MAX_TICK = 443636;
export const MIN_SQRT_PRICE_X64 = 4295048016n;
export const MAX_SQRT_PRICE_X64 = 79226673521066979257578248091n;

/** config.rs `FEE_RATE_DENOMINATOR_VALUE`: rates are per million. */
export const FEE_RATE_DENOMINATOR = 1_000_000;

/** A step the program would refuse or panic on, named after its error. */
export class ClmmMathError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`range-pool maths: ${code}`);
    this.name = 'ClmmMathError';
    this.code = code;
  }
}
const fail = (code: string): never => {
  throw new ClmmMathError(code);
};

/** A uint add/mul/sub that panics past its width, as the program's U128/U256 do. */
function fits(v: bigint, max: bigint, code = 'ArithmeticOverflow'): bigint {
  if (v < 0n || v > max) fail(code);
  return v;
}

/* ─────────────────────────────── full_math ──────────────────────────────── */

/**
 * `mul_div_floor` at a width: exactly floor(a*b/d), or null when d is zero or the result
 * does not fit (the program's `None`, which callers turn into `CalculateOverflow`).
 */
export function mulDivFloor(a: bigint, b: bigint, d: bigint, max: bigint): bigint | null {
  if (d === 0n) return null;
  const r = (a * b) / d;
  return r > max ? null : r;
}

/** `mul_div_ceil` at a width: exactly ceil(a*b/d), or null. */
export function mulDivCeil(a: bigint, b: bigint, d: bigint, max: bigint): bigint | null {
  if (d === 0n) return null;
  const r = (a * b + d - 1n) / d;
  return r > max ? null : r;
}

const orOverflow = (v: bigint | null): bigint => (v === null ? fail('CalculateOverflow') : v);

/** `UnsafeMathTrait::div_rounding_up`. */
function divRoundingUp(x: bigint, y: bigint): bigint {
  if (y === 0n) fail('DivideByZero');
  return x / y + (x % y > 0n ? 1n : 0n);
}

/* ─────────────────────────────── tick_math ──────────────────────────────── */

const SQRT_FACTORS: readonly bigint[] = [
  0xfff97272373d4000n, 0xfff2e50f5f657000n, 0xffe5caca7e10f000n, 0xffcb9843d60f7000n,
  0xff973b41fa98e800n, 0xff2ea16466c9b000n, 0xfe5dee046a9a3800n, 0xfcbe86c7900bb000n,
  0xf987a7253ac65800n, 0xf3392b0822bb6000n, 0xe7159475a2caf000n, 0xd097f3bdfd2f2000n,
  0xa9f746462d9f8000n, 0x70d869a156f31c00n, 0x31be135f97ed3200n, 0x9aa508b5b85a500n,
  0x5d6af8dedc582cn, 0x2216e584f5fan,
];

/** `get_sqrt_price_at_tick`: 1.0001^(tick/2) as Q64.64. Throws past MIN_TICK/MAX_TICK. */
export function getSqrtPriceAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) fail('TickUpperOverflow');
  const absTick = Math.abs(tick);
  let ratio = absTick & 0x1 ? 0xfffcb933bd6fb800n : Q64;
  for (let i = 0; i < SQRT_FACTORS.length; i++) {
    if (absTick & (0x2 << i)) ratio = (ratio * SQRT_FACTORS[i]!) >> 64n;
  }
  if (tick > 0) ratio = U128_MAX / ratio;
  return ratio;
}

/** `get_tick_at_sqrt_price`: the greatest tick whose price is at or below this one. */
export function getTickAtSqrtPrice(sqrtPriceX64: bigint): number {
  if (sqrtPriceX64 < MIN_SQRT_PRICE_X64 || sqrtPriceX64 >= MAX_SQRT_PRICE_X64) fail('SqrtPriceX64');
  const msb = BigInt(sqrtPriceX64.toString(2).length - 1);
  const log2pIntegerX32 = (msb - 64n) << 32n;
  let bit = 0x8000_0000_0000_0000n;
  let precision = 0;
  let log2pFractionX64 = 0n;
  let r = msb >= 64n ? sqrtPriceX64 >> (msb - 63n) : sqrtPriceX64 << (63n - msb);
  while (bit > 0n && precision < 16) {
    r *= r;
    const isRMoreThanTwo = r >> 127n;
    r >>= 63n + isRMoreThanTwo;
    log2pFractionX64 += bit * isRMoreThanTwo;
    bit >>= 1n;
    precision += 1;
  }
  const log2pX32 = log2pIntegerX32 + (log2pFractionX64 >> 32n);
  const logSqrt10001X64 = log2pX32 * 59543866431248n;
  const tickLow = Number(BigInt.asIntN(32, (logSqrt10001X64 - 184467440737095516n) >> 64n));
  const tickHigh = Number(BigInt.asIntN(32, (logSqrt10001X64 + 15793534762490258745n) >> 64n));
  if (tickLow === tickHigh) return tickLow;
  return getSqrtPriceAtTick(tickHigh) <= sqrtPriceX64 ? tickHigh : tickLow;
}

/** `get_price_from_sqrt_price`: price_x64 = sqrt^2 / Q64, as a U128. */
export function getPriceFromSqrtPrice(sqrtPriceX64: bigint, roundUp: boolean): bigint {
  let prod = sqrtPriceX64 * sqrtPriceX64;
  if (roundUp) prod += Q64 - 1n;
  return fits(prod >> 64n, U128_MAX, 'CalculateOverflow');
}

/** `get_price_at_tick`. */
export function getPriceAtTick(tick: number, roundUp: boolean): bigint {
  return getPriceFromSqrtPrice(getSqrtPriceAtTick(tick), roundUp);
}

/* ──────────────────────────── sqrt_price_math ───────────────────────────── */

/** `get_next_sqrt_price_from_amount_0_rounding_up`. */
export function getNextSqrtPriceFromAmount0RoundingUp(sqrtPriceX64: bigint, liquidity: bigint, amount: bigint, add: boolean): bigint {
  if (amount === 0n) return sqrtPriceX64;
  const numerator1 = liquidity << 64n;
  const product = amount * sqrtPriceX64; // < 2^192: U256 `checked_mul` cannot fail
  if (add) {
    const denominator = fits(numerator1 + product, U256_MAX);
    if (denominator >= numerator1) {
      return fits(orOverflow(mulDivCeil(numerator1, sqrtPriceX64, denominator, U256_MAX)), U128_MAX);
    }
    return fits(divRoundingUp(numerator1, fits(numerator1 / sqrtPriceX64 + amount, U256_MAX, 'CalculateOverflow')), U128_MAX);
  }
  const denominator = numerator1 - product;
  if (denominator < 0n) fail('CalculateOverflow');
  return fits(orOverflow(mulDivCeil(numerator1, sqrtPriceX64, denominator, U256_MAX)), U128_MAX);
}

/** `get_next_sqrt_price_from_amount_1_rounding_down`. */
export function getNextSqrtPriceFromAmount1RoundingDown(sqrtPriceX64: bigint, liquidity: bigint, amount: bigint, add: boolean): bigint {
  if (amount === 0n) return sqrtPriceX64;
  if (liquidity === 0n) fail('DivideByZero');
  if (add) {
    const quotient = (amount << 64n) / liquidity;
    return fits(sqrtPriceX64 + quotient, U128_MAX, 'CalculateOverflow');
  }
  const quotient = divRoundingUp(amount << 64n, liquidity);
  const next = sqrtPriceX64 - quotient;
  if (next < 0n) fail('CalculateOverflow');
  return next;
}

function requireSwappable(sqrtPriceX64: bigint, liquidity: bigint) {
  if (sqrtPriceX64 < MIN_SQRT_PRICE_X64 || sqrtPriceX64 >= MAX_SQRT_PRICE_X64) fail('SqrtPriceX64');
  if (liquidity <= 0n) fail('ZeroLiquidity');
}

/** `get_next_sqrt_price_from_input`. */
export function getNextSqrtPriceFromInput(sqrtPriceX64: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  requireSwappable(sqrtPriceX64, liquidity);
  return zeroForOne
    ? getNextSqrtPriceFromAmount0RoundingUp(sqrtPriceX64, liquidity, amountIn, true)
    : getNextSqrtPriceFromAmount1RoundingDown(sqrtPriceX64, liquidity, amountIn, true);
}

/** `get_next_sqrt_price_from_output`. */
export function getNextSqrtPriceFromOutput(sqrtPriceX64: bigint, liquidity: bigint, amountOut: bigint, zeroForOne: boolean): bigint {
  requireSwappable(sqrtPriceX64, liquidity);
  return zeroForOne
    ? getNextSqrtPriceFromAmount1RoundingDown(sqrtPriceX64, liquidity, amountOut, false)
    : getNextSqrtPriceFromAmount0RoundingUp(sqrtPriceX64, liquidity, amountOut, false);
}

/* ──────────────────────────── liquidity_math ────────────────────────────── */

/** `add_delta`: liquidity plus a signed change, refusing to cross zero. */
export function addDelta(x: bigint, y: bigint): bigint {
  if (y < 0n) {
    const z = x + y;
    if (z < 0n) fail('ArithmeticOverflow');
    if (!(x > z)) fail('LiquiditySubValueErr');
    return z;
  }
  return fits(x + y, U128_MAX);
}

const sorted = (a: bigint, b: bigint): [bigint, bigint] => (a > b ? [b, a] : [a, b]);

/** `get_liquidity_from_amount_0`: ΔL = Δx · √Pa·√Pb / (√Pb − √Pa). */
export function getLiquidityFromAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  if (amount0 === 0n) return 0n;
  const [a, b] = sorted(sqrtA, sqrtB);
  const intermediate = orOverflow(mulDivFloor(a, b, Q64, U128_MAX));
  return orOverflow(mulDivFloor(amount0, intermediate, b - a, U128_MAX));
}

/** `get_liquidity_from_amount_1`: ΔL = Δy / (√Pb − √Pa). */
export function getLiquidityFromAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  if (amount1 === 0n) return 0n;
  const [a, b] = sorted(sqrtA, sqrtB);
  return orOverflow(mulDivFloor(amount1, Q64, b - a, U128_MAX));
}

/** `get_liquidity_from_amounts`: the most liquidity both amounts pay for. */
export function getLiquidityFromAmounts(sqrtPrice: bigint, sqrtA: bigint, sqrtB: bigint, amount0: bigint, amount1: bigint): bigint {
  const [a, b] = sorted(sqrtA, sqrtB);
  if (sqrtPrice <= a) return getLiquidityFromAmount0(a, b, amount0);
  if (sqrtPrice < b) {
    const l0 = getLiquidityFromAmount0(sqrtPrice, b, amount0);
    const l1 = getLiquidityFromAmount1(a, sqrtPrice, amount1);
    return l0 < l1 ? l0 : l1;
  }
  return getLiquidityFromAmount1(a, b, amount1);
}

/** `get_liquidity_from_single_amount_0`: what the program computes for `base_flag = true`. */
export function getLiquidityFromSingleAmount0(sqrtPrice: bigint, sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  const [a, b] = sorted(sqrtA, sqrtB);
  if (sqrtPrice <= a) return getLiquidityFromAmount0(a, b, amount0);
  if (sqrtPrice < b) return getLiquidityFromAmount0(sqrtPrice, b, amount0);
  return 0n;
}

/** `get_liquidity_from_single_amount_1`: what the program computes for `base_flag = false`. */
export function getLiquidityFromSingleAmount1(sqrtPrice: bigint, sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  const [a, b] = sorted(sqrtA, sqrtB);
  if (sqrtPrice <= a) return 0n;
  if (sqrtPrice < b) return getLiquidityFromAmount1(a, sqrtPrice, amount1);
  return getLiquidityFromAmount1(a, b, amount1);
}

/** `get_delta_amount_0_unsigned`: Δx = L · (√Pb − √Pa) / (√Pa·√Pb). */
export function getDeltaAmount0Unsigned(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [a, b] = sorted(sqrtA, sqrtB);
  if (!(a > 0n)) fail('ZeroSqrtPrice');
  const numerator1 = liquidity << 64n;
  const denominator = a * b;
  const r = orOverflow(roundUp ? mulDivCeil(numerator1, b - a, denominator, U256_MAX) : mulDivFloor(numerator1, b - a, denominator, U256_MAX));
  if (r > U64_MAX) fail('MaxTokenOverflow');
  return r;
}

/** `get_delta_amount_1_unsigned`: Δy = L · (√Pb − √Pa). */
export function getDeltaAmount1Unsigned(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [a, b] = sorted(sqrtA, sqrtB);
  const r = orOverflow(roundUp ? mulDivCeil(liquidity, b - a, Q64, U256_MAX) : mulDivFloor(liquidity, b - a, Q64, U256_MAX));
  if (r > U64_MAX) fail('MaxTokenOverflow');
  return r;
}

/** `mul_pow2_div_ceil` / `mul_pow2_div_floor`: exact, null past U256. */
const mulPow2DivCeil = (x: bigint, shift: bigint, d: bigint) => mulDivCeil(x, 1n << shift, d, U256_MAX);
const mulPow2DivFloor = (x: bigint, shift: bigint, d: bigint) => mulDivFloor(x, 1n << shift, d, U256_MAX);

/**
 * `get_delta_amounts_for_swap`: one step's (amount in, amount out), the in side rounded
 * up and the out side down.
 */
export function getDeltaAmountsForSwap(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, zeroForOne: boolean): [bigint, bigint] {
  const [a, b] = sorted(sqrtA, sqrtB);
  if (!(a > 0n)) fail('ZeroSqrtPrice');
  const amount1X64 = liquidity * (b - a); // < 2^256: U256 `checked_mul` cannot fail for u128 inputs
  const product = a * b;
  let amountIn: bigint;
  let amountOut: bigint;
  if (zeroForOne) {
    amountIn = orOverflow(mulPow2DivCeil(amount1X64, 64n, product));
    amountOut = amount1X64 >> 64n;
  } else {
    amountIn = fits(amount1X64 + U64_MAX, U256_MAX, 'CalculateOverflow') >> 64n;
    amountOut = orOverflow(mulPow2DivFloor(amount1X64, 64n, product));
  }
  if (amountIn > U64_MAX) fail('MaxTokenOverflow');
  if (amountOut > U64_MAX) fail('MaxTokenOverflow');
  return [amountIn, amountOut];
}

/** An i128 the program can negate: `checked_neg` refuses i128::MIN. */
function requireNegatableI128(v: bigint) {
  if (v > I128_MAX || v <= -I128_MAX - 1n) fail('CalculateOverflow');
}

/** `get_delta_amount_0_signed`: a deposit rounds up, a withdrawal down. */
export function getDeltaAmount0Signed(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  requireNegatableI128(liquidity);
  return liquidity < 0n ? getDeltaAmount0Unsigned(sqrtA, sqrtB, -liquidity, false) : getDeltaAmount0Unsigned(sqrtA, sqrtB, liquidity, true);
}

/** `get_delta_amount_1_signed`. */
export function getDeltaAmount1Signed(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  requireNegatableI128(liquidity);
  return liquidity < 0n ? getDeltaAmount1Unsigned(sqrtA, sqrtB, -liquidity, false) : getDeltaAmount1Unsigned(sqrtA, sqrtB, liquidity, true);
}

/**
 * `get_delta_amounts_signed`: the coins a liquidity change moves at this price. Positive
 * liquidity = what a deposit pays (rounded up); negative = what a withdrawal returns (down).
 */
export function getDeltaAmountsSigned(tickCurrent: number, sqrtPriceX64: bigint, tickLower: number, tickUpper: number, liquidityDelta: bigint): [bigint, bigint] {
  if (tickCurrent < tickLower) {
    return [getDeltaAmount0Signed(getSqrtPriceAtTick(tickLower), getSqrtPriceAtTick(tickUpper), liquidityDelta), 0n];
  }
  if (tickCurrent < tickUpper) {
    return [
      getDeltaAmount0Signed(sqrtPriceX64, getSqrtPriceAtTick(tickUpper), liquidityDelta),
      getDeltaAmount1Signed(getSqrtPriceAtTick(tickLower), sqrtPriceX64, liquidityDelta),
    ];
  }
  return [0n, getDeltaAmount1Signed(getSqrtPriceAtTick(tickLower), getSqrtPriceAtTick(tickUpper), liquidityDelta)];
}

/* ─────────────────────────── fees a position earned ─────────────────────── */

const wrap128 = (v: bigint) => BigInt.asUintN(128, v);

export interface TickFeeGrowth {
  tick: number;
  feeGrowthOutside0X64: bigint;
  feeGrowthOutside1X64: bigint;
}

/** tick_array.rs `get_fee_growth_inside`: fees per unit of liquidity earned inside a range. */
export function getFeeGrowthInside(
  lower: TickFeeGrowth,
  upper: TickFeeGrowth,
  tickCurrent: number,
  feeGrowthGlobal0X64: bigint,
  feeGrowthGlobal1X64: bigint,
): [bigint, bigint] {
  const below0 = tickCurrent >= lower.tick ? lower.feeGrowthOutside0X64 : wrap128(feeGrowthGlobal0X64 - lower.feeGrowthOutside0X64);
  const below1 = tickCurrent >= lower.tick ? lower.feeGrowthOutside1X64 : wrap128(feeGrowthGlobal1X64 - lower.feeGrowthOutside1X64);
  const above0 = tickCurrent < upper.tick ? upper.feeGrowthOutside0X64 : wrap128(feeGrowthGlobal0X64 - upper.feeGrowthOutside0X64);
  const above1 = tickCurrent < upper.tick ? upper.feeGrowthOutside1X64 : wrap128(feeGrowthGlobal1X64 - upper.feeGrowthOutside1X64);
  return [wrap128(feeGrowthGlobal0X64 - below0 - above0), wrap128(feeGrowthGlobal1X64 - below1 - above1)];
}

/**
 * increase_liquidity.rs `calculate_latest_token_fees`, with `to_underflow_u64`: a delta at
 * or past u64::MAX reads as 0, exactly as the program counts it.
 */
export function calculateLatestTokenFees(lastTotalFees: bigint, feeGrowthInsideLastX64: bigint, feeGrowthInsideLatestX64: bigint, liquidity: bigint): bigint {
  const delta = orOverflow(mulDivFloor(wrap128(feeGrowthInsideLatestX64 - feeGrowthInsideLastX64), liquidity, Q64, U128_MAX));
  const owed = delta < U64_MAX ? delta : 0n;
  return fits(lastTotalFees + owed, U64_MAX, 'CalculateOverflow');
}

/* ──────────────────────── human prices (the site's own) ─────────────────── */

/** Integer square root, floor. Newton from above, so it never starts below the root. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) fail('NegativeSqrt');
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/**
 * A price someone reads ("1 BAYLA = 0.0003 SOL") as Q64.64 sqrt of the RAW ratio token_1 per
 * token_0, rounded down. `num / den` is the price of one whole token 0 in whole token 1.
 */
export function sqrtPriceX64FromPrice(num: bigint, den: bigint, decimals0: number, decimals1: number): bigint {
  if (num <= 0n || den <= 0n) fail('NonPositivePrice');
  const scaleUp = 10n ** BigInt(decimals1);
  const scaleDown = 10n ** BigInt(decimals0);
  return isqrt(((num * scaleUp) << 128n) / (den * scaleDown));
}

/** The price of one whole token 0 in whole token 1, as an exact fraction. */
export function priceFromSqrtPriceX64(sqrtPriceX64: bigint, decimals0: number, decimals1: number): { num: bigint; den: bigint } {
  return {
    num: sqrtPriceX64 * sqrtPriceX64 * 10n ** BigInt(decimals0),
    den: (1n << 128n) * 10n ** BigInt(decimals1),
  };
}

/** The lowest and highest ticks a position may use at this spacing. */
export function usableTickBounds(tickSpacing: number): { min: number; max: number } {
  return { min: Math.ceil(MIN_TICK / tickSpacing) * tickSpacing, max: Math.floor(MAX_TICK / tickSpacing) * tickSpacing };
}

/** Round a tick to the nearest one a position may use, inside the usable bounds. */
export function nearestUsableTick(tick: number, tickSpacing: number): number {
  const { min, max } = usableTickBounds(tickSpacing);
  const t = Math.min(max, Math.max(min, Math.round(tick / tickSpacing) * tickSpacing));
  return t === 0 ? 0 : t; // never -0

}
