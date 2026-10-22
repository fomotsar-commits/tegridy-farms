import { shareOfSwap } from '../../../../api/_lib/shareOfSwap.js';
import { FEE_ON_TOKEN_0_ONLY, FEE_ON_TOKEN_1_ONLY, type AmmConfigView } from './program';

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

export function feeSplit(t: Pick<AmmConfigView, 'tradeFeeRate' | 'protocolFeeRate' | 'fundFeeRate'>): FeeSplit {
  const venue = t.protocolFeeRate + t.fundFeeRate;
  return {
    fee: perMillionPercent(t.tradeFeeRate),
    lpOfFee: perMillionPercent(1_000_000 - venue),
    // The position link's rule (api/_lib/shareOfSwap.js): positions DOWN, the venue's cut UP.
    lpOfSwap: shareOfSwap(t.tradeFeeRate, 1_000_000 - venue, 'positions'),
    venueOfFee: perMillionPercent(venue),
    venueOfSwap: shareOfSwap(t.tradeFeeRate, venue, 'deduction'),
  };
}

/** Which coin a pool's fees are paid in, in words: the pool's `fee_on` setting. */
export function feePaidIn(feeOn: number, symbol0: string, symbol1: string): string {
  if (feeOn === FEE_ON_TOKEN_0_ONLY) return `in ${symbol0} only`;
  if (feeOn === FEE_ON_TOKEN_1_ONLY) return `in ${symbol1} only`;
  return 'in the coin each swap pays in';
}
