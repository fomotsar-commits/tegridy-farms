// Which borrow positions this deployment can actually see, and — more important —
// which it cannot.
//
// The failure this file exists to prevent is a user reading a green shield panel
// and concluding their Aave position is covered. It is not. No adapter for any
// external money market is built here, so every external venue is `readable:
// false` with the reason attached, and the panel says so instead of listing
// nothing and letting an empty list imply "you have no external debt".
//
// The venues also differ in WHAT liquidates, and conflating the two mechanisms
// would produce a number nothing on-chain acts on:
//
//   deadline-default      the venue's NFT loans, on Gondi's v3.2 loan contract.
//                         Fixed term. There is no price oracle, no LTV, no partial
//                         liquidation and no grace period. The lender claims the
//                         whole collateral NFT once the deadline passes,
//                         regardless of what the collateral is worth. A "health
//                         factor" for one of these is fiction.
//
//   price-health-factor   Aave/Morpho-shaped. Collateral value against debt,
//                         liquidated with a penalty on a bounded slice. Nothing
//                         here reads one today.
//
// The loan contract's address is `GONDI_LOAN_ADDRESS` (lib/gondi/loanOffer.js), zero until
// the deploy. Nothing in this module hardcodes a third-party market address: an address that
// is wired but unreadable is worse than one that is absent, because it looks like coverage.

import { isDeployed } from '../constants';
import { GONDI_LOAN_ADDRESS } from '../gondi/loanOffer.js';

export type ShieldVenueId = 'tegridy-nft-lending' | 'aave-v3' | 'morpho-blue';

export type LiquidationMechanism = 'deadline-default' | 'price-health-factor';

export interface ShieldVenue {
  id: ShieldVenueId;
  label: string;
  mechanism: LiquidationMechanism;
  /** What the borrower loses when the mechanism fires. Rendered verbatim. */
  lossOnTrigger: string;
  /** What has to happen before this venue can be read here. */
  operatorStep: string;
}

export const SHIELD_VENUES: Record<ShieldVenueId, ShieldVenue> = {
  'tegridy-nft-lending': {
    id: 'tegridy-nft-lending',
    label: 'Venue NFT lending',
    mechanism: 'deadline-default',
    lossOnTrigger:
      'The lender claims the entire collateral NFT. There is no partial liquidation and no penalty percentage — the whole item is gone, and the borrowed ETH stays borrowed.',
    operatorStep:
      'Loans are listed from the venue’s offer book, and each one is checked against Gondi’s loan contract on chain before it is shown.',
  },
  'aave-v3': {
    id: 'aave-v3',
    label: 'Aave v3',
    mechanism: 'price-health-factor',
    lossOnTrigger:
      'A liquidator repays part of the debt and takes collateral plus the market’s liquidation bonus.',
    operatorStep:
      'No Aave adapter is built here. Reading a health factor needs the pool’s user-account data and each reserve’s liquidation threshold, plus the oracle staleness rules that decide when that reading may be trusted. None of that exists in this app, so an Aave position is invisible to this surface.',
  },
  'morpho-blue': {
    id: 'morpho-blue',
    label: 'Morpho Blue',
    mechanism: 'price-health-factor',
    lossOnTrigger:
      'A liquidator repays part of the debt and seizes collateral at the market’s liquidation incentive.',
    operatorStep:
      'No Morpho adapter is built here. Reading a position needs the market id, the market’s LLTV and its oracle, none of which this app resolves, so a Morpho position is invisible to this surface.',
  },
};

export const SHIELD_VENUE_IDS: readonly ShieldVenueId[] = [
  'tegridy-nft-lending',
  'aave-v3',
  'morpho-blue',
];

/**
 * Venues whose reads are implemented in this app at all. This is separate from
 * whether a contract is deployed: a deployed market with no adapter is exactly as
 * unreadable as an undeployed one, and pretending otherwise is how a surface ends
 * up claiming coverage it does not have.
 */
export const ADAPTER_BUILT: Record<ShieldVenueId, boolean> = {
  'tegridy-nft-lending': true,
  'aave-v3': false,
  'morpho-blue': false,
};

export interface ShieldVenueReadiness {
  /** A read would go to something real AND this app knows how to read it. */
  readable: boolean;
  /** Non-null exactly when `readable` is false. Plain language, rendered as-is. */
  detail: string | null;
  /** The contract this venue would be read from, or null when there is none. */
  address: string | null;
}

/**
 * Read the live config. A function rather than a module constant so nothing
 * snapshots a deployment decision at import time — same rule as
 * `indexer/client.ts` and `alerts/sources.ts`.
 */
export function shieldVenueReadiness(): Record<ShieldVenueId, ShieldVenueReadiness> {
  const deployed = isDeployed(GONDI_LOAN_ADDRESS);
  const readable = ADAPTER_BUILT['tegridy-nft-lending'] && deployed;
  return {
    'tegridy-nft-lending': {
      readable,
      detail: readable ? null : 'Gondi’s loan contract is not deployed on this network yet, so there are no loans to read.',
      address: deployed ? GONDI_LOAN_ADDRESS : null,
    },
    'aave-v3': {
      readable: false,
      detail: SHIELD_VENUES['aave-v3'].operatorStep,
      address: null,
    },
    'morpho-blue': {
      readable: false,
      detail: SHIELD_VENUES['morpho-blue'].operatorStep,
      address: null,
    },
  };
}

/** Venue ids this deployment can read. Empty is a legitimate, statable answer. */
export function readableVenues(): ShieldVenueId[] {
  const readiness = shieldVenueReadiness();
  return SHIELD_VENUE_IDS.filter((id) => readiness[id].readable);
}

/** Venue ids this deployment cannot read. Rendered so absence is never implied coverage. */
export function unreadableVenues(): ShieldVenueId[] {
  const readiness = shieldVenueReadiness();
  return SHIELD_VENUE_IDS.filter((id) => !readiness[id].readable);
}
