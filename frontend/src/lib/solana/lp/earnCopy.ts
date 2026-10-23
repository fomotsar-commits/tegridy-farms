import { PLATFORM_TREASURY_VAULT } from '../../launcher/solana/curve/program';
import { WORKSHOP_WALLET } from '../../launcher/solana/write/plant';
import { FEE_RATE_DENOMINATOR } from '../cpswap/math';
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

/**
 * The split agreed with the island (2026-10-18), per fee tier index, per million of the
 * trade fee: the protocol part to the team's shared wallet, the fund part to the island's
 * Workshop. Squads #13 set both tiers this way on 2026-10-19. A tier with no row has none.
 */
export const AGREED_SPLIT: Readonly<Record<number, { protocol: bigint; fund: bigint }>> = {
  0: { protocol: 130_000n, fund: 70_000n },
  1: { protocol: 104_000n, fund: 56_000n },
};

export interface VenueEarns {
  /** One line for each way the venue is paid. */
  sources: string[];
  /** Where each part of the cut goes; null when no tier was read. */
  where: string | null;
  /** The wallets `where` speaks of, as addresses anyone can check. */
  wallets: { label: string; address: string }[];
  /**
   * True when the tier's cut is anything but the agreed split: another wallet, the vault
   * keeping the island's part, or other rates. Said in plain sight, in bold, never folded
   * (owner, 2026-10-10).
   */
  elsewhere: boolean;
}

const VAULT_CAN = 'which needs two signatures and can change the pool rates';
const VAULT_LABEL = 'Team’s shared wallet';
const WORKSHOP_LABEL = 'Island’s Workshop';

export function howVenueEarns(tier: AmmConfigView | null, jupiter: JupiterFee | null): VenueEarns {
  const swap = jupiter
    ? `${pctText(jupiter.bps / 100)} of a swap sent through Jupiter, where the route allows it.`
    : 'No fee on a swap sent through Jupiter: none is set up.';
  if (!tier) return { sources: ['A cut of each trade in its pools.', 'A fee when a public pool is opened.', swap], where: null, wallets: [], elsewhere: false };

  const opening = tier.createPoolFee > 0n ? `${solOf(tier.createPoolFee)} SOL when a public pool is opened.` : 'No fee when a public pool is opened.';
  const sources = [`${pctText(feeSplit(tier).venueTakesPct)} of each trade in a public pool.`, opening, swap];
  const vault = PLATFORM_TREASURY_VAULT.toBase58();
  const workshop = WORKSHOP_WALLET.toBase58();
  // Each part follows the wallet that collects it (protocol owner, fund owner), summed when one
  // wallet is both. The vault and the Workshop are always listed; another wallet only if paid.
  const take = new Map<string, bigint>([[vault, 0n], [workshop, 0n]]);
  take.set(tier.protocolOwner, (take.get(tier.protocolOwner) ?? 0n) + tier.protocolFeeRate);
  take.set(tier.fundOwner, (take.get(tier.fundOwner) ?? 0n) + tier.fundFeeRate);
  const takes = [...take].filter(([a, rate]) => rate > 0n || a === vault || a === workshop);
  const ofTrade = (rate: bigint) => pctText(Number(tier.tradeFeeRate * rate) / Number(10_000n * FEE_RATE_DENOMINATOR));
  const share = (rate: bigint) => `${feeRateText(rate)} (${ofTrade(rate)} of the trade)`;
  const name = (a: string) => (a === vault ? 'the team’s shared wallet' : a === workshop ? 'the island’s Workshop' : 'another wallet');
  const label = (a: string) => (a === vault ? VAULT_LABEL : a === workshop ? WORKSHOP_LABEL : 'Another wallet');
  const agreed = AGREED_SPLIT[tier.index];
  const isAgreed =
    agreed !== undefined &&
    tier.protocolOwner === vault &&
    tier.fundOwner === workshop &&
    tier.protocolFeeRate === agreed.protocol &&
    tier.fundFeeRate === agreed.fund;
  const wallets: VenueEarns['wallets'] = takes.map(([a, rate]) => ({
    label: isAgreed || rate === 0n ? label(a) : `${label(a)}, ${feeRateText(rate)} of each trade’s fee`,
    address: a,
  }));
  let swapTo = '';
  if (jupiter) {
    const paid = wallets.find((w) => w.address === jupiter.wallet);
    if (jupiter.wallet === vault) swapTo = ' The swap fee goes to the team’s shared wallet.';
    else if (paid) paid.label = `${paid.label}, and swap fee wallet`;
    else {
      wallets.push({ label: 'Swap fee wallet', address: jupiter.wallet });
      swapTo = ' The swap fee goes to its own wallet.';
    }
  }
  if (isAgreed) {
    const where = `Of each trade’s fee, ${share(tier.protocolFeeRate)} goes to the team’s shared wallet, ${VAULT_CAN}, and ${share(tier.fundFeeRate)} to the island’s Workshop, the island’s agreed share.`;
    return { sources, where: `${where}${swapTo}`, wallets, elsewhere: false };
  }
  const head = agreed
    ? `The venue’s cut does not follow the agreed split (${feeRateText(agreed.protocol)} of each trade’s fee to the team’s shared wallet, ${feeRateText(agreed.fund)} to the island’s Workshop).`
    : 'This fee tier has no split agreed with the island.';
  const parts = takes.map(([a, rate]) => `${rate > 0n ? share(rate) : 'nothing'} to ${name(a)}`);
  const sends = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return { sources, where: `${head} Of each trade’s fee, this tier sends ${sends}.${swapTo}`, wallets, elsewhere: true };
}
