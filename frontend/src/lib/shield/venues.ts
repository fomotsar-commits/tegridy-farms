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
//   deadline-default      the venue's own P2P loans. Fixed term. There is no price
//                         oracle, no LTV, and no partial liquidation. The lender
//                         claims the whole collateral NFT once the deadline plus
//                         grace passes, regardless of what the collateral is
//                         worth. A "health factor" for one of these is fiction.
//
//   price-health-factor   Aave/Morpho-shaped. Collateral value against debt,
//                         liquidated with a penalty on a bounded slice. Nothing
//                         here reads one today.
//
// Addresses come from `constants.ts` and are zero until an operator deploys.
// Nothing in this module hardcodes a third-party market address: an address that
// is wired but unreadable is worse than one that is absent, because it looks like
// coverage.

import { TEGRIDY_LENDING_ADDRESS, TEGRIDY_NFT_LENDING_ADDRESS, isDeployed } from '../constants';

export type ShieldVenueId = 'tegridy-nft-lending' | 'tegridy-lending' | 'aave-v3' | 'morpho-blue';

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
      'Deployed. Loans are read directly from the contract; no indexer or backend is involved.',
  },
  'tegridy-lending': {
    id: 'tegridy-lending',
    label: 'Venue token lending',
    mechanism: 'deadline-default',
    lossOnTrigger:
      'The lender claims the staking position posted as collateral. There is no partial liquidation and no penalty percentage.',
    operatorStep:
      'Not deployed on this network. TEGRIDY_LENDING_ADDRESS is the zero address, so there is nothing to read and no position of this kind can exist yet.',
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
  'tegridy-lending',
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
  'tegridy-lending': false,
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

const TOKEN_LENDING_NO_ADAPTER =
  'The venue’s token-lending contract is not deployed on this network, so no position of this kind can exist and none is being watched.';

/**
 * Read the live config. A function rather than a module constant so nothing
 * snapshots a deployment decision at import time — same rule as
 * `indexer/client.ts` and `alerts/sources.ts`.
 */
export function shieldVenueReadiness(): Record<ShieldVenueId, ShieldVenueReadiness> {
  const nftDeployed = isDeployed(TEGRIDY_NFT_LENDING_ADDRESS);
  return {
    'tegridy-nft-lending': {
      readable: ADAPTER_BUILT['tegridy-nft-lending'] && nftDeployed,
      detail:
        ADAPTER_BUILT['tegridy-nft-lending'] && nftDeployed
          ? null
          : 'The venue’s NFT lending contract is not deployed on this network, so there are no loans to read.',
      address: nftDeployed ? TEGRIDY_NFT_LENDING_ADDRESS : null,
    },
    'tegridy-lending': {
      readable: false,
      detail: TOKEN_LENDING_NO_ADAPTER,
      address: isDeployed(TEGRIDY_LENDING_ADDRESS) ? TEGRIDY_LENDING_ADDRESS : null,
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
