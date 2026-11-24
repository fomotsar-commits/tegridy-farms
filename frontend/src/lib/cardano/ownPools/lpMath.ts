// The pool contract's liquidity maths, copied from our batcher's line-by-line port of
// cardano/minswap-dex-v2/lib/amm_dex_v2/math.ak (cardano/batcher/src/math.ts, draft PR #1008).
// The batcher pays exactly these numbers, so a quote made here from the pool's datum is the
// fill, as long as the pool has not moved. Aiken's `/` floors; so does `div`.

import { FEE_DENOMINATOR, minimumReceive } from '../math';
import type { PoolState } from '../minswapV2';

/** utils.ak `default_burn_liquidity`: LP minted when a pool opens that no one ever holds. */
export const BURNED_LIQUIDITY = 10n;
/** utils.ak `min_pool_ada`: ADA every pool holds beyond its reserves, put in by its opener, for good. */
export const MIN_POOL_ADA = 4_500_000n;
/** The LP supply the authen policy mints into each new pool: Int64's maximum. */
export const MAX_LP_SUPPLY = 9_223_372_036_854_775_807n;

/** Plutus divideInteger: floor division. */
export function div(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error('division by zero');
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

/** math.ak `calculate_sqrt`: the integer square root, rounded down. */
export function calculateSqrt(x: bigint): bigint {
  if (x < 0n) throw new Error('calculate_sqrt of a negative number');
  if (x === 0n) return 0n;
  if (x === 1n || x === 2n) return 1n;
  let i1 = x;
  let i2 = div(x, 2n) + 1n;
  while (i2 < i1) {
    i1 = i2;
    i2 = div(div(x, i2) + i2, 2n);
  }
  return i1;
}

/** math.ak `calculate_initial_liquidity`: the square root of the product, rounded UP. */
export function calculateInitialLiquidity(amountA: bigint, amountB: bigint): bigint {
  const p = amountA * amountB;
  const s = calculateSqrt(p);
  return s * s < p ? s + 1n : s;
}

function calculateEarnedFeeInFraction(numerator: bigint, denominator: bigint, fee: bigint, feeSharing: bigint | null): bigint {
  if (feeSharing === null) return 0n;
  return div(numerator * fee * feeSharing, denominator * FEE_DENOMINATOR * FEE_DENOMINATOR);
}

/** math.ak `calculate_deposit_swap_amount`: (numerator, denominator). */
function calculateDepositSwapAmount(amountIn: bigint, amountOut: bigint, reserveIn: bigint, reserveOut: bigint, fee: bigint): [bigint, bigint] {
  const x = (amountOut + reserveOut) * reserveIn;
  const y = 4n * (amountOut + reserveOut) * (amountOut * reserveIn * reserveIn - amountIn * reserveIn * reserveOut);
  const z = 2n * (amountOut + reserveOut);
  const b = (2n * FEE_DENOMINATOR - fee) * x;
  const a = b * b - y * FEE_DENOMINATOR * (FEE_DENOMINATOR - fee);
  return [calculateSqrt(a) - b, z * (FEE_DENOMINATOR - fee)];
}

/**
 * math.ak `calculate_deposit_amount`: (venue share of A, venue share of B, LP minted) for
 * depositing amountA and amountB, the side the pool is short of partly swapped first.
 */
export function calculateDepositAmount(
  amountA: bigint,
  amountB: bigint,
  reserveA: bigint,
  reserveB: bigint,
  totalLiquidity: bigint,
  feeA: bigint,
  feeB: bigint,
  feeSharing: bigint | null,
): [bigint, bigint, bigint] {
  const ratioA = div(amountA * totalLiquidity, reserveA);
  const ratioB = div(amountB * totalLiquidity, reserveB);
  if (ratioA > ratioB) {
    const [num, den] = calculateDepositSwapAmount(amountA, amountB, reserveA, reserveB, feeA);
    return [calculateEarnedFeeInFraction(num, den, feeA, feeSharing), 0n, div((amountA * den - num) * totalLiquidity, reserveA * den + num)];
  }
  if (ratioA < ratioB) {
    const [num, den] = calculateDepositSwapAmount(amountB, amountA, reserveB, reserveA, feeB);
    return [0n, calculateEarnedFeeInFraction(num, den, feeB, feeSharing), div((amountB * den - num) * totalLiquidity, reserveB * den + num)];
  }
  return [0n, 0n, ratioA];
}

/** math.ak `calculate_withdraw`: (amount A, amount B) for burning `lp`. */
export function calculateWithdraw(reserveA: bigint, reserveB: bigint, lp: bigint, totalLiquidity: bigint): [bigint, bigint] {
  return [div(lp * reserveA, totalLiquidity), div(lp * reserveB, totalLiquidity)];
}

/** B at the pool's own ratio for `amountA` of A, rounded down: the deposit swaps almost nothing. */
export function balancedB(pool: Pick<PoolState, 'reserveA' | 'reserveB'>, amountA: bigint): bigint {
  return div(amountA * pool.reserveB, pool.reserveA);
}

export interface DepositQuote {
  amountA: bigint;
  amountB: bigint;
  expectedLp: bigint;
  minimumLp: bigint;
  /** Share of the pool after the deposit, in millionths. */
  sharePpm: bigint;
}

export function quoteDeposit(pool: PoolState, amountA: bigint, amountB: bigint, slippageBps: number): DepositQuote | { refused: string } {
  if (amountA < 0n || amountB < 0n || amountA + amountB <= 0n) return { refused: 'Enter an amount.' };
  const [, , lp] = calculateDepositAmount(amountA, amountB, pool.reserveA, pool.reserveB, pool.totalLiquidity, pool.feeANumerator, pool.feeBNumerator, pool.feeSharingNumerator);
  if (lp <= 0n) return { refused: 'This amount is too small to mint any LP tokens.' };
  const min = minimumReceive(lp, slippageBps);
  if (min <= 0n) return { refused: 'This amount is too small for its minimum to be above zero.' };
  return { amountA, amountB, expectedLp: lp, minimumLp: min, sharePpm: (lp * 1_000_000n) / (pool.totalLiquidity + lp) };
}

export interface WithdrawQuote {
  lp: bigint;
  expectedA: bigint;
  expectedB: bigint;
  minimumA: bigint;
  minimumB: bigint;
}

export function quoteWithdraw(pool: PoolState, lp: bigint, slippageBps: number): WithdrawQuote | { refused: string } {
  if (lp <= 0n) return { refused: 'Enter an amount.' };
  if (lp > pool.totalLiquidity) return { refused: 'That is more LP tokens than the pool has issued.' };
  const [a, b] = calculateWithdraw(pool.reserveA, pool.reserveB, lp, pool.totalLiquidity);
  const minA = minimumReceive(a, slippageBps);
  const minB = minimumReceive(b, slippageBps);
  // order_validation.ak refuses a withdrawal whose minimums are not both positive.
  if (minA <= 0n || minB <= 0n) return { refused: 'This amount is too small to take out anything of both coins.' };
  return { lp, expectedA: a, expectedB: b, minimumA: minA, minimumB: minB };
}

export interface OpenQuote {
  /** The datum's total_liquidity: the square root of A × B, rounded up. */
  totalLiquidity: bigint;
  /** What the opener receives: the total less the 10 burned. */
  openerLp: bigint;
  /** What the pool keeps of the LP supply minted. */
  poolLpRemaining: bigint;
}

export function quoteOpen(amountA: bigint, amountB: bigint): OpenQuote | { refused: string } {
  if (amountA <= 0n || amountB <= 0n) return { refused: 'Enter both amounts.' };
  const total = calculateInitialLiquidity(amountA, amountB);
  // factory_validator.ak: total_liquidity > default_burn_liquidity.
  if (total <= BURNED_LIQUIDITY) return { refused: 'These amounts are too small to open a pool.' };
  return { totalLiquidity: total, openerLp: total - BURNED_LIQUIDITY, poolLpRemaining: MAX_LP_SUPPLY - (total - BURNED_LIQUIDITY) };
}

/** A position's share of the pool, in millionths, and what it would take out now. */
export function positionNow(pool: Pick<PoolState, 'reserveA' | 'reserveB' | 'totalLiquidity'>, lp: bigint): { sharePpm: bigint; a: bigint; b: bigint } {
  const [a, b] = calculateWithdraw(pool.reserveA, pool.reserveB, lp, pool.totalLiquidity);
  return { sharePpm: (lp * 1_000_000n) / pool.totalLiquidity, a, b };
}

/** Scale of growthIndex: 10^12, so a fee growth of one part in a billion still shows. */
export const GROWTH_SCALE = 1_000_000_000_000n;

/**
 * The pool's value per LP token, as sqrt(reserveA × reserveB) / totalLiquidity, scaled. Only
 * trade fees left in the pool raise it (deposits and withdrawals keep it); it is how much an
 * LP token has grown since a moment this index was noted.
 */
export function growthIndex(pool: Pick<PoolState, 'reserveA' | 'reserveB' | 'totalLiquidity'>): bigint {
  return (calculateSqrt(pool.reserveA * pool.reserveB) * GROWTH_SCALE) / pool.totalLiquidity;
}

/** The index a balanced deposit of `a` and `b` that minted `lp` entered at. */
export function entryIndex(a: bigint, b: bigint, lp: bigint): bigint {
  return lp > 0n ? (calculateSqrt(a * b) * GROWTH_SCALE) / lp : 0n;
}

/**
 * Of what `lp` takes out now, the part the pool's fees added since it was entered at `entry`:
 * value × (1 − entry / now). Zero when the index has not grown.
 */
export function feesSince(pool: Pick<PoolState, 'reserveA' | 'reserveB' | 'totalLiquidity'>, lp: bigint, entry: bigint): { a: bigint; b: bigint } {
  const now = growthIndex(pool);
  if (entry <= 0n || now <= entry) return { a: 0n, b: 0n };
  const { a, b } = positionNow(pool, lp);
  return { a: (a * (now - entry)) / now, b: (b * (now - entry)) / now };
}
