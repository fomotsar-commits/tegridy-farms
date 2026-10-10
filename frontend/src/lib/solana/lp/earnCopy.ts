import { PLATFORM_TREASURY_VAULT } from '../../launcher/solana/curve/program';
import type { AmmConfigView } from '../cpswap/program';
import { feeSplit, solOf } from '../cpswap/venue';
import { feeRateText, pctText } from './format';

/**
 * The LP section's two short blocks: how a liquidity provider earns, and how the venue
 * does. Every pool rate is the public fee tier's as the page just read it; with no tier
 * read, no number is said. The swap fee is the swap's own build setting (lib/solana.ts).
 * A wallet is called the team's shared wallet only when the chain names that vault.
 */

export const EARN_TITLES = { you: 'How you earn', venue: 'How the venue earns' } as const;

/** The site's fee on a swap it sends through Jupiter, when one is set up, and the wallet it is paid to. */
export interface JupiterFee { bps: number; wallet: string }

export function howYouEarn(tier: AmmConfigView | null): string[] {
  const first = tier
    ? `Each trade in a public pool pays a ${feeRateText(tier.tradeFeeRate)} fee. ${pctText(feeSplit(tier).lpKeepsPct)} of the trade stays in the pool, and your part is added to your position automatically.`
    : 'Each trade in a pool pays a fee. Part of it stays in the pool, and your part is added to your position automatically.';
  return [first, 'Nothing to claim: you receive it when you remove liquidity.', 'Few trades means small fees.'];
}

export interface VenueEarns {
  /** One line for each way the venue is paid. */
  sources: string[];
  /** Where it goes and who can change the rates; null when no tier was read. */
  where: string | null;
  /** The wallets `where` speaks of, as addresses anyone can check. */
  wallets: { label: string; address: string }[];
}

const VAULT_CAN = 'which needs two signatures and can change the pool rates';

export function howVenueEarns(tier: AmmConfigView | null, jupiter: JupiterFee | null): VenueEarns {
  const swap = jupiter
    ? `${pctText(jupiter.bps / 100)} of a swap sent through Jupiter, where the route allows it.`
    : 'No fee on a swap sent through Jupiter: none is set up.';
  if (!tier) return { sources: ['A cut of each trade in its pools.', 'A fee when a public pool is opened.', swap], where: null, wallets: [] };

  const opening = tier.createPoolFee > 0n ? `${solOf(tier.createPoolFee)} SOL when a public pool is opened.` : 'No fee when a public pool is opened.';
  const sources = [`${pctText(feeSplit(tier).venueTakesPct)} of each trade in a public pool.`, opening, swap];
  const vault = PLATFORM_TREASURY_VAULT.toBase58();
  // The cut is collected by the tier's protocol owner, and its fund part by the fund owner.
  const shared = tier.protocolOwner === vault && (tier.fundFeeRate === 0n || tier.fundOwner === vault);
  const swapElsewhere = jupiter !== null && jupiter.wallet !== tier.protocolOwner;
  const swapWallet = swapElsewhere ? [{ label: 'Swap fee wallet', address: jupiter.wallet }] : [];
  if (!shared) {
    return {
      sources,
      where: `The cut of each trade goes to the wallet this fee tier names. The team’s shared wallet, ${VAULT_CAN}, is the program’s admin.`,
      wallets: [{ label: 'Wallet this fee tier names', address: tier.protocolOwner }, ...swapWallet],
    };
  }
  return {
    sources,
    where: swapElsewhere
      ? `The pool fees go to the team’s shared wallet, ${VAULT_CAN}. The swap fee goes to its own wallet.`
      : `It goes to the team’s shared wallet, ${VAULT_CAN}.`,
    wallets: [{ label: 'Team’s shared wallet', address: tier.protocolOwner }, ...swapWallet],
  };
}
