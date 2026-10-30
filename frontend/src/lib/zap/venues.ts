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
import type { LpFarmDeposit } from '../lpEmissions';

/** Venues this build knows how to compose. */
export type ZapVenueId = 'staking-lock' | 'lp-farm';

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

/**
 * Every venue with its live availability, in menu order.
 *
 * The LP farm needs three contracts, not one: the router that mints the LP, the LP token
 * itself, and the farm that takes it. Reporting it available on the strength of the farm
 * alone would offer a zap whose middle leg has nowhere to go.
 */
export function zapVenues(lpFarm?: LpFarmDeposit): ZapVenueAvailability[] {
  return [venueAvailability('staking-lock'), venueAvailability('lp-farm', lpFarm)];
}

/**
 * `lpFarm` is the farm's reward-period read (useLpFarmDeposit). The panel and
 * useZapPlan pass it, so the LP farm is not offered once its rewards have ended or
 * while that is unread. The pure planner omits it: it runs after useZapPlan's check.
 */
export function venueAvailability(id: ZapVenueId, lpFarm?: LpFarmDeposit): ZapVenueAvailability {
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

  const venue = LP_FARM;
  const missing: string[] = [];
  if (!isDeployed(TEGRIDY_ROUTER_ADDRESS)) missing.push('the Tegridy router that mints the LP');
  if (!isDeployed(TEGRIDY_LP_ADDRESS)) missing.push('the TOWELI/ETH LP token');
  if (!isDeployed(venue.target)) missing.push('the LP farm');
  if (missing.length > 0) {
    return {
      available: false,
      id,
      label: venue.label,
      reason: `This build has no address for ${missing.join(', ')}.`,
    };
  }
  if (id === 'lp-farm' && lpFarm && !lpFarm.open) {
    return { available: false, id, label: venue.label, reason: lpFarm.line };
  }
  return { available: true, venue };
}

/** The venue record, or null when it is not available. Callers must handle null. */
export function zapVenue(id: ZapVenueId): ZapVenue | null {
  const a = venueAvailability(id);
  return a.available ? a.venue : null;
}
