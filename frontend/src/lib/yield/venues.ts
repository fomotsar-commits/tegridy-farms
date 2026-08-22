// The external positions this venue is willing to point a depositor at.
//
// Tegridy ISSUES NOTHING on this surface. Every row is somebody else's protocol,
// somebody else's audit history and somebody else's balance sheet, so each entry
// carries the counterparty by name and the specific way the position loses money.
// A depositor who cannot say whose risk they took has not been told.
//
// Availability is READ from the table, never assumed. `depositTarget` is the zero
// address on every row in this build and `venueAvailability` reports that as
// unroutable with the reason attached — the same gate zap/venues.ts uses for the
// undeployed compounder. The consequence is deliberate and load-bearing: this
// surface COMPARES today and routes only after an operator wires an address, so a
// row can never offer a destination the next screen has to take back.
//
// Nothing here accepts an address from a caller, a query string or a feed
// response. A yield feed can move a NUMBER on a row; it can never move where the
// money goes.

import { isDeployed } from '../constants';

export type YieldVenueKind =
  /** Liquid staking token: one validator set, one issuer, redeemable for the reference asset. */
  | 'lst'
  /** Liquid restaking token: an LST plus AVS slashing conditions the LST does not carry. */
  | 'lrt'
  /** A third-party lending market paying a borrow-driven rate on a stablecoin. */
  | 'stable-lending';

export interface YieldVenue {
  /** Stable key. It is what a feed document is keyed by, so renaming one blinds a row. */
  id: string;
  kind: YieldVenueKind;
  label: string;
  /** Position/receipt token ticker, used verbatim in column headers. */
  symbol: string;
  /** The party that can change this position's terms without asking the holder. */
  issuer: string;
  /**
   * What the peg column is measured AGAINST.
   *
   * Recorded per row because the reference is not obvious from the ticker: an LRT
   * trades against ETH, an interest-bearing stable position against USD, and a
   * column that mixed the two would compare numbers that are not the same number.
   */
  pegReference: 'ETH' | 'USD';
  /** Whose solvency the depositor is trusting. Rendered verbatim, never summarised. */
  counterparty: string;
  /**
   * The specific loss mode. Never a score, a grade, a star rating or a colour —
   * those compress exactly the detail a depositor needs and imply a comparison
   * this venue is in no position to make.
   */
  riskNote: string;
  /** Where a deposit would land. Zero on every row here; the gate, not a placeholder. */
  depositTarget: `0x${string}`;
}

/**
 * Unwired destination.
 *
 * Written once and shared so no row can be given a live address by editing a
 * single line — wiring one is a deliberate act that has to touch this constant's
 * usage and answer `venues.test.ts`, which pins the whole table as unroutable.
 */
const UNWIRED = '0x0000000000000000000000000000000000000000' as const;

const VENUES: readonly YieldVenue[] = [
  {
    id: 'lido-steth',
    kind: 'lst',
    label: 'Lido — staked ETH',
    symbol: 'stETH',
    issuer: 'Lido DAO',
    pegReference: 'ETH',
    counterparty: 'Lido DAO, its node-operator set, and the withdrawal queue that decides when stETH becomes ETH.',
    riskNote:
      'Validator slashing and operator downtime cut the underlying balance. Exit is the beacon-chain withdrawal queue, so the market price is the only fast exit and it has traded below ETH before.',
    depositTarget: UNWIRED,
  },
  {
    id: 'rocketpool-reth',
    kind: 'lst',
    label: 'Rocket Pool — staked ETH',
    symbol: 'rETH',
    issuer: 'Rocket Pool protocol',
    pegReference: 'ETH',
    counterparty: 'Rocket Pool’s smart contracts and its permissionless node operators, who post RPL collateral rather than a name.',
    riskNote:
      'A rate that only rises does not mean a price that only rises: rETH is redeemed against a protocol-held ETH balance, and secondary-market price can sit under that rate when the deposit pool is empty.',
    depositTarget: UNWIRED,
  },
  {
    id: 'coinbase-cbeth',
    kind: 'lst',
    label: 'Coinbase — staked ETH',
    symbol: 'cbETH',
    issuer: 'Coinbase',
    pegReference: 'ETH',
    counterparty: 'Coinbase, a centralised custodian — an issuer with an off-chain balance sheet and a regulator.',
    riskNote:
      'The wrapper is on-chain; the validators and the redemption promise are not. Custodial and jurisdictional failure modes apply here that do not apply to the permissionless rows above.',
    depositTarget: UNWIRED,
  },
  {
    id: 'etherfi-weeth',
    kind: 'lrt',
    label: 'ether.fi — restaked ETH',
    symbol: 'weETH',
    issuer: 'ether.fi',
    pegReference: 'ETH',
    counterparty: 'ether.fi, plus every EigenLayer AVS its operators have opted into — a list the holder does not choose.',
    riskNote:
      'Restaking stacks a second slashing surface on top of validator slashing, and the AVS set can change after you deposit. Withdrawal passes through both the AVS unbonding delay and the beacon-chain queue.',
    depositTarget: UNWIRED,
  },
  {
    id: 'renzo-ezeth',
    kind: 'lrt',
    label: 'Renzo — restaked ETH',
    symbol: 'ezETH',
    issuer: 'Renzo protocol',
    pegReference: 'ETH',
    counterparty: 'Renzo and the AVS operators it delegates to.',
    riskNote:
      'An LRT whose fast exit is a single concentrated pool depegs when that pool is drained, independently of anything happening to the underlying stake. This has happened to this asset class before.',
    depositTarget: UNWIRED,
  },
  {
    id: 'aave-v3-usdc',
    kind: 'stable-lending',
    label: 'Aave v3 — USDC market',
    symbol: 'aEthUSDC',
    issuer: 'Aave DAO',
    pegReference: 'USD',
    counterparty: 'Aave DAO governance, the risk parameters it sets, and Circle as the issuer of the underlying USDC.',
    riskNote:
      'The rate is paid by borrowers, so it moves with utilisation and is not a promise. At full utilisation withdrawal waits for a repayment; bad debt from a collateral crash is socialised across suppliers.',
    depositTarget: UNWIRED,
  },
  {
    id: 'compound-v3-usdc',
    kind: 'stable-lending',
    label: 'Compound v3 — USDC market',
    symbol: 'cUSDCv3',
    issuer: 'Compound DAO',
    pegReference: 'USD',
    counterparty: 'Compound DAO governance and Circle as the issuer of the underlying USDC.',
    riskNote:
      'A single-borrowable market: suppliers are exposed to the collateral set governance admits, not to a basket they picked. Same utilisation-driven withdrawal limit as any lending market.',
    depositTarget: UNWIRED,
  },
  {
    id: 'sky-susds',
    kind: 'stable-lending',
    label: 'Sky — savings USDS',
    symbol: 'sUSDS',
    issuer: 'Sky (formerly MakerDAO)',
    pegReference: 'USD',
    counterparty: 'Sky governance, which sets the savings rate by vote and can lower it the same way.',
    riskNote:
      'The rate is a governance parameter rather than a market outcome, so it can be cut at a vote’s notice. The underlying USDS is backed by Sky’s collateral book, including real-world-asset exposure the holder cannot inspect on-chain.',
    depositTarget: UNWIRED,
  },
];

/** The catalogue, optionally narrowed to one kind. Order is display order. */
export function yieldVenues(kind?: YieldVenueKind | readonly YieldVenueKind[]): readonly YieldVenue[] {
  if (kind === undefined) return VENUES;
  const kinds = typeof kind === 'string' ? [kind] : kind;
  return VENUES.filter((v) => kinds.includes(v.kind));
}

export function yieldVenue(id: string): YieldVenue | null {
  return VENUES.find((v) => v.id === id) ?? null;
}

export type YieldVenueAvailability =
  | { routable: true; venue: YieldVenue }
  | { routable: false; venue: YieldVenue; reason: string };

/**
 * Whether a deposit can actually be sent here.
 *
 * The false branch keeps the venue attached rather than collapsing to an id: the
 * row still renders its counterparty and its risk note, because a comparison
 * nobody can act on is still worth reading and pretending the row does not exist
 * would be its own kind of dishonesty.
 */
export function yieldVenueAvailability(id: string): YieldVenueAvailability | null {
  const venue = yieldVenue(id);
  if (venue === null) return null;
  if (!isDeployed(venue.depositTarget)) {
    return {
      routable: false,
      venue,
      reason:
        `This build carries no deposit address for ${venue.label}, so the row is a comparison only — ` +
        'nothing can be routed into it from here.',
    };
  }
  return { routable: true, venue };
}

/** Venues a deposit could actually reach. Empty in this build, by construction. */
export function routableYieldVenues(kind?: YieldVenueKind | readonly YieldVenueKind[]): readonly YieldVenue[] {
  return yieldVenues(kind).filter((v) => isDeployed(v.depositTarget));
}

/**
 * Drives the nav pill.
 *
 * The pill answers one question — can I do the thing this entry names? — and
 * routing is the thing it names, so the pill is keyed to this and not to whether
 * a feed happens to be configured. A configured feed with no wired destination is
 * a working comparison table, not a working router.
 */
export function hasRoutableYieldVenue(): boolean {
  return routableYieldVenues().length > 0;
}
