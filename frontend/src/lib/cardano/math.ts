// Minswap V2's swap maths, copied from the audited validator, not re-derived:
// minswap-dex-v2 @ c3293ad43 lib/amm_dex_v2/math.ak `calculate_amount_out`. The batcher's
// transaction must pay exactly this amount (order_validation.ak `validate_swap_exact_in`), so
// a quote computed here from the pool's datum is the fill, as long as the pool has not moved.

/** utils.ak `default_fee_denominator`. */
export const FEE_DENOMINATOR = 10_000n;

/** math.ak `calculate_amount_out`. Integer division, as Plutus does it. */
export function calculateAmountOut(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, tradingFeeNumerator: bigint): bigint {
  if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) return 0n;
  if (tradingFeeNumerator < 0n || tradingFeeNumerator >= FEE_DENOMINATOR) return 0n;
  const diff = FEE_DENOMINATOR - tradingFeeNumerator;
  const inWithFee = diff * amountIn;
  const numerator = inWithFee * reserveOut;
  const denominator = FEE_DENOMINATOR * reserveIn + inWithFee;
  return numerator / denominator;
}

/** The least the order accepts: `expected` less the slippage, rounded down, never below 1. */
export function minimumReceive(expected: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) throw new Error('slippage out of range');
  const min = (expected * BigInt(10_000 - slippageBps)) / 10_000n;
  return min > 0n ? min : 0n;
}

/**
 * How far this trade moves the pool's price, in basis points of the price before it, fee
 * excluded: 1 - (out / in) / (reserveOut / reserveIn). Shown, never used to decide anything.
 */
export function priceImpactBps(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, amountOut: bigint, tradingFeeNumerator: bigint): number {
  if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) return 0;
  // Out at the spot price, after the fee, against what the curve pays.
  const spotOut = (amountIn * (FEE_DENOMINATOR - tradingFeeNumerator) * reserveOut) / (FEE_DENOMINATOR * reserveIn);
  if (spotOut <= 0n) return 0;
  const lost = spotOut - amountOut;
  return lost <= 0n ? 0 : Number((lost * 10_000n) / spotOut);
}
