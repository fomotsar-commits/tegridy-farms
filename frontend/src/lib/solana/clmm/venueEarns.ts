import { PLATFORM_TREASURY_VAULT } from '../../launcher/solana/curve/program';
import { WORKSHOP_WALLET } from '../../launcher/solana/write/plant';
import { perMillionPercent } from './feeText';
import type { AmmConfigView } from './program';

/**
 * Where a range pool's venue cut goes, by the wallet that ACTUALLY collects each part: the
 * tier's `owner` takes the protocol part, its `fundOwner` the fund part. The agreed split
 * (owner, 2026-10-20): of each fee, 10.4% to the team's shared wallet and 5.6% to the
 * island's Workshop. Anything else, other wallets or other rates, is `elsewhere`, said in
 * bold in plain sight (owner, 2026-10-10). The position link (api/_lib/position.js) agrees.
 */

export const AGREED_PROTOCOL_RATE = 104_000;
export const AGREED_FUND_RATE = 56_000;

export interface RangeVenueEarns {
  /** "16% of each swap's fee (0.16% of the swap)". */
  cut: string;
  /** Where it goes, in one sentence. */
  where: string;
  /** The wallets that collect a part, with what each collects, as addresses anyone can check. */
  wallets: { label: string; address: string }[];
  /** True when the cut is anything but the agreed split. */
  elsewhere: boolean;
}

const VAULT_CAN = 'which needs two signatures and can change the pool rates';

type Tier = Pick<AmmConfigView, 'tradeFeeRate' | 'protocolFeeRate' | 'fundFeeRate' | 'owner' | 'fundOwner'>;

export function rangeVenueEarns(t: Tier): RangeVenueEarns {
  const vault = PLATFORM_TREASURY_VAULT.toBase58();
  const workshop = WORKSHOP_WALLET.toBase58();
  const venue = t.protocolFeeRate + t.fundFeeRate;
  const ofSwap = (rate: number) => perMillionPercent((t.tradeFeeRate * rate) / 1_000_000);
  const cut = `${perMillionPercent(venue)} of each swap’s fee (${ofSwap(venue)} of the swap)`;
  // Each wallet's take, the team's and the Workshop's always listed (at 0 when they get nothing).
  const take = new Map<string, number>([[vault, 0], [workshop, 0]]);
  take.set(t.owner, (take.get(t.owner) ?? 0) + t.protocolFeeRate);
  take.set(t.fundOwner, (take.get(t.fundOwner) ?? 0) + t.fundFeeRate);
  const name = (a: string) => (a === vault ? 'the team’s shared wallet' : a === workshop ? 'the island’s Workshop' : 'another wallet');
  const label = (a: string) => (a === vault ? 'Team’s shared wallet' : a === workshop ? 'Island’s Workshop' : 'Another wallet');
  const share = (rate: number) => `${perMillionPercent(rate)} of each fee (${ofSwap(rate)} of the swap)`;
  const agreed = t.owner === vault && t.fundOwner === workshop && t.protocolFeeRate === AGREED_PROTOCOL_RATE && t.fundFeeRate === AGREED_FUND_RATE;
  if (agreed) {
    return {
      cut,
      where: `The venue’s cut is split: ${share(t.protocolFeeRate)} to the team’s shared wallet, ${VAULT_CAN}, and ${share(t.fundFeeRate)} to the island’s Workshop, the island’s agreed share.`,
      wallets: [
        { label: label(vault), address: vault },
        { label: label(workshop), address: workshop },
      ],
      elsewhere: false,
    };
  }
  const takes = [...take].filter(([a, rate]) => rate > 0 || a === vault || a === workshop);
  return {
    cut,
    where: `The venue’s cut does not follow the agreed split (10.4% of each fee to the team’s shared wallet and 5.6% to the island’s Workshop). As this fee tier stands: ${takes.map(([a, rate]) => `${share(rate)} to ${name(a)}`).join(', ')}.`,
    wallets: takes.filter(([, rate]) => rate > 0).map(([a, rate]) => ({ label: `${label(a)}, ${share(rate)}`, address: a })),
    elsewhere: true,
  };
}
