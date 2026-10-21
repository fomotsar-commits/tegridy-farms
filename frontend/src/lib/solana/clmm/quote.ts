import {
  checkIsValidStartIndex,
  firstInitializedTickArray,
  getArrayStartIndex,
  getBitmapOffset,
  isOverflowDefaultTickarrayBitmap,
  nextInitializedTickArrayStartIndex,
  tickArrayOffsetInBitmap,
  tickCount,
  TICK_ARRAY_BITMAP_SIZE,
} from './bitmap';
import {
  ClmmMathError,
  FEE_RATE_DENOMINATOR,
  MAX_SQRT_PRICE_X64,
  MAX_TICK,
  MIN_SQRT_PRICE_X64,
  MIN_TICK,
  Q64,
  U128_MAX,
  U64_MAX,
  addDelta,
  getDeltaAmountsForSwap,
  getNextSqrtPriceFromInput,
  getNextSqrtPriceFromOutput,
  getPriceFromSqrtPrice,
  getSqrtPriceAtTick,
  getTickAtSqrtPrice,
  mulDivCeil,
  mulDivFloor,
} from './math';
import {
  POOL_STATUS_BIT,
  TICK_ARRAY_SIZE,
  isFeeOnInput,
  isFeeOnToken0,
  poolAllows,
  tickHasLimitOrders,
  tickHasLiquidity,
  tickIsInitialized,
  type AmmConfigView,
  type BitmapExtensionView,
  type DynamicFeeInfoView,
  type PoolStateView,
  type TickArrayView,
  type TickStateView,
} from './program';

/**
 * A swap quote that walks the price bands exactly as the range program's swap does. A
 * by-hand port, line for line, of:
 *
 *   solana/tegridy-clmm/programs/amm/src/instructions/swap.rs     (SwapState, swap_internal)
 *   solana/tegridy-clmm/programs/amm/src/instructions/swap_v2.rs  (the checks around it)
 *   solana/tegridy-clmm/programs/amm/src/libraries/swap_math.rs   (compute_swap)
 *   solana/tegridy-clmm/programs/amm/src/states/tick_array.rs     (limit-order matching)
 *   solana/tegridy-clmm/programs/amm/src/states/pool_fee.rs       (the dynamic fee)
 *
 * It works on copies: a band or price it would change in the program changes only inside
 * this run. It needs every band the walk reaches; one it was not given ends the quote with
 * `needs-band` and its start, so the caller can read it and ask again. Anything the program
 * would refuse ends it with `refused` and the program's error name. A quote is never a
 * guess: no default stands in for a value it could not read.
 *
 * It assumes neither coin charges a Token-2022 transfer fee. The site blocks those coins
 * from pools (lp/tokenSafety.ts); a caller quoting another coin must refuse it first.
 */

export interface SwapQuoteArgs {
  pool: Pick<PoolStateView, 'tickCurrent' | 'sqrtPriceX64' | 'liquidity' | 'tickSpacing' | 'feeOn' | 'status' | 'tickArrayBitmap' | 'dynamicFeeInfo' | 'openTime'>;
  config: Pick<AmmConfigView, 'tradeFeeRate' | 'protocolFeeRate' | 'fundFeeRate'>;
  /** The decoded band that starts at this tick, or undefined when it was not read. */
  band: (startTickIndex: number) => TickArrayView | undefined;
  extension: BitmapExtensionView | null;
  zeroForOne: boolean;
  isBaseInput: boolean;
  /** The amount in (exact in) or out (exact out), in raw units. */
  amount: bigint;
  /** 0 = no limit: the program then refuses anything but a full fill. */
  sqrtPriceLimitX64: bigint;
  /** Unix seconds the swap is expected to run at. The dynamic fee and open time read it. */
  blockTimestamp: number;
}

/** A program's own ceiling on a fee rate: ours, or Raydium's for replays (`quoteSwapAsRaydium`). */
type FeeCeiling = typeof MAX_FEE_RATE_NUMERATOR | typeof UPSTREAM_MAX_FEE_RATE_NUMERATOR;

export interface SwapInternalResult {
  amount0: bigint;
  amount1: bigint;
  tradeFee0: bigint;
  tradeFee1: bigint;
  lpFee: bigint;
  protocolFee: bigint;
  fundFee: bigint;
  sqrtPriceX64: bigint;
  liquidity: bigint;
  tick: number;
  /** The bands the walk used, in walking order: what the instruction must pass. */
  bands: number[];
}

/** The most price bands one swap from this site walks: each is an account its transaction carries. */
export const MAX_SWAP_BANDS = 5;

export type SwapQuote =
  | ({
      kind: 'ok';
      amountIn: bigint;
      amountOut: bigint;
      /** The whole trade fee, in token 0 when `feeInToken0`, else in token 1. */
      tradeFee: bigint;
      feeInToken0: boolean;
      /** True when the amount asked for was used in full. */
      filled: boolean;
      /** Spacing under 15 can reach past the pool's own map: pass the far-band map then. */
      passExtension: boolean;
    } & SwapInternalResult)
  | { kind: 'needs-band'; startTickIndex: number }
  | { kind: 'refused'; code: string };

const fail = (code: string): never => {
  throw new ClmmMathError(code);
};

class NeedsBand extends Error {
  readonly start: number;
  constructor(start: number) {
    super(`band ${start} was not read`);
    this.start = start;
  }
}

const u64 = (v: bigint, code = 'CalculateOverflow') => (v < 0n || v > U64_MAX ? fail(code) : v);
const FEE_DENOM = BigInt(FEE_RATE_DENOMINATOR);

/** u64 `mul_div_floor` / `mul_div_ceil`: exact, or `CalculateOverflow` past u64. */
const mdf64 = (a: bigint, b: bigint, d: bigint) => mulDivFloor(a, b, d, U64_MAX) ?? fail('CalculateOverflow');
const mdc64 = (a: bigint, b: bigint, d: bigint) => mulDivCeil(a, b, d, U64_MAX) ?? fail('CalculateOverflow');

/* ─────────────────────────────── compute_swap ───────────────────────────── */

export interface SwapStep {
  sqrtPriceNextX64: bigint;
  amountIn: bigint;
  amountOut: bigint;
  feeAmount: bigint;
}

/** swap_math.rs `compute_swap`: one step toward a target price. */
export function computeSwap(
  sqrtPriceCurrentX64: bigint,
  sqrtPriceTargetX64: bigint,
  liquidity: bigint,
  amountRemaining: bigint,
  feeRate: number,
  isBaseInput: boolean,
  zeroForOne: boolean,
  feeOnInput: boolean,
): SwapStep {
  const rate = BigInt(feeRate);
  const result: SwapStep = { sqrtPriceNextX64: 0n, amountIn: 0n, amountOut: 0n, feeAmount: 0n };
  const amountForPriceCalc = isBaseInput
    ? feeOnInput ? mdf64(amountRemaining, FEE_DENOM - rate, FEE_DENOM) : amountRemaining
    : feeOnInput ? amountRemaining : mdc64(amountRemaining, FEE_DENOM, FEE_DENOM - rate);

  let reachable: [bigint, bigint] | null = null;
  try {
    const [inAtTarget, outAtTarget] = getDeltaAmountsForSwap(sqrtPriceTargetX64, sqrtPriceCurrentX64, liquidity, zeroForOne);
    if (amountForPriceCalc >= (isBaseInput ? inAtTarget : outAtTarget)) reachable = [inAtTarget, outAtTarget];
  } catch (e) {
    // The target cannot be reached at u64 precision: solve for the price below.
    if (!(e instanceof ClmmMathError && e.code === 'MaxTokenOverflow')) throw e;
  }

  if (reachable) {
    result.sqrtPriceNextX64 = sqrtPriceTargetX64;
    [result.amountIn, result.amountOut] = reachable;
  } else {
    const next = isBaseInput
      ? getNextSqrtPriceFromInput(sqrtPriceCurrentX64, liquidity, amountForPriceCalc, zeroForOne)
      : getNextSqrtPriceFromOutput(sqrtPriceCurrentX64, liquidity, amountForPriceCalc, zeroForOne);
    result.sqrtPriceNextX64 = next;
    [result.amountIn, result.amountOut] = getDeltaAmountsForSwap(next, sqrtPriceCurrentX64, liquidity, zeroForOne);
  }

  if (zeroForOne ? !(result.sqrtPriceNextX64 >= sqrtPriceTargetX64) : !(sqrtPriceTargetX64 >= result.sqrtPriceNextX64)) fail('RequireGteViolated');

  if (isBaseInput) {
    if (feeOnInput) {
      result.feeAmount = result.sqrtPriceNextX64 !== sqrtPriceTargetX64
        ? u64(amountRemaining - result.amountIn)
        : mdc64(result.amountIn, rate, FEE_DENOM - rate);
    } else {
      result.feeAmount = mdc64(result.amountOut, rate, FEE_DENOM);
      result.amountOut = u64(result.amountOut - result.feeAmount);
      // A partial step charges the whole input: the sub-unit dust goes to the pool.
      if (result.sqrtPriceNextX64 !== sqrtPriceTargetX64) result.amountIn = amountRemaining;
    }
  } else if (feeOnInput) {
    result.amountOut = result.amountOut < amountRemaining ? result.amountOut : amountRemaining;
    result.feeAmount = mdc64(result.amountIn, rate, FEE_DENOM - rate);
  } else {
    result.feeAmount = mdc64(result.amountOut, rate, FEE_DENOM);
    const net = u64(result.amountOut - result.feeAmount);
    if (net > amountRemaining) {
      result.feeAmount = u64(result.amountOut - amountRemaining);
      result.amountOut = amountRemaining;
    } else {
      result.amountOut = net;
    }
  }
  return result;
}

/* ──────────────────────────── limit-order matching ──────────────────────── */

type MutableTick = TickStateView;

/** `limit_order_unfilled_amount`. */
const unfilled = (t: MutableTick) => u64(t.ordersAmount + t.partFilledOrdersRemaining);

/** `get_limit_order_output_with_price`: what the resting orders pay for `amountIn`, rounded down. */
function limitOrderOutput(amountIn: bigint, token0PriceX64: bigint, zeroForOne: boolean): bigint {
  const r = zeroForOne ? mulDivFloor(amountIn, token0PriceX64, Q64, U128_MAX) : mulDivFloor(amountIn, Q64, token0PriceX64, U128_MAX);
  return r ?? fail('CalculateOverflow');
}

/** `get_limit_order_input_with_price`: what it takes to fill `amountOut` of resting orders, rounded up. */
function limitOrderInput(amountOut: bigint, token0PriceX64: bigint, zeroForOne: boolean): bigint {
  const r = zeroForOne ? mulDivCeil(amountOut, token0PriceX64, Q64, U128_MAX) : mulDivCeil(amountOut, Q64, token0PriceX64, U128_MAX);
  if (r === null) fail('CalculateOverflow');
  return u64(r!);
}

/** `match_limit_order_with_sqrt_price`: fill the orders resting at this price; mutates the tick. */
export function matchLimitOrder(
  t: MutableTick,
  swapAmount: bigint,
  zeroForOne: boolean,
  isBaseInput: boolean,
  feeRate: number,
  feeOnInput: boolean,
  sqrtPriceX64: bigint,
): { amountIn: bigint; amountOut: bigint; ammFeeAmount: bigint } {
  const result = { amountIn: 0n, amountOut: 0n, ammFeeAmount: 0n };
  const total = unfilled(t);
  if (swapAmount === 0n || total === 0n) return result;
  const rate = BigInt(feeRate);
  const price = getPriceFromSqrtPrice(sqrtPriceX64, !zeroForOne);

  if (isBaseInput) {
    if (feeOnInput) {
      result.ammFeeAmount = mdc64(swapAmount, rate, FEE_DENOM);
      result.amountIn = u64(swapAmount - result.ammFeeAmount, 'ArithmeticOverflow');
    } else {
      result.amountIn = swapAmount;
    }
    const matched = limitOrderOutput(result.amountIn, price, zeroForOne);
    if (matched > total) {
      result.amountOut = total;
      result.amountIn = limitOrderInput(total, price, !zeroForOne);
      if (feeOnInput) result.ammFeeAmount = mdc64(result.amountIn, rate, FEE_DENOM - rate);
    } else {
      result.amountOut = matched;
    }
  } else {
    const net = swapAmount < total ? swapAmount : total;
    if (feeOnInput) {
      result.amountOut = net;
    } else {
      const gross = mdc64(net, FEE_DENOM, FEE_DENOM - rate);
      result.amountOut = gross < total ? gross : total;
    }
    result.amountIn = limitOrderInput(result.amountOut, price, !zeroForOne);
    if (feeOnInput) result.ammFeeAmount = mdc64(result.amountIn, rate, FEE_DENOM - rate);
  }

  // The part-filled cohort is consumed first.
  let fromPart = 0n;
  if (t.partFilledOrdersRemaining > 0n) {
    fromPart = t.partFilledOrdersRemaining < result.amountOut ? t.partFilledOrdersRemaining : result.amountOut;
    if (fromPart > 0n) {
      t.unfilledRatioX64 = mulDivFloor(t.unfilledRatioX64, t.partFilledOrdersRemaining - fromPart, t.partFilledOrdersRemaining, U128_MAX) ?? fail('CalculateOverflow');
    }
    t.partFilledOrdersRemaining = t.partFilledOrdersRemaining - fromPart;
  }
  const rest = result.amountOut > fromPart ? result.amountOut - fromPart : 0n;
  if (rest > 0n) {
    if (t.partFilledOrdersRemaining !== 0n) fail('RequireEqViolated');
    if (!(t.ordersAmount >= rest)) fail('InvalidLimitOrderAmount');
    t.orderPhase = t.orderPhase === U64_MAX ? U64_MAX : t.orderPhase + 1n;
    t.unfilledRatioX64 = mulDivFloor(Q64, t.ordersAmount - rest, t.ordersAmount, U128_MAX) ?? fail('CalculateOverflow');
    t.partFilledOrdersRemaining = t.ordersAmount - rest;
    t.ordersAmount = 0n;
  }
  if (!feeOnInput) {
    result.ammFeeAmount = mdc64(result.amountOut, rate, FEE_DENOM);
    result.amountOut = u64(result.amountOut - result.ammFeeAmount);
  }
  return result;
}

/* ─────────────────────────────── dynamic fee ────────────────────────────── */

/** Our program's ceiling on any fee rate, 4% (pool_fee.rs; quote.test.ts holds them equal). */
export const MAX_FEE_RATE_NUMERATOR = 40_000;
/** The same ceiling in Raydium's own program, 10%: for replaying swaps that ran there. */
export const UPSTREAM_MAX_FEE_RATE_NUMERATOR = 100_000;
const VOLATILITY_ACCUMULATOR_SCALE = 10_000n;
const REDUCTION_FACTOR_DENOMINATOR = 10_000n;
const DYNAMIC_FEE_CONTROL_DENOMINATOR = 100_000n;

/** pool_fee.rs `tick_spacing_index_from_tick`. */
export function tickSpacingIndexFromTick(tickIndex: number, tickSpacing: number): number {
  const q = Math.trunc(tickIndex / tickSpacing);
  return tickIndex % tickSpacing === 0 || tickIndex >= 0 ? q : q - 1;
}

const i32 = (v: number) => (v < -(2 ** 31) || v > 2 ** 31 - 1 ? fail('ArithmeticOverflow') : v);

/** `compute_dynamic_fee_rate`. */
function dynamicFeeRate(d: DynamicFeeInfoView, tickSpacing: number, cap: number): number {
  const crossed = BigInt(d.volatilityAccumulator) * BigInt(tickSpacing);
  if (crossed > 0xffff_ffffn) fail('ArithmeticOverflow');
  const squared = crossed * crossed;
  const denominator = DYNAMIC_FEE_CONTROL_DENOMINATOR * VOLATILITY_ACCUMULATOR_SCALE * VOLATILITY_ACCUMULATOR_SCALE;
  const rate = mulDivCeil(BigInt(d.dynamicFeeControl), squared, denominator, U128_MAX) ?? fail('CalculateOverflow');
  return rate > BigInt(cap) ? cap : Number(rate);
}

/* ─────────────────────────────── swap_internal ──────────────────────────── */

/** Steps (bands entered plus prices or spacing groups crossed) before a quote gives up. */
export const MAX_SWAP_STEPS = 100_000;

interface Band {
  start: number;
  ticks: MutableTick[];
  initializedTickCount: number;
}

const cloneTick = (t: TickStateView): MutableTick => ({ ...t, rewardGrowthsOutsideX64: [...t.rewardGrowthsOutsideX64] });

/**
 * swap.rs `swap_internal`, on copies. Throws `ClmmMathError` where the program errors, and
 * `NeedsBand` when the walk reaches a band it was not given.
 */
export function swapInternal(a: Omit<SwapQuoteArgs, 'sqrtPriceLimitX64'> & { sqrtPriceLimitX64: bigint }, cap: FeeCeiling = MAX_FEE_RATE_NUMERATOR): SwapInternalResult {
  const { pool, config, zeroForOne } = a;
  const spacing = pool.tickSpacing;
  // A lower ceiling would quote a smaller fee than a program takes, and more coins out than it pays.
  if (cap !== MAX_FEE_RATE_NUMERATOR && cap !== UPSTREAM_MAX_FEE_RATE_NUMERATOR) {
    throw new RangeError(`a fee ceiling is a program's own, ${MAX_FEE_RATE_NUMERATOR} or ${UPSTREAM_MAX_FEE_RATE_NUMERATOR}, never ${String(cap)}`);
  }
  const limit = a.sqrtPriceLimitX64;
  const blockTimestamp = BigInt(a.blockTimestamp >>> 0); // `oracle::block_timestamp()` is a u32
  if (a.amount === 0n) fail('ZeroAmountSpecified');
  if (!poolAllows(pool, POOL_STATUS_BIT.swap)) fail('NotApproved');
  const limitOk = zeroForOne
    ? limit < pool.sqrtPriceX64 && limit > MIN_SQRT_PRICE_X64
    : limit > pool.sqrtPriceX64 && limit < MAX_SQRT_PRICE_X64;
  if (!limitOk) fail('SqrtPriceLimitOverflow');

  // The pool's maps, copied: a band emptied by filled orders flips its bit mid-swap.
  const bits = { tickArrayBitmap: [...pool.tickArrayBitmap], tickSpacing: spacing, tickCurrent: pool.tickCurrent };
  const ext = a.extension
    ? { ...a.extension, positiveTickArrayBitmap: a.extension.positiveTickArrayBitmap.map((w) => [...w]), negativeTickArrayBitmap: a.extension.negativeTickArrayBitmap.map((w) => [...w]) }
    : null;
  const cache = new Map<number, Band>();
  const used: number[] = [];
  const load = (start: number): Band => {
    let b = cache.get(start);
    if (!b) {
      const read = a.band(start);
      if (!read) throw new NeedsBand(start);
      if (read.startTickIndex !== start) fail('InvalidTickArray');
      b = { start, ticks: read.ticks.map(cloneTick), initializedTickCount: read.initializedTickCount };
      cache.set(start, b);
    }
    used.push(start);
    return b;
  };
  const flip = (start: number) => {
    if (isOverflowDefaultTickarrayBitmap(spacing, [start])) {
      if (!ext) fail('MissingTickArrayBitmapExtensionAccount');
      const maps = start < 0 ? ext!.negativeTickArrayBitmap : ext!.positiveTickArrayBitmap;
      const words = maps[getBitmapOffset(start, spacing)]!;
      const bit = tickArrayOffsetInBitmap(start, spacing);
      words[bit >> 6] = words[bit >> 6]! ^ (1n << BigInt(bit & 63));
    } else {
      if (!checkIsValidStartIndex(start, spacing)) fail('InvalidTickIndex');
      const bit = start / tickCount(spacing) + TICK_ARRAY_BITMAP_SIZE;
      bits.tickArrayBitmap[bit >> 6] = bits.tickArrayBitmap[bit >> 6]! ^ (1n << BigInt(bit & 63));
    }
  };

  let [firstContainsPoolTick, currentValidStart] = firstInitializedTickArray(bits, ext, zeroForOne);
  let current = load(currentValidStart);
  const feeOnInput = isFeeOnInput(pool.feeOn, zeroForOne);
  const feeOnToken0 = isFeeOnToken0(pool.feeOn, zeroForOne);

  // SwapState::new
  const s = {
    remaining: a.amount,
    calculated: 0n,
    sqrtPrice: pool.sqrtPriceX64,
    tick: pool.tickCurrent,
    lpFee: 0n,
    protocolFee: 0n,
    fundFee: 0n,
    liquidity: pool.liquidity,
    sqrtPriceNext: 0n,
    tickNext: 0,
    tickSpacingIndex: 0,
    dyn: pool.dynamicFeeInfo ? { ...pool.dynamicFeeInfo } : null,
  };
  if (s.dyn) {
    s.tickSpacingIndex = tickSpacingIndexFromTick(s.tick, spacing);
    // update_reference
    const since = blockTimestamp > s.dyn.lastUpdateTimestamp ? blockTimestamp - s.dyn.lastUpdateTimestamp : 0n;
    if (since < BigInt(s.dyn.filterPeriod)) {
      // within the high-frequency window: nothing moves
    } else if (since < BigInt(s.dyn.decayPeriod)) {
      s.dyn.tickSpacingIndexReference = s.tickSpacingIndex;
      s.dyn.volatilityReference = Number(BigInt.asUintN(32, (BigInt(s.dyn.volatilityAccumulator) * BigInt(s.dyn.reductionFactor)) / REDUCTION_FACTOR_DENOMINATOR));
      s.dyn.lastUpdateTimestamp = blockTimestamp;
    } else {
      s.dyn.tickSpacingIndexReference = s.tickSpacingIndex;
      s.dyn.volatilityReference = 0;
      s.dyn.lastUpdateTimestamp = blockTimestamp;
    }
  }

  const updateVolatilityAccumulator = () => {
    if (!s.dyn) return;
    const delta = BigInt(Math.abs(i32(s.dyn.tickSpacingIndexReference - s.tickSpacingIndex)));
    const acc = BigInt(s.dyn.volatilityReference) + delta * VOLATILITY_ACCUMULATOR_SCALE;
    const max = BigInt(s.dyn.maxVolatilityAccumulator);
    s.dyn.volatilityAccumulator = Number(BigInt.asUintN(32, acc < max ? acc : max));
  };
  const totalFeeRate = (): number => {
    if (!s.dyn) return config.tradeFeeRate;
    const total = config.tradeFeeRate + dynamicFeeRate(s.dyn, spacing, cap);
    if (total > 0xffff_ffff) fail('ArithmeticOverflow');
    return Math.min(total, cap);
  };
  /** `get_spacing_bounded_price`: with a dynamic fee, a step stops at each spacing boundary. */
  const spacingBounded = (target: bigint): [boolean, bigint, number | null] => {
    if (!s.dyn) return [true, target, null];
    if (s.liquidity === 0n || s.dyn.volatilityAccumulator === s.dyn.maxVolatilityAccumulator) return [true, target, null];
    const sat = (v: number) => Math.min(2 ** 31 - 1, Math.max(-(2 ** 31), v));
    const bounded = zeroForOne ? sat(s.tickSpacingIndex * spacing) : sat(sat(s.tickSpacingIndex + 1) * spacing);
    const clamped = Math.min(MAX_TICK, Math.max(MIN_TICK, bounded));
    const boundedPrice = getSqrtPriceAtTick(clamped);
    if (zeroForOne) return target > boundedPrice ? [false, target, null] : [false, boundedPrice, clamped];
    return target < boundedPrice ? [false, target, null] : [false, boundedPrice, clamped];
  };
  const updateDynamicFeeIndex = (skipped: boolean) => {
    if (!s.dyn) return;
    if (skipped) {
      const tickIndex = s.sqrtPrice === s.sqrtPriceNext ? s.tickNext : s.tick;
      let index = tickSpacingIndexFromTick(tickIndex, spacing);
      if (!zeroForOne && tickIndex % spacing === 0) index = i32(index - 1);
      s.tickSpacingIndex = index;
      if (s.dyn.volatilityAccumulator !== s.dyn.maxVolatilityAccumulator) updateVolatilityAccumulator();
    }
    s.tickSpacingIndex = i32(s.tickSpacingIndex + (zeroForOne ? -1 : 1));
  };
  /** `apply_swap_amounts` and `spilt_fees`. */
  const apply = (amountIn: bigint, amountOut: bigint, fee: bigint) => {
    const consumed = feeOnInput ? u64(amountIn + fee) : amountIn;
    if (a.isBaseInput) {
      s.remaining = u64(s.remaining - consumed);
      s.calculated = u64(s.calculated + amountOut);
    } else {
      s.remaining = u64(s.remaining - amountOut);
      s.calculated = u64(s.calculated + consumed);
    }
    const protocolDelta = config.protocolFeeRate > 0 ? (fee * BigInt(config.protocolFeeRate)) / FEE_DENOM : 0n;
    const fundDelta = config.fundFeeRate > 0 ? (fee * BigInt(config.fundFeeRate)) / FEE_DENOM : 0n;
    if (protocolDelta > 0n) s.protocolFee = u64(s.protocolFee + BigInt.asUintN(64, protocolDelta));
    if (fundDelta > 0n) s.fundFee = u64(s.fundFee + BigInt.asUintN(64, fundDelta));
    const remainingFee = u64(fee - BigInt.asUintN(64, protocolDelta) - BigInt.asUintN(64, fundDelta));
    if (s.liquidity > 0n) {
      if (mulDivFloor(remainingFee, Q64, s.liquidity, U128_MAX) === null) fail('CalculateOverflow');
      s.lpFee = u64(s.lpFee + remainingFee);
    } else {
      s.protocolFee = u64(s.protocolFee + remainingFee);
    }
  };

  // The program has no step limit but its compute budget, which ends a swap long before
  // this many steps. A count past it is a loop the quote must not hang a page on.
  let steps = 0;
  const countStep = () => {
    if (++steps > MAX_SWAP_STEPS) fail('ComputeBudgetExceeded');
  };
  while (s.remaining !== 0n && s.sqrtPrice !== limit) {
    countStep();
    // The next price that holds liquidity or resting orders, in this band or the next.
    let nextTick: MutableTick | null = nextInitializedTickIn(current, s.tick, spacing, zeroForOne);
    if (!nextTick && !firstContainsPoolTick) {
      firstContainsPoolTick = true;
      nextTick = firstInitializedTickIn(current, zeroForOne);
    } else if (!nextTick) {
      const nextStart = nextInitializedTickArrayStartIndex(bits, ext, currentValidStart, zeroForOne);
      if (nextStart === null) fail('LiquidityInsufficient');
      current = load(nextStart!);
      currentValidStart = nextStart!;
      nextTick = firstInitializedTickIn(current, zeroForOne);
    }
    const tick = nextTick!;
    if (!tickIsInitialized(tick)) fail('RequireEqViolated');

    // get_target_price_based_on_next_tick
    s.tickNext = Math.min(MAX_TICK, Math.max(MIN_TICK, tick.tick));
    s.sqrtPriceNext = getSqrtPriceAtTick(s.tickNext);
    const target = (zeroForOne && s.sqrtPriceNext < limit) || (!zeroForOne && s.sqrtPriceNext > limit) ? limit : s.sqrtPriceNext;
    if (zeroForOne) {
      if (!(s.tick >= s.tickNext) || !(s.sqrtPrice >= s.sqrtPriceNext) || !(s.sqrtPrice >= target)) fail('RequireGteViolated');
    } else {
      if (!(s.tickNext > s.tick)) fail('RequireGtViolated');
      if (!(s.sqrtPriceNext >= s.sqrtPrice) || !(target >= s.sqrtPrice)) fail('RequireGteViolated');
    }

    let liquidityNext = s.liquidity;
    for (;;) {
      countStep();
      updateVolatilityAccumulator();
      const feeRate = totalFeeRate();
      const [skipped, boundedPrice, boundedTick] = spacingBounded(target);
      let step: SwapStep;
      if (s.sqrtPrice !== boundedPrice) {
        step = computeSwap(s.sqrtPrice, boundedPrice, s.liquidity, s.remaining, feeRate, a.isBaseInput, zeroForOne, feeOnInput);
        apply(step.amountIn, step.amountOut, step.feeAmount);
      } else {
        step = { sqrtPriceNextX64: boundedPrice, amountIn: 0n, amountOut: 0n, feeAmount: 0n };
      }
      const unfilledBefore = unfilled(tick);
      if (s.sqrtPriceNext === step.sqrtPriceNextX64) {
        // At the next used price: fill its resting orders, then cross it if nothing rests.
        const lo = matchLimitOrder(tick, s.remaining, zeroForOne, a.isBaseInput, feeRate, feeOnInput, s.sqrtPriceNext);
        if (lo.amountIn !== 0n || lo.amountOut !== 0n || lo.ammFeeAmount !== 0n) apply(lo.amountIn, lo.amountOut, lo.ammFeeAmount);
        if (!tickIsInitialized(tick)) {
          if (current.initializedTickCount === 0) fail('CalculateOverflow');
          current.initializedTickCount -= 1;
          if (current.initializedTickCount === 0) flip(current.start);
        }
        if (tickHasLiquidity(tick) && !tickHasLimitOrders(tick)) {
          const net = zeroForOne ? -tick.liquidityNet : tick.liquidityNet;
          liquidityNext = addDelta(s.liquidity, net);
        }
        writeBack(current, tick, spacing);
        s.tick = (zeroForOne && !tickHasLimitOrders(tick)) || (!zeroForOne && tickHasLimitOrders(tick)) ? s.tickNext - 1 : s.tickNext;
      } else if (s.sqrtPrice !== step.sqrtPriceNextX64) {
        s.tick = boundedTick !== null && step.sqrtPriceNextX64 === boundedPrice ? boundedTick : getTickAtSqrtPrice(step.sqrtPriceNextX64);
      }
      s.sqrtPrice = step.sqrtPriceNextX64;
      updateDynamicFeeIndex(skipped);
      if (s.remaining === 0n || s.sqrtPrice === target) {
        const unfilledAfter = unfilled(tick);
        if (s.remaining !== 0n && unfilledAfter !== unfilledBefore && unfilledAfter !== 0n) fail('RequireEqViolated');
        break;
      }
    }
    s.liquidity = liquidityNext;
  }

  // settle_amounts
  const consumed = u64(a.amount - s.remaining);
  const [amount0, amount1] = zeroForOne === a.isBaseInput ? [consumed, s.calculated] : [s.calculated, consumed];
  const totalFee = u64(s.lpFee + s.protocolFee + s.fundFee);
  return {
    amount0,
    amount1,
    tradeFee0: feeOnToken0 ? totalFee : 0n,
    tradeFee1: feeOnToken0 ? 0n : totalFee,
    lpFee: s.lpFee,
    protocolFee: s.protocolFee,
    fundFee: s.fundFee,
    sqrtPriceX64: s.sqrtPrice,
    liquidity: s.liquidity,
    tick: s.tick,
    bands: [...new Set(used)],
  };
}

/** `TickArrayState::next_initialized_tick`: the next used price in this band, if the tick is in it. */
function nextInitializedTickIn(band: Band, currentTick: number, spacing: number, zeroForOne: boolean): MutableTick | null {
  if (getArrayStartIndex(currentTick, spacing) !== band.start) return null;
  const offset = Math.trunc((currentTick - band.start) / spacing);
  if (zeroForOne) {
    for (let i = offset; i >= 0; i--) if (tickIsInitialized(band.ticks[i]!)) return { ...band.ticks[i]! };
  } else {
    for (let i = offset + 1; i < TICK_ARRAY_SIZE; i++) if (tickIsInitialized(band.ticks[i]!)) return { ...band.ticks[i]! };
  }
  return null;
}

/** `TickArrayState::first_initialized_tick`. */
function firstInitializedTickIn(band: Band, zeroForOne: boolean): MutableTick {
  const order = zeroForOne ? [...band.ticks].reverse() : band.ticks;
  const t = order.find(tickIsInitialized);
  if (!t) fail('InvalidTickArray');
  return { ...t! };
}

/** `update_tick_state`: the copy goes back into its band. */
function writeBack(band: Band, tick: MutableTick, spacing: number) {
  if (getArrayStartIndex(tick.tick, spacing) !== band.start) fail('InvalidTickArray');
  band.ticks[Math.trunc((tick.tick - band.start) / spacing)] = tick;
}

/**
 * A quote for `swap_v2` in one of OUR pools: swap_internal plus the checks swap_v2 makes
 * around it (open time, both amounts non-zero, a full fill when no limit is given), with our
 * program's 4% fee ceiling. Every refusal the program would make is `refused`; it throws only
 * on a programming error.
 */
export function quoteSwap(a: SwapQuoteArgs): SwapQuote {
  return quoteWith(a, MAX_FEE_RATE_NUMERATOR);
}

/**
 * The same quote with Raydium's 10% fee ceiling: ONLY to replay a swap that ran in Raydium's
 * own program (the live-swap tests). Never for our pools; quote.test.ts holds that no app code
 * calls it.
 */
export function quoteSwapAsRaydium(a: SwapQuoteArgs): SwapQuote {
  return quoteWith(a, UPSTREAM_MAX_FEE_RATE_NUMERATOR);
}

function quoteWith(a: SwapQuoteArgs, cap: FeeCeiling): SwapQuote {
  try {
    if (!(BigInt(Math.floor(a.blockTimestamp)) > a.pool.openTime)) return { kind: 'refused', code: 'RequireGtViolated' };
    const limit = a.sqrtPriceLimitX64 === 0n ? (a.zeroForOne ? MIN_SQRT_PRICE_X64 + 1n : MAX_SQRT_PRICE_X64 - 1n) : a.sqrtPriceLimitX64;
    const r = swapInternal({ ...a, sqrtPriceLimitX64: limit }, cap);
    if (r.amount0 === 0n || r.amount1 === 0n) return { kind: 'refused', code: 'TooSmallInputOrOutputAmount' };
    const [amountIn, amountOut] = a.zeroForOne ? [r.amount0, r.amount1] : [r.amount1, r.amount0];
    const filled = (a.isBaseInput ? amountIn : amountOut) === a.amount;
    if (a.sqrtPriceLimitX64 === 0n && !filled) return { kind: 'refused', code: 'RequireEqViolated' };
    const feeInToken0 = isFeeOnToken0(a.pool.feeOn, a.zeroForOne);
    return {
      kind: 'ok',
      ...r,
      amountIn,
      amountOut,
      tradeFee: feeInToken0 ? r.tradeFee0 : r.tradeFee1,
      feeInToken0,
      filled,
      passExtension: a.pool.tickSpacing < 15 && a.extension !== null,
    };
  } catch (e) {
    if (e instanceof NeedsBand) return { kind: 'needs-band', startTickIndex: e.start };
    if (e instanceof ClmmMathError) return { kind: 'refused', code: e.code };
    throw e;
  }
}
