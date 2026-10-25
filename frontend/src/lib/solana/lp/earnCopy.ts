import { PLATFORM_TREASURY_VAULT } from '../../launcher/solana/curve/program';
import { WORKSHOP_WALLET } from '../../launcher/solana/write/plant';
import { FEE_RATE_DENOMINATOR } from '../cpswap/math';
import type { AmmConfigView } from '../cpswap/program';
import { feeSplit, solOf } from '../cpswap/venue';
import { feeRateText, pctText } from './format';
import { LOW_TIER_PAIR, forEveryPair } from './tierOffer';

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
  // A tier under 1% is offered for SOL against USDC only (tierOffer.ts), and says so.
  const every = tiers.filter((t) => forEveryPair(t.tradeFeeRate)).map((t) => feeRateText(t.tradeFeeRate));
  const low = tiers.filter((t) => !forEveryPair(t.tradeFeeRate)).map((t) => feeRateText(t.tradeFeeRate));
  const fee =
    every.length === 0 ? `${low.join(' or ')} fee (${LOW_TIER_PAIR} only)` : low.length === 0 ? `${every.join(' or ')} fee` : `${every.join(' or ')} fee (${low.join(' or ')} for ${LOW_TIER_PAIR})`;
  if (tiers.length === 1) {
    return [`Each trade in a public pool pays a ${fee}. ${pctText(feeSplit(one).lpKeepsPct)} of the trade stays in the pool, and your part is added to your position automatically.`, ...rest];
  }
  const stays = tiers.map((t) => `${pctText(feeSplit(t).lpKeepsPct)} (${feeRateText(t.tradeFeeRate)} pool)`).join(' or ');
  return [`Each trade in a public pool pays a ${fee}, by the pool's tier. Of the trade, ${stays} stays in the pool, and your part is added to your position automatically.`, ...rest];
}

/**
 * The split agreed with the island (2026-10-18), per fee tier index, per million of the
 * trade fee: the protocol part to the team's shared wallet, the fund part to the island's
 * Workshop. Squads #13 set tiers 0 and 1 this way on 2026-10-19. Tier 2, the 0.25% public
 * tier, carries tier 1's split (owner, 2026-10-24); it is agreed here before the vault
 * creates it, so a tier 2 created with any other split is said in bold. A tier with no row
 * has none.
 */
export const AGREED_SPLIT: Readonly<Record<number, { protocol: bigint; fund: bigint }>> = {
  0: { protocol: 130_000n, fund: 70_000n },
  1: { protocol: 104_000n, fund: 56_000n },
  2: { protocol: 104_000n, fund: 56_000n },
};

export interface VenueEarns {
  /** One line for each way the venue is paid. */
  sources: string[];
  /** Where each part of the cut goes; null when no tier was read. */
  where: string | null;
  /** The wallets `where` speaks of, as addresses anyone can check. */
  wallets: { label: string; address: string }[];
  /**
   * True when a tier's cut is anything but the agreed split: another wallet, the vault
   * keeping the island's part, or other rates. Said in plain sight, in bold, never folded
   * (owner, 2026-10-10).
   */
  elsewhere: boolean;
}

const VAULT_CAN = 'which needs two signatures and can change the pool rates';
const VAULT_LABEL = 'Team’s shared wallet';
const WORKSHOP_LABEL = 'Island’s Workshop';

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
  const workshop = WORKSHOP_WALLET.toBase58();
  const name = (a: string) => (a === vault ? 'the team’s shared wallet' : a === workshop ? 'the island’s Workshop' : 'another wallet');
  const label = (a: string) => (a === vault ? VAULT_LABEL : a === workshop ? WORKSHOP_LABEL : 'Another wallet');
  const many = tiers.length > 1;
  // Each tier's cut, said as one tier's is; with more than one tier, each is named by its rate.
  const cutsOf = tiers.map((tier) => {
    // Each part follows the wallet that collects it (protocol owner, fund owner), summed when one
    // wallet is both. The vault and the Workshop are always listed; another wallet only if paid.
    const take = new Map<string, bigint>([[vault, 0n], [workshop, 0n]]);
    take.set(tier.protocolOwner, (take.get(tier.protocolOwner) ?? 0n) + tier.protocolFeeRate);
    take.set(tier.fundOwner, (take.get(tier.fundOwner) ?? 0n) + tier.fundFeeRate);
    const takes = [...take].filter(([a, rate]) => rate > 0n || a === vault || a === workshop);
    const ofTrade = (rate: bigint) => pctText(Number(tier.tradeFeeRate * rate) / Number(10_000n * FEE_RATE_DENOMINATOR));
    const share = (rate: bigint) => `${feeRateText(rate)} (${ofTrade(rate)} of the trade)`;
    const agreed = AGREED_SPLIT[tier.index];
    const isAgreed =
      agreed !== undefined &&
      tier.protocolOwner === vault &&
      tier.fundOwner === workshop &&
      tier.protocolFeeRate === agreed.protocol &&
      tier.fundFeeRate === agreed.fund;
    const rate = feeRateText(tier.tradeFeeRate);
    if (isAgreed) {
      const text = (can: string) =>
        `${many ? `In a ${rate} pool, of` : 'Of'} each trade’s fee, ${share(tier.protocolFeeRate)} goes to the team’s shared wallet${can} and ${share(tier.fundFeeRate)} to the island’s Workshop, the island’s agreed share.`;
      return { tier, takes, isAgreed, text };
    }
    const whose = many ? `The ${rate} fee tier’s cut` : 'The venue’s cut';
    const head = agreed
      ? `${whose} does not follow the agreed split (${feeRateText(agreed.protocol)} of each trade’s fee to the team’s shared wallet, ${feeRateText(agreed.fund)} to the island’s Workshop).`
      : `${many ? `The ${rate} fee tier` : 'This fee tier'} has no split agreed with the island.`;
    const parts = takes.map(([a, r]) => `${r > 0n ? share(r) : 'nothing'} to ${name(a)}`);
    const sends = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
    return { tier, takes, isAgreed, text: () => `${head} Of each trade’s fee, this tier sends ${sends}.` };
  });
  const allAgreed = cutsOf.every((c) => c.isAgreed);
  // Every wallet a sentence speaks of, once. One tier off the agreed split labels each wallet
  // with its rate; with more tiers the rates are each tier's, said in its own sentence.
  const wallets: VenueEarns['wallets'] = [];
  for (const c of cutsOf) {
    for (const [a, rate] of c.takes) {
      if (wallets.some((w) => w.address === a)) continue;
      wallets.push({ label: allAgreed || many || rate === 0n ? label(a) : `${label(a)}, ${feeRateText(rate)} of each trade’s fee`, address: a });
    }
  }
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
  // A tier off the agreed split is said first: it is the part said in bold. What the vault
  // can do is said once, at the first agreed tier's mention of it.
  const ordered = [...cutsOf.filter((c) => !c.isAgreed), ...cutsOf.filter((c) => c.isAgreed)];
  const firstAgreed = ordered.find((c) => c.isAgreed);
  const where = ordered.map((c) => c.text(c === firstAgreed ? `, ${VAULT_CAN},` : '')).join(' ');
  return { sources, where: `${where}${swapTo}`, wallets, elsewhere: !allAgreed };
}
