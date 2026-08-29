import { ratePercent, FEE_RATE_DENOMINATOR as FEE_DENOMINATOR } from './math';

/**
 * The venue's RECOMMENDED AmmConfig — i.e. the arguments the operator passes to
 * `create_amm_config`, the one instruction standing between this code and a
 * live Solana LP venue.
 *
 * ⚠️ THIS IS A PROPOSAL, NOT A READING. Nothing in this file describes what any
 * pool currently charges — no AmmConfig has ever been created, which is exactly
 * why `migrate_to_amm` failed `AmmNotConfigured` (6015) for the whole life of
 * the previous deployment. Every surface that shows a live fee MUST take it
 * from `readVenue()`, which reads the chain. The two are kept apart on purpose:
 * `solanaVenueFacts.ts` already makes the same split for the graduation fee and
 * states the reason — "a hand-copied '1%' here would be a disclosure that keeps
 * its old value after the config changes, the precise way a fee sheet becomes a
 * lie without anyone editing it".
 *
 * WHERE THE NUMBERS COME FROM. They are Raydium's own standard CPMM tier, and
 * they are already the numbers this repo's migration rehearsal creates its
 * config with (`solana/tegridy-amm/tests/tegridy-launch-migration.test.ts`:
 * `createAmmConfig(index, 2500, 120000, 0, 0.15 SOL, 0)`). Matching the
 * dominant venue's standard tier is the competitive choice: LPs compare the
 * rate they keep, and traders compare the rate they pay, against Raydium.
 *
 * All five rates are in hundredths of a bip (denominator 1_000_000).
 */

export interface AmmConfigProposal {
  index: number;
  tradeFeeRate: bigint;
  protocolFeeRate: bigint;
  fundFeeRate: bigint;
  /** Flat, in lamports, charged once per pool creation. */
  createPoolFee: bigint;
  creatorFeeRate: bigint;
}

export const LAMPORTS_PER_SOL = 1_000_000_000n;

export const RECOMMENDED_AMM_CONFIG: AmmConfigProposal = {
  index: 0,

  /**
   * 0.25% of every trade, taken from the input. Raydium's standard CPMM tier.
   * Going higher loses order flow to the identical pool one venue over; going
   * lower starves the LPs whose deposits are the entire product.
   */
  tradeFeeRate: 2_500n,

  /**
   * 12% OF THE TRADE FEE (not of the trade) → 0.03% of volume to the protocol.
   * The remainder stays with LPs.
   */
  protocolFeeRate: 120_000n,

  /**
   * 4% of the trade fee → 0.01% of volume to the fund owner. Raydium's standard
   * config splits the venue's cut across two collectors (`collect_protocol_fee`
   * and `collect_fund_fee`) so the treasury and the operating wallet can be
   * different accounts without a second fee tier.
   *
   * Combined venue take: 16% of the trade fee = 0.04% of volume.
   * LPs keep 84% of the trade fee = 0.21% of volume.
   */
  fundFeeRate: 40_000n,

  /**
   * 0.15 SOL to create a pool. Deliberately non-trivial: pool creation writes
   * five rent-exempt accounts, and a free create invites spam pools that split
   * liquidity across duplicate pairs. Paid to `create_pool_fee_reveiver::ID`,
   * which must be a WSOL TOKEN ACCOUNT — the program calls `sync_native` on it.
   */
  createPoolFee: 15n * LAMPORTS_PER_SOL / 100n,

  /**
   * Zero at launch, and that is a decision rather than a placeholder. A creator
   * fee is charged ON TOP of the trade fee, so switching it on raises the cost
   * of every trade in the pool; the restart plan's open question 3 asks whether
   * it should be enabled at all, and nobody has recorded a position. It can be
   * raised later with `update_config`, and each pool carries its own
   * `enable_creator_fee` switch on top of this.
   */
  creatorFeeRate: 0n,
};

/** What the proposal means for the two people who care, in plain numbers. */
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

/**
 * Turn a config — proposed OR read off chain — into the split. Taking the same
 * function over both is what stops the page and the proposal drifting apart.
 */
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

/**
 * The exact `create_amm_config` argument list, in program order, for the
 * operator to run. Rendered on the pools page so the one missing instruction is
 * never a thing someone has to reconstruct from a doc.
 *
 * Signature: create_amm_config(index, trade_fee_rate, protocol_fee_rate,
 *                              fund_fee_rate, create_pool_fee, creator_fee_rate)
 */
export function createAmmConfigArgs(p: AmmConfigProposal = RECOMMENDED_AMM_CONFIG): string[] {
  return [
    String(p.index),
    String(p.tradeFeeRate),
    String(p.protocolFeeRate),
    String(p.fundFeeRate),
    String(p.createPoolFee),
    String(p.creatorFeeRate),
  ];
}

/** Lamports → SOL, for display only. */
export function solOf(lamports: bigint): number {
  return Number(lamports) / Number(LAMPORTS_PER_SOL);
}
