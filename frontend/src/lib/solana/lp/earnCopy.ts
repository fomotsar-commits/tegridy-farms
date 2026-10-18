import { PLATFORM_TREASURY_VAULT } from '../../launcher/solana/curve/program';
import type { AmmConfigView } from '../cpswap/program';
import { feeSplit, solOf } from '../cpswap/venue';
import { feeRateText, pctText } from './format';

/**
 * The LP section's two short blocks: how a liquidity provider earns, and how the venue
 * does. Every pool rate is a public fee tier's as the page just read it; with no tier
 * read, no number is said. With one public tier a pool is "a public pool"; with more,
 * each is named by its rate ("a 1% pool"), read from the tier. The swap fee is the
 * swap's own build setting (lib/solana.ts). A wallet is called the team's shared wallet
 * only when the chain names that vault.
 */

export const EARN_TITLES = { you: 'How you earn', venue: 'How the venue earns' } as const;

/** The site's fee on a swap it sends through Jupiter, when one is set up, and the wallet it is paid to. */
export interface JupiterFee { bps: number; wallet: string }

/** "a public pool" with one tier; "a 1% pool" with more, each by its own read rate. */
export function poolWords(tier: AmmConfigView, tiers: readonly AmmConfigView[]): string {
  return tiers.length > 1 ? `a ${feeRateText(tier.tradeFeeRate)} pool` : 'a public pool';
}

export function howYouEarn(tiers: readonly AmmConfigView[]): string[] {
  const rest = ['Nothing to claim: you receive it when you remove liquidity.', 'Few trades means small fees.'];
  if (tiers.length === 0) return ['Each trade in a pool pays a fee. Part of it stays in the pool, and your part is added to your position automatically.', ...rest];
  const one = tiers[0]!;
  if (tiers.length === 1) {
    return [
      `Each trade in a public pool pays a ${feeRateText(one.tradeFeeRate)} fee. ${pctText(feeSplit(one).lpKeepsPct)} of the trade stays in the pool, and your part is added to your position automatically.`,
      ...rest,
    ];
  }
  const rates = tiers.map((t) => feeRateText(t.tradeFeeRate)).join(' or ');
  const stays = tiers.map((t) => `${pctText(feeSplit(t).lpKeepsPct)} (${feeRateText(t.tradeFeeRate)} pool)`).join(' or ');
  return [`Each trade in a public pool pays a ${rates} fee, by the pool's tier. Of the trade, ${stays} stays in the pool, and your part is added to your position automatically.`, ...rest];
}

export interface VenueEarns {
  /** One line for each way the venue is paid. */
  sources: string[];
  /** Where it goes and who can change the rates; null when no tier was read. */
  where: string | null;
  /** The wallets `where` speaks of, as addresses anyone can check. */
  wallets: { label: string; address: string }[];
  /**
   * True when a tier sends the venue's cut of a trade to a wallet that is not the team's
   * shared wallet. Said in plain sight, in bold, never folded (owner, 2026-10-10).
   */
  elsewhere: boolean;
}

const VAULT_CAN = 'which needs two signatures and can change the pool rates';
const VAULT_LABEL = 'Team’s shared wallet';

export function howVenueEarns(tiers: readonly AmmConfigView[], jupiter: JupiterFee | null): VenueEarns {
  const swap = jupiter
    ? `${pctText(jupiter.bps / 100)} of a swap sent through Jupiter, where the route allows it.`
    : 'No fee on a swap sent through Jupiter: none is set up.';
  if (tiers.length === 0) return { sources: ['A cut of each trade in its pools.', 'A fee when a public pool is opened.', swap], where: null, wallets: [], elsewhere: false };

  const cuts = tiers.map((t) => `${pctText(feeSplit(t).venueTakesPct)} of each trade in ${poolWords(t, tiers)}.`);
  // One opening line when every tier charges the same to open; else one per tier.
  const openingOf = (t: AmmConfigView, words: string) => (t.createPoolFee > 0n ? `${solOf(t.createPoolFee)} SOL when ${words} is opened.` : `No fee when ${words} is opened.`);
  const sameFee = tiers.every((t) => t.createPoolFee === tiers[0]!.createPoolFee);
  const openings = sameFee ? [openingOf(tiers[0]!, 'a public pool')] : tiers.map((t) => openingOf(t, poolWords(t, tiers)));
  const sources = [...cuts, ...openings, swap];
  const vault = PLATFORM_TREASURY_VAULT.toBase58();
  // The cut is collected by each tier's protocol owner, and its fund part (when there is one) by the fund owner.
  const takers = [...new Set(tiers.flatMap((t) => (t.fundFeeRate > 0n ? [t.protocolOwner, t.fundOwner] : [t.protocolOwner])))];
  // Every wallet a sentence speaks of, once; the vault is named as the vault wherever it appears.
  const wallets: VenueEarns['wallets'] = [];
  const show = (label: string, address: string) => {
    if (!wallets.some((w) => w.address === address)) wallets.push({ label: address === vault ? VAULT_LABEL : label, address });
  };
  if (takers.every((a) => a === vault)) {
    show(VAULT_LABEL, vault);
    if (jupiter) show('Swap fee wallet', jupiter.wallet);
    const swapElsewhere = jupiter !== null && jupiter.wallet !== vault;
    return {
      sources,
      where: swapElsewhere
        ? `The pool fees go to the team’s shared wallet, ${VAULT_CAN}. The swap fee goes to its own wallet.`
        : `It goes to the team’s shared wallet, ${VAULT_CAN}.`,
      wallets,
      elsewhere: false,
    };
  }
  // A tier is "this fee tier" when it is the only one; with more, the one that names the wallet is said by its rate.
  const tierWords = (t: AmmConfigView) => (tiers.length > 1 ? `the ${feeRateText(t.tradeFeeRate)} fee tier` : 'this fee tier');
  for (const t of tiers) {
    show(`Wallet ${tierWords(t)} names`, t.protocolOwner);
    if (t.fundFeeRate > 0n) show(`Fund wallet ${tierWords(t)} names`, t.fundOwner);
  }
  show(VAULT_LABEL, vault);
  let swapTo = '';
  if (jupiter) {
    const paid = wallets.find((w) => w.address === jupiter.wallet);
    if (jupiter.wallet === vault) swapTo = ' The swap fee goes to the team’s shared wallet.';
    else if (paid) paid.label = `${paid.label}, and swap fee wallet`;
    else {
      show('Swap fee wallet', jupiter.wallet);
      swapTo = ' The swap fee goes to its own wallet.';
    }
  }
  const elsewhereTiers = tiers.filter((t) => t.protocolOwner !== vault || (t.fundFeeRate > 0n && t.fundOwner !== vault));
  const named =
    tiers.length === 1
      ? takers.length === 1
        ? 'the wallet this fee tier names'
        : 'the two wallets this fee tier names'
      : `the wallet${takers.length === 1 ? '' : 's'} ${elsewhereTiers.map(tierWords).join(' and ')} name${elsewhereTiers.length === 1 ? 's' : ''}`;
  return { sources, where: `The cut of each trade goes to ${named}. The team’s shared wallet, ${VAULT_CAN}, is the program’s admin.${swapTo}`, wallets, elsewhere: true };
}
