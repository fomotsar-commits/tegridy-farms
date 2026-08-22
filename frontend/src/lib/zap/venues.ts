// The positions a zap is allowed to land in.
//
// A venue is a DESTINATION, not a route. Every one of them is an already-audited
// contract at an address this repo hard-codes; nothing here accepts an address from
// the caller, from a query string, or from a quote response. That is the whole
// compliance story for docs/USER_VALUE_ROADMAP.md line 101 (no custom zap router,
// after OpenZeppelin found a CRITICAL arbitrary-call drain in exactly that pattern):
// there is no contract to drain because there is no contract, and the client can only
// point at this table.
//
// Availability is READ, never assumed. A venue whose contracts are still zero in
// constants.ts reports unavailable with the reason attached, because an unreachable
// destination offered as a choice is a promise the next screen has to break.

import {
  LP_FARMING_ADDRESS,
  TEGRIDY_LP_ADDRESS,
  TEGRIDY_ROUTER_ADDRESS,
  TEGRIDY_STAKING_ADDRESS,
  TOWELI_ADDRESS,
  isDeployed,
} from '../constants';

/**
 * The ERC-4626 auto-compounder, zero-address-gated until an operator deploys it.
 *
 * `contracts/src/vaults/TegridyHarvestVault.sol` exists and is tested; nothing has been
 * deployed and `src/lib/constants.ts` carries no address for it. This constant is the gate,
 * and it lives here rather than in constants.ts only because that file is not this slice's
 * to edit — `venues.test.ts` fails the moment constants.ts gains the canonical constant, so
 * the duplicate is caught and deleted rather than left to drift.
 *
 * The vault takes the SAME asset the farm does (its constructor asserts
 * `farm.stakingToken() == asset`), so a zap into it is the LP-farm plan with a different
 * final destination. Filling in a deployed address is the entire activation step.
 */
export const HARVEST_VAULT_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/** Venues this build knows how to compose. */
export type ZapVenueId = 'staking-lock' | 'lp-farm' | 'compounder-vault';

export interface ZapVenue {
  id: ZapVenueId;
  label: string;
  /** What the user holds when the whole zap has landed. Used verbatim in receipts. */
  positionLabel: string;
  /** The contract the finished position lives in. */
  target: `0x${string}`;
  /** The asset the last leg deposits. */
  depositAsset: `0x${string}`;
}

export type ZapVenueAvailability =
  | { available: true; venue: ZapVenue }
  | { available: false; id: ZapVenueId; label: string; reason: string };

const STAKING_LOCK: ZapVenue = {
  id: 'staking-lock',
  label: 'TOWELI staking lock',
  positionLabel: 'a locked TOWELI staking position',
  target: TEGRIDY_STAKING_ADDRESS,
  depositAsset: TOWELI_ADDRESS,
};

const LP_FARM: ZapVenue = {
  id: 'lp-farm',
  label: 'TOWELI/ETH LP farm',
  positionLabel: 'TOWELI/ETH LP staked in the farm',
  target: LP_FARMING_ADDRESS,
  depositAsset: TEGRIDY_LP_ADDRESS,
};

const COMPOUNDER_VAULT: ZapVenue = {
  id: 'compounder-vault',
  label: 'Auto-compounding LP vault',
  positionLabel: 'shares in the auto-compounding LP vault',
  target: HARVEST_VAULT_ADDRESS,
  depositAsset: TEGRIDY_LP_ADDRESS,
};

/**
 * Every venue with its live availability, in menu order.
 *
 * The LP-shaped venues need three contracts, not one: the router that mints the LP, the LP
 * token itself, and the destination that takes it. Reporting one available on the strength
 * of its destination alone would offer a zap whose middle leg has nowhere to go.
 */
export function zapVenues(): ZapVenueAvailability[] {
  return [venueAvailability('staking-lock'), venueAvailability('lp-farm'), venueAvailability('compounder-vault')];
}

export function venueAvailability(id: ZapVenueId): ZapVenueAvailability {
  if (id === 'staking-lock') {
    if (!isDeployed(TEGRIDY_STAKING_ADDRESS)) {
      return {
        available: false,
        id,
        label: STAKING_LOCK.label,
        reason: 'TegridyStaking has no address in this build, so there is no lock to deposit into.',
      };
    }
    if (!isDeployed(TOWELI_ADDRESS)) {
      return {
        available: false,
        id,
        label: STAKING_LOCK.label,
        reason: 'TOWELI has no address in this build, so the swap leg has no destination token.',
      };
    }
    return { available: true, venue: STAKING_LOCK };
  }

  const venue = id === 'lp-farm' ? LP_FARM : COMPOUNDER_VAULT;
  const missing: string[] = [];
  if (!isDeployed(TEGRIDY_ROUTER_ADDRESS)) missing.push('the Tegridy router that mints the LP');
  if (!isDeployed(TEGRIDY_LP_ADDRESS)) missing.push('the TOWELI/ETH LP token');
  if (!isDeployed(venue.target)) {
    missing.push(id === 'lp-farm' ? 'the LP farm' : 'the auto-compounding vault (not deployed yet)');
  }
  if (missing.length > 0) {
    return {
      available: false,
      id,
      label: venue.label,
      reason: `This build has no address for ${missing.join(', ')}.`,
    };
  }
  return { available: true, venue };
}

/** The venue record, or null when it is not available. Callers must handle null. */
export function zapVenue(id: ZapVenueId): ZapVenue | null {
  const a = venueAvailability(id);
  return a.available ? a.venue : null;
}
