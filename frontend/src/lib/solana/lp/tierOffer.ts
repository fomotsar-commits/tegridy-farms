import { USDC_MINT, WSOL_MINT } from './tokenSafety';

/** A tier's fee per million of the trade, on both pool programs: 10,000 is 1%. */
const ONE_PERCENT = 10_000;

/** The dollar coins a tier under 1% is for: USDC, the only one this site pairs with (quotes.ts). */
const DOLLAR_MINTS: readonly string[] = [USDC_MINT];

/** The pair a tier under 1% is offered for, in words. */
export const LOW_TIER_PAIR = 'SOL against USDC';

/** Whether a tier is offered to every pair (1% and up), not only to SOL against a dollar coin. */
export function forEveryPair(tradeFeeRate: number | bigint): boolean {
  return Number(tradeFeeRate) >= ONE_PERCENT;
}

/**
 * Whether this site offers a pair a fee tier (owner, 2026-10-24), in standard pools and
 * range pools alike: a tier under 1% (today 0.25%) only for SOL against a dollar coin,
 * whose price moves slowly enough for a small fee to pay its LPs; every other pair, meme
 * coins like BAYLA included, sees 1% and up. A meme coin's price swings, and on a small fee
 * the trading against those swings costs its LPs more than the fee pays them. The chain
 * lets anyone open any pair on any tier: this is what the site offers.
 */
export function offersTier(tradeFeeRate: number | bigint, mintA: string, mintB: string): boolean {
  if (forEveryPair(tradeFeeRate)) return true;
  return (mintA === WSOL_MINT && DOLLAR_MINTS.includes(mintB)) || (mintB === WSOL_MINT && DOLLAR_MINTS.includes(mintA));
}

/** The tiers this site offers a pair, in the order given. */
export function tiersOffered<T extends { tradeFeeRate: number | bigint }>(tiers: readonly T[], mintA: string, mintB: string): T[] {
  return tiers.filter((t) => offersTier(t.tradeFeeRate, mintA, mintB));
}
