import { USDC_MINT, WSOL_MINT } from '../lp/tokenSafety';

/** A tier's fee per million of the swap: 10,000 is 1%. */
const ONE_PERCENT = 10_000;

/** The dollar coins a tier under 1% is for: USDC, the only one this site pairs with (lp/quotes.ts). */
const DOLLAR_MINTS: readonly string[] = [USDC_MINT];

/**
 * Whether this site offers a pair a fee tier (owner, 2026-10-24): a tier under 1% (today
 * 0.25%) only for SOL against a dollar coin, whose price moves slowly enough for a small fee
 * to pay its LPs; every other pair, meme coins like BAYLA included, sees 1% and up. A meme
 * coin's price swings, and on a small fee the trading against those swings costs its LPs
 * more than the fee pays them. The chain lets anyone open any pair on any tier: this is what
 * the site lists, opens and routes swaps through.
 */
export function offersTier(tradeFeeRate: number, mintA: string, mintB: string): boolean {
  if (tradeFeeRate >= ONE_PERCENT) return true;
  return (mintA === WSOL_MINT && DOLLAR_MINTS.includes(mintB)) || (mintB === WSOL_MINT && DOLLAR_MINTS.includes(mintA));
}

/** The tiers this site offers a pair, in the order given. */
export function tiersOffered<T extends { tradeFeeRate: number }>(tiers: readonly T[], mintA: string, mintB: string): T[] {
  return tiers.filter((t) => offersTier(t.tradeFeeRate, mintA, mintB));
}
