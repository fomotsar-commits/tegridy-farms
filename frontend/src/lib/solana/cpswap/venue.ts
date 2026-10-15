import { ratePercent, FEE_RATE_DENOMINATOR as FEE_DENOMINATOR } from './math';

/**
 * Fee arithmetic over an AmmConfig the chain returned (`readVenue()`). This file holds
 * no tier of its own: a surface whose read failed has no rate to fall back to, so it
 * cannot show an old number as the venue's. Rates are in hundredths of a bip
 * (denominator 1_000_000).
 *
 * A TRADE COSTS TWO FEES ON SOME POOLS. The tier's `trade_fee_rate` is split between the
 * pool's LPs and the venue (`feeSplit`). The tier's `creator_fee_rate` is charged ON TOP,
 * to the pool's creator, but only by a pool whose own `enable_creator_fee` switch is on
 * (`chargedCreatorFeeRate`). So what a trader pays is never the trade fee alone: it is
 * `tradeCost`, and a surface that says what a trade costs must say that.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** How a tier's trade fee splits between the pool's LPs and the venue, in plain numbers. */
export interface FeeSplit {
  /**
   * % of trade volume the trade fee takes. NOT what a trader pays on a pool that also
   * charges a creator fee: that is `tradeCost(...).totalRate`.
   */
  tradeFeePct: number;
  /** % of trade volume the LPs keep. */
  lpKeepsPct: number;
  /** % of trade volume the venue takes (protocol + fund). */
  venueTakesPct: number;
  /** The venue's share OF THE TRADE FEE, which is how the config expresses it. */
  venueShareOfFeePct: number;
}

/** Turn a config read off chain into the trade fee's split. */
export function feeSplit(config: {
  tradeFeeRate: bigint;
  protocolFeeRate: bigint;
  fundFeeRate: bigint;
}): FeeSplit {
  const venueShare = config.protocolFeeRate + config.fundFeeRate;
  // Each part is formed as ONE bigint numerator over one exact power of ten,
  // rather than by subtracting floats. `0.3 - 0.075` is 0.22499999999999998 in
  // doubles, which a two-decimal display renders as 0.22, understating what an
  // LP keeps by half a basis point on a number this page presents as their cut.
  const DEN = 10_000n * FEE_DENOMINATOR;
  const tradeFeePct = ratePercent(config.tradeFeeRate);
  const venueShareOfFeePct = ratePercent(venueShare);
  const venueTakesPct = Number(config.tradeFeeRate * venueShare) / Number(DEN);
  const lpKeepsPct = Number(config.tradeFeeRate * (FEE_DENOMINATOR - venueShare)) / Number(DEN);
  return { tradeFeePct, venueTakesPct, lpKeepsPct, venueShareOfFeePct };
}

/**
 * Whether a pool charges its tier's creator fee is the POOL's, written once when it
 * opens and never changed after (no cp-swap instruction rewrites it):
 *   - `initialize_with_permission` writes `enable_creator_fee = true`. It needs a
 *     Permission account only the program's admin can create; the one on mainnet names
 *     the launch program's migration authority, which opens every launch pool this way
 *     (tegridy-launch `migrate_to_amm`).
 *   - `initialize` writes `false`. Anyone can call it, and it is what this site's
 *     Open a pool sends.
 */
export const CREATOR_FEE_SWITCH = { launchPool: true, publicOpen: false } as const;

/**
 * The creator fee a pool charges: its tier's `creator_fee_rate` when the pool's switch is
 * on, nothing when it is off. cp-swap `PoolState::adjust_creator_fee_rate`, which every
 * swap applies before it prices the trade. Paid to the pool's `pool_creator`, never to
 * its LPs or the venue.
 */
export function chargedCreatorFeeRate(config: { creatorFeeRate: bigint }, enableCreatorFee: boolean): bigint {
  return enableCreatorFee ? config.creatorFeeRate : 0n;
}

/** What a trade on one pool costs, in hundredths of a bip. */
export interface TradeCost {
  /** The tier's trade fee, shared by the pool's LPs and the venue. */
  tradeFeeRate: bigint;
  /** The creator fee the pool charges on top: `0n` when it charges none. */
  creatorFeeRate: bigint;
  /** What the trader pays in all. */
  totalRate: bigint;
}

/**
 * The two fees together. `creatorFeeRate` is what the POOL charges
 * (`chargedCreatorFeeRate`), never the tier's rate on its own, which a pool with its
 * switch off does not charge.
 *
 * The creator's cut comes off what the trader pays or off what they receive, depending
 * on the pool and the direction (cp-swap `is_creator_fee_on_input`), so on the second
 * kind it is a share of the output. Either way it is the rate the tier states.
 */
export function tradeCost(config: { tradeFeeRate: bigint }, creatorFeeRate: bigint): TradeCost {
  return { tradeFeeRate: config.tradeFeeRate, creatorFeeRate, totalRate: config.tradeFeeRate + creatorFeeRate };
}

/** Lamports → SOL, for display only. */
export function solOf(lamports: bigint): number {
  return Number(lamports) / Number(LAMPORTS_PER_SOL);
}
