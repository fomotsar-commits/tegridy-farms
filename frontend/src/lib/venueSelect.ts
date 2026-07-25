// Pure best-venue selection between the native Tegridy pool (via SwapFeeRouter)
// and Uniswap V2, extracted so the DCA keeper can pick the same way the Swap tab
// does — and so the choice is unit-testable without wagmi.
//
// Mirrors the Swap tab exactly (useSwapQuote.ts "Smart Route Selection"): the
// native route's output is compared NET of the protocol fee (SwapFeeRouter
// deducts its fee from the input), so native only wins when, after its fee, it
// still delivers >= Uniswap. No artificial preference for the native pool; the
// deep POL has to earn the routing on price so the user is never worse off than
// going direct to Uniswap. Ties go to native (the treasury earns, user equal).

export type Venue = 'tegridy' | 'uniswap';

export interface VenueChoice {
  /** Which venue to execute on. */
  source: Venue;
  /** The selected venue's user-facing output (native is already net of fee). */
  netOut: bigint;
  /** minOut to sign: netOut minus the caller's slippage tolerance. */
  minOut: bigint;
}

/**
 * @param tegridyOut  native-pool getAmountsOut (gross, pre-fee)
 * @param uniOut      Uniswap V2 getAmountsOut (already net of its 0.3% pool fee)
 * @param feeBps      SwapFeeRouter fee applied to the native route, in bps
 * @param slippageBps user slippage tolerance, in bps
 */
export function selectOnChainVenue(
  tegridyOut: bigint,
  uniOut: bigint,
  feeBps: bigint,
  slippageBps: bigint,
): VenueChoice {
  const tegridyNet = tegridyOut > 0n ? (tegridyOut * (10000n - feeBps)) / 10000n : 0n;

  let source: Venue;
  if (tegridyNet > 0n && uniOut > 0n) {
    source = tegridyNet >= uniOut ? 'tegridy' : 'uniswap';
  } else if (tegridyNet > 0n) {
    source = 'tegridy';
  } else {
    source = 'uniswap';
  }

  const netOut = source === 'tegridy' ? tegridyNet : uniOut;
  const minOut = netOut - (netOut * slippageBps) / 10000n;
  return { source, netOut, minOut };
}
