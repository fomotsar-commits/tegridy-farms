import { PLATFORM_TREASURY_VAULT } from '../../launcher/solana/curve/program';
import { WORKSHOP_WALLET } from '../../launcher/solana/write/plant';
import { perMillionPercent } from './feeText';
import type { AmmConfigView } from './program';

/**
 * Where a range pool's venue cut goes, said the way the /solana-lp Rates card says it for
 * our other pools (lp/earnCopy.ts `howVenueEarns`). Every figure and both wallets are the
 * fee tier's own, as read: the protocol part is collected by the tier's `owner`, the fund
 * part by its `fundOwner`. The island's split (the vault's part and the Workshop's) is
 * named plainly; any other wallet is `elsewhere`, said in bold and in plain sight
 * (owner, 2026-10-10).
 */

export interface RangeVenueEarns {
  /** "16% of each swap's fee (0.16% of the swap)". */
  cut: string;
  /** Where it goes, in one sentence. */
  where: string;
  /** The wallets `where` speaks of, as addresses anyone can check. */
  wallets: { label: string; address: string }[];
  /** True when the cut reaches a wallet that is neither the team's shared wallet nor the island's Workshop. */
  elsewhere: boolean;
}

const VAULT_CAN = 'which needs two signatures and can change the pool rates';
const VAULT_LABEL = 'Team’s shared wallet';
const WORKSHOP_LABEL = 'Island’s Workshop';

export function rangeVenueEarns(t: Pick<AmmConfigView, 'tradeFeeRate' | 'protocolFeeRate' | 'fundFeeRate' | 'owner' | 'fundOwner'>): RangeVenueEarns {
  const venue = t.protocolFeeRate + t.fundFeeRate;
  const cut = `${perMillionPercent(venue)} of each swap’s fee (${perMillionPercent((t.tradeFeeRate * venue) / 1_000_000)} of the swap)`;
  const vault = PLATFORM_TREASURY_VAULT.toBase58();
  const workshop = WORKSHOP_WALLET.toBase58();
  const protocolHome = t.protocolFeeRate === 0 || t.owner === vault;
  if (protocolHome && t.fundFeeRate > 0 && t.fundOwner === workshop) {
    const island = Math.round((t.fundFeeRate * 100) / venue);
    return {
      cut,
      where: `The venue’s cut is split: ${100 - island}% to the team’s shared wallet, ${VAULT_CAN}, and ${island}% to the island’s Workshop, the island’s agreed share.`,
      wallets: [
        ...(t.protocolFeeRate > 0 ? [{ label: VAULT_LABEL, address: vault }] : []),
        { label: WORKSHOP_LABEL, address: workshop },
      ],
      elsewhere: false,
    };
  }
  if (protocolHome && (t.fundFeeRate === 0 || t.fundOwner === vault)) {
    return { cut, where: `It goes to the team’s shared wallet, ${VAULT_CAN}.`, wallets: [{ label: VAULT_LABEL, address: vault }], elsewhere: false };
  }
  // Only the parts that miss the agreed split, by the wallet that collects each.
  const strays = [
    ...(t.protocolFeeRate > 0 && t.owner !== vault ? [{ part: 'the team’s part', address: t.owner }] : []),
    ...(t.fundFeeRate > 0 && t.fundOwner !== workshop && t.fundOwner !== vault ? [{ part: 'the island’s part', address: t.fundOwner }] : []),
  ];
  return {
    cut,
    where: `Part of the venue’s cut of each swap goes somewhere other than the agreed split (the team’s shared wallet and the island’s Workshop): ${strays.map((x) => x.part).join(' and ')}, to the ${strays.length === 1 ? 'wallet' : 'wallets'} below, named by this fee tier.`,
    wallets: strays.map((x) => ({ label: `Collects ${x.part}`, address: x.address })),
    elsewhere: true,
  };
}
