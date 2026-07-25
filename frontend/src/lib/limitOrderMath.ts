// Pure fill-safety math for the browser-watched limit order path, extracted so
// it can be unit-tested without the wagmi/publicClient machinery of the hook.
//
// THE HAZARD (fixed 2026-07-24): a browser-watched order TRIGGERS on the market
// (Uniswap) price but EXECUTES on the thin native Tegridy pool via SwapFeeRouter.
// The old code signed `minOut = min(targetDerivedMinOut, nativePoolQuote)`, so
// whenever the native pool lagged the market the order silently filled BELOW the
// user's target — up to ~50% below, since the only backstop was a coarse "abort
// if target > 2x the native quote" gate.
//
// THE FIX: floor minOut at the USER'S TARGET (haircut by the same fee + slippage
// the native pool imposes), and ABORT rather than underfill when the native pool
// cannot currently deliver that floor. The order then either fills at >= the
// user's target net of disclosed costs, or does not fill at all.

export interface LimitFillDecision {
  /** The floor to sign for. Derived from the user's target — never the (worse)
   *  live native-pool quote. */
  minOut: bigint;
  /** True when the native execution pool cannot honor the target floor right now
   *  (or quoted zero). The caller must NOT sign — revert the order to pending and
   *  prompt a refresh. */
  abort: boolean;
}

/** Haircut an amount by fee then slippage, matching the SwapFeeRouter cost model
 *  (fee is taken from the input before the swap; slippage is the user tolerance). */
function haircut(x: bigint, feeBps: bigint, slippageBps: bigint): bigint {
  const afterFee = (x * (10000n - feeBps)) / 10000n;
  return afterFee - (afterFee * slippageBps) / 10000n;
}

/**
 * @param targetExpectedOut Output at the user's EXACT target price (pre-haircut).
 * @param nativeQuoteOut    Native-pool getAmountsOut at execute time (pre-haircut).
 * @param feeBps            SwapFeeRouter fee cap tolerance, in bps.
 * @param slippageBps       User slippage tolerance, in bps.
 */
export function resolveLimitFill(
  targetExpectedOut: bigint,
  nativeQuoteOut: bigint,
  feeBps: bigint,
  slippageBps: bigint,
): LimitFillDecision {
  const minOut = haircut(targetExpectedOut, feeBps, slippageBps);
  const nativeDeliverable = haircut(nativeQuoteOut, feeBps, slippageBps);
  // Abort when the pool quoted nothing, or cannot meet the user's target floor.
  return { minOut, abort: nativeQuoteOut <= 0n || nativeDeliverable < minOut };
}
