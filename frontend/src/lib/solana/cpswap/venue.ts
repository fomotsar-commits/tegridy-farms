import { ratePercent, FEE_RATE_DENOMINATOR as FEE_DENOMINATOR } from './math';

/**
 * Fee arithmetic over an AmmConfig the chain returned (`readVenue()`). This file holds
 * no tier of its own: a surface whose read failed has no rate to fall back to, so it
 * cannot show an old number as the venue's. Rates are in hundredths of a bip
 * (denominator 1_000_000).
 */

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** What a config means for the trader and the LP, in plain numbers. */
export interface FeeSplit {
  /** % of trade volume the trader pays. */
  traderPaysPct: number;
  /** % of trade volume the LPs keep. */
  lpKeepsPct: number;
  /** % of trade volume the venue takes (protocol + fund). */
  venueTakesPct: number;
  /** The venue's share OF THE FEE, which is how the config expresses it. */
  venueShareOfFeePct: number;
}

/** Turn a config read off chain into the split. */
export function feeSplit(config: {
  tradeFeeRate: bigint;
  protocolFeeRate: bigint;
  fundFeeRate: bigint;
}): FeeSplit {
  const venueShare = config.protocolFeeRate + config.fundFeeRate;
  // Each part is formed as ONE bigint numerator over one exact power of ten,
  // rather than by subtracting floats. `0.3 - 0.075` is 0.22499999999999998 in
  // doubles, which a two-decimal display renders as 0.22 — understating what an
  // LP keeps by half a basis point on a number this page presents as their cut.
  const DEN = 10_000n * FEE_DENOMINATOR;
  const traderPaysPct = ratePercent(config.tradeFeeRate);
  const venueShareOfFeePct = ratePercent(venueShare);
  const venueTakesPct = Number(config.tradeFeeRate * venueShare) / Number(DEN);
  const lpKeepsPct = Number(config.tradeFeeRate * (FEE_DENOMINATOR - venueShare)) / Number(DEN);
  return { traderPaysPct, venueTakesPct, lpKeepsPct, venueShareOfFeePct };
}

/** Lamports → SOL, for display only. */
export function solOf(lamports: bigint): number {
  return Number(lamports) / Number(LAMPORTS_PER_SOL);
}
