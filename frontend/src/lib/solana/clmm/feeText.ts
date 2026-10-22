import { feeCeiling, swapShareText } from '../../../../api/_lib/shareOfSwap.js';
import { FEE_ON_TOKEN_0_ONLY, FEE_ON_TOKEN_1_ONLY, type AmmConfigView, type PoolStateView } from './program';

/** Rates the program keeps per million, as a percent, exactly: 10,000 is 1%, 160,000 (of a fee) is 16%. */
export function perMillionPercent(rate: number): string {
  return `${Number((rate / 10_000).toFixed(4))}%`;
}

/** A fee tier's split, every figure read from the tier account (never a constant here). */
export interface FeeSplit {
  /** Of each swap. */
  fee: string;
  /** Of the fee, to the positions in range. */
  lpOfFee: string;
  /** Of each swap, to the positions in range. */
  lpOfSwap: string;
  /** Of the fee, to the venue's accounts (protocol plus fund). */
  venueOfFee: string;
  /** Of each swap, to the venue's accounts. */
  venueOfSwap: string;
}

/** The most a pool's swap fee can be, from its dynamic-fee record (shareOfSwap.js), or null for none. */
export function poolFeeCeiling(pool: Pick<PoolStateView, 'dynamicFeeInfo' | 'tickSpacing'>, tradeFeeRate: number): number | null {
  return feeCeiling(tradeFeeRate, pool.dynamicFeeInfo, pool.tickSpacing);
}

/**
 * The fee and its split, by the position link's rule (api/_lib/shareOfSwap.js). `ceiling`
 * (poolFeeCeiling) on a pool whose fee can rise above its tier's rate: the fee is a range and
 * each share of the swap a floor, or on a 0% tier a range up to that pool's own ceiling.
 */
export function feeSplit(t: Pick<AmmConfigView, 'tradeFeeRate' | 'protocolFeeRate' | 'fundFeeRate'>, ceiling: number | null = null): FeeSplit {
  const venue = t.protocolFeeRate + t.fundFeeRate;
  const rises = ceiling !== null && ceiling > t.tradeFeeRate;
  return {
    fee: rises ? `${perMillionPercent(t.tradeFeeRate)} to ${perMillionPercent(ceiling)}` : perMillionPercent(t.tradeFeeRate),
    lpOfFee: perMillionPercent(1_000_000 - venue),
    // Positions DOWN, the venue's cut UP.
    lpOfSwap: swapShareText(t.tradeFeeRate, 1_000_000 - venue, 'positions', ceiling),
    venueOfFee: perMillionPercent(venue),
    venueOfSwap: swapShareText(t.tradeFeeRate, venue, 'deduction', ceiling),
  };
}

/** Which coin a pool's fees are paid in, in words: the pool's `fee_on` setting. */
export function feePaidIn(feeOn: number, symbol0: string, symbol1: string): string {
  if (feeOn === FEE_ON_TOKEN_0_ONLY) return `in ${symbol0} only`;
  if (feeOn === FEE_ON_TOKEN_1_ONLY) return `in ${symbol1} only`;
  return 'in the coin each swap pays in';
}
