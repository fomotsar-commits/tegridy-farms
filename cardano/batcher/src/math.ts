// The pool contract's integer math, ported line by line from
// cardano/minswap-dex-v2/lib/amm_dex_v2/math.ak (Minswap V2 @ c3293ad43, which this venue's
// pools copy). The contract recomputes every number in a batch; one lovelace of difference
// fails the whole transaction and costs the batcher its collateral. So nothing here is
// "simplified": each function keeps the contract's order of operations and its rounding.
//
// ROUNDING. Aiken's `/` is Plutus divideInteger: it rounds toward negative infinity.
// JavaScript's bigint `/` rounds toward zero. They differ only when exactly one side is
// negative, but every division here goes through `div` so the port never depends on that.

/** utils.ak `default_fee_denominator`. */
export const FEE_DENOMINATOR = 10_000n;

/** Aiken `/` (Plutus divideInteger): floor division. Division by zero fails, as on chain. */
export function div(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error('division by zero');
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

/** An Aiken `expect` that failed: the transaction would fail on chain. */
export class ContractFailure extends Error {
  constructor(where: string) {
    super(`the contract would fail: ${where}`);
  }
}

function expect(ok: boolean, where: string): void {
  if (!ok) throw new ContractFailure(where);
}

/** math.ak `calculate_sqrt`: the integer square root, rounded down; fails below zero. */
export function calculateSqrt(x: bigint): bigint {
  expect(x >= 0n, 'calculate_sqrt of a negative number');
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

/** math.ak `calculate_pow`. */
export function calculatePow(x: bigint): bigint {
  return x * x;
}

/** math.ak `calculate_initial_liquidity`: the square root of the product, rounded UP. */
export function calculateInitialLiquidity(outA: bigint, outB: bigint): bigint {
  const p = outA * outB;
  const sqrt = calculateSqrt(p);
  return sqrt * sqrt < p ? sqrt + 1n : sqrt;
}

/** math.ak `calculate_earned_fee_in_fraction`: the venue's fee share on a fractional input. */
export function calculateEarnedFeeInFraction(
  amountInNumerator: bigint,
  amountInDenominator: bigint,
  tradingFeeNumerator: bigint,
  feeSharingNumerator: bigint | null,
): bigint {
  if (feeSharingNumerator === null) return 0n;
  return div(
    amountInNumerator * tradingFeeNumerator * feeSharingNumerator,
    amountInDenominator * FEE_DENOMINATOR * FEE_DENOMINATOR,
  );
}

/** math.ak `calculate_earned_fee_in`: the venue's fee share on a swap's input. */
export function calculateEarnedFeeIn(amountIn: bigint, tradingFeeNumerator: bigint, feeSharingNumerator: bigint | null): bigint {
  if (feeSharingNumerator === null) return 0n;
  return div(amountIn * tradingFeeNumerator * feeSharingNumerator, FEE_DENOMINATOR * FEE_DENOMINATOR);
}

/** math.ak `calculate_amount_out` (formula.md "1. Swap Exact In"). */
export function calculateAmountOut(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, tradingFeeNumerator: bigint): bigint {
  const diff = FEE_DENOMINATOR - tradingFeeNumerator;
  const inWithFee = diff * amountIn;
  const numerator = inWithFee * reserveOut;
  const denominator = FEE_DENOMINATOR * reserveIn + inWithFee;
  return div(numerator, denominator);
}

/** math.ak `calculate_max_in_swap` (formula.md "7. Partial Swap"); fails unless positive. */
export function calculateMaxInSwap(
  reserveIn: bigint,
  reserveOut: bigint,
  tradingFeeNumerator: bigint,
  ioRatioNumerator: bigint,
  ioRatioDenominator: bigint,
): bigint {
  const diff = FEE_DENOMINATOR - tradingFeeNumerator;
  const numerator = ioRatioNumerator * diff * reserveOut - ioRatioDenominator * FEE_DENOMINATOR * reserveIn;
  const denominator = ioRatioDenominator * diff;
  const maxInSwap = div(numerator, denominator);
  expect(maxInSwap > 0n, 'calculate_max_in_swap not positive');
  return maxInSwap;
}

/** math.ak `calculate_amount_in` (formula.md "2. Swap Exact Out"); fails unless out < reserve. */
export function calculateAmountIn(reserveIn: bigint, reserveOut: bigint, amountOut: bigint, tradingFeeNumerator: bigint): bigint {
  expect(amountOut < reserveOut, 'calculate_amount_in: amount_out >= reserve_out');
  const diff = FEE_DENOMINATOR - tradingFeeNumerator;
  const numerator = reserveIn * amountOut * FEE_DENOMINATOR;
  const denominator = (reserveOut - amountOut) * diff;
  return div(numerator, denominator) + 1n;
}

/** math.ak `calculate_deposit_swap_amount` (formula.md "3. Deposit"): (numerator, denominator). */
export function calculateDepositSwapAmount(
  amountIn: bigint,
  amountOut: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  tradingFeeNumerator: bigint,
): [bigint, bigint] {
  const x = (amountOut + reserveOut) * reserveIn;
  const y = 4n * (amountOut + reserveOut) * (amountOut * calculatePow(reserveIn) - amountIn * reserveIn * reserveOut);
  const z = 2n * (amountOut + reserveOut);
  const b = (2n * FEE_DENOMINATOR - tradingFeeNumerator) * x;
  const a = calculatePow(b) - y * FEE_DENOMINATOR * (FEE_DENOMINATOR - tradingFeeNumerator);
  const numerator = calculateSqrt(a) - b;
  const denominator = z * (FEE_DENOMINATOR - tradingFeeNumerator);
  return [numerator, denominator];
}

/**
 * math.ak `calculate_deposit_amount`: (earned fee A, earned fee B, LP minted) for depositing
 * amountA and amountB, swapping part of the side the pool is short of.
 */
export function calculateDepositAmount(
  amountA: bigint,
  amountB: bigint,
  reserveA: bigint,
  reserveB: bigint,
  totalLiquidity: bigint,
  tradingFeeANumerator: bigint,
  tradingFeeBNumerator: bigint,
  feeSharingNumerator: bigint | null,
): [bigint, bigint, bigint] {
  const ratioA = div(amountA * totalLiquidity, reserveA);
  const ratioB = div(amountB * totalLiquidity, reserveB);
  if (ratioA > ratioB) {
    // swap a part of A to B
    const [num, den] = calculateDepositSwapAmount(amountA, amountB, reserveA, reserveB, tradingFeeANumerator);
    const earnedFeeA = calculateEarnedFeeInFraction(num, den, tradingFeeANumerator, feeSharingNumerator);
    const lpAmount = div((amountA * den - num) * totalLiquidity, reserveA * den + num);
    return [earnedFeeA, 0n, lpAmount];
  } else if (ratioA < ratioB) {
    // swap a part of B to A
    const [num, den] = calculateDepositSwapAmount(amountB, amountA, reserveB, reserveA, tradingFeeBNumerator);
    const earnedFeeB = calculateEarnedFeeInFraction(num, den, tradingFeeBNumerator, feeSharingNumerator);
    const lpAmount = div((amountB * den - num) * totalLiquidity, reserveB * den + num);
    return [0n, earnedFeeB, lpAmount];
  } else {
    return [0n, 0n, ratioA];
  }
}

/** math.ak `calculate_withdraw` (formula.md "4. Withdraw"): (amount A, amount B). */
export function calculateWithdraw(reserveA: bigint, reserveB: bigint, withdrawalLpAmount: bigint, totalLiquidity: bigint): [bigint, bigint] {
  return [div(withdrawalLpAmount * reserveA, totalLiquidity), div(withdrawalLpAmount * reserveB, totalLiquidity)];
}
