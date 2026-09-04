// The external positions this venue is willing to point a depositor at.
//
// THE VENUE ISSUES NOTHING ON THIS SURFACE. Every row is somebody else's
// protocol, somebody else's audit history and somebody else's balance sheet, so
// each entry carries the counterparty by name and the specific way the position
// loses money. A depositor who cannot say whose risk they took has not been told.
//
// Availability is READ from the table, never assumed. A row is routable only
// when it carries BOTH a non-zero `depositTarget` and a `route` that names the
// protocol's own permissionless entry function — the same gate zap/venues.ts
// uses for the undeployed compounder, with the second half added because an
// address alone is not a deposit. Rows without one keep their counterparty and
// loss-mode lines and say on the button why they are a comparison only.
//
// Nothing here accepts an address from a caller, a query string, a feed response
// or a live RPC answer. Every address comes from lib/yield/protocols.ts, which
// is the one file in this slice permitted to hold one and the one file
// scripts/verify-yield-protocols.mjs verifies against the chain.
//
import { isDeployed } from '../constants';
import { YIELD_ADDRESSES } from './protocols';

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
  /**
   * Where a deposit lands. Zero on a comparison-only row — the gate, not a
   * placeholder — and otherwise the protocol's own entry point from protocols.ts.
   */
  depositTarget: `0x${string}`;
  /** How a deposit is made here, or why it cannot be. */
  route: YieldRoute;
}

/** The ERC-20 a supply route moves. Decimals are pinned, never read from a prop. */
export interface RouteAsset {
  address: `0x${string}`;
  symbol: 'USDC' | 'USDS';
  decimals: 6 | 18;
}

/**
 * The shape of a deposit.
 *
 * A closed union rather than a bag of optional fields, because every shape here
 * costs the depositor a different number of signatures and the panel has to say
 * so BEFORE the first one. `cta` names the asset that moves and the token that
 * comes back, so the button can never read as a generic "route" into something
 * the visitor has not been told the shape of.
 */
export type YieldRoute =
  /** One signature: send ETH to a payable function that mints the receipt token. */
  | { kind: 'native-payable'; functionName: 'submit' | 'depositETH' | 'deposit'; asset: 'ETH'; cta: string }
  /** Two signatures: an exact-amount approval, then the protocol's supply call. */
  | { kind: 'erc20-supply'; functionName: 'supply' | 'deposit'; asset: RouteAsset; cta: string }
  /** Three signatures: deposit ETH for an intermediate token, approve it, wrap it. */
  | { kind: 'native-then-wrap'; asset: 'ETH'; cta: string }
  /** No deposit path from here. The reason is rendered on the disabled button. */
  | { kind: 'none'; reason: string };

const USDC_ASSET: RouteAsset = { address: YIELD_ADDRESSES.usdc, symbol: 'USDC', decimals: 6 };
const USDS_ASSET: RouteAsset = { address: YIELD_ADDRESSES.USDS, symbol: 'USDS', decimals: 18 };

/**
 * Unwired destination.
 *
 * Written once and shared so no row can be given a live address by editing a
 * single line — wiring one is a deliberate act that has to touch this constant's
 * usage, name a `route`, and answer `venues.test.ts`, which pins the exact list
 * of ids that route and the reason every other row does not.
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
    depositTarget: YIELD_ADDRESSES.stETH,
    route: { kind: 'native-payable', functionName: 'submit', asset: 'ETH', cta: 'Stake ETH with Lido → stETH' },
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
    depositTarget: YIELD_ADDRESSES.rocketDepositPool,
    route: { kind: 'native-payable', functionName: 'deposit', asset: 'ETH', cta: 'Stake ETH with Rocket Pool → rETH' },
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
    route: {
      kind: 'none',
      reason:
        'cbETH is minted only by Coinbase for its own custody customers; no public contract accepts ETH for it, so ' +
        'this row is a comparison only. The wrapper trades on-chain but the mint does not.',
    },
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
    depositTarget: YIELD_ADDRESSES.etherfiLiquidityPool,
    route: { kind: 'native-then-wrap', asset: 'ETH', cta: 'Stake ETH with ether.fi → eETH → weETH' },
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
    depositTarget: YIELD_ADDRESSES.renzoRestakeManager,
    route: { kind: 'native-payable', functionName: 'depositETH', asset: 'ETH', cta: 'Deposit ETH with Renzo → ezETH' },
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
    depositTarget: YIELD_ADDRESSES.aaveV3Pool,
    route: { kind: 'erc20-supply', functionName: 'supply', asset: USDC_ASSET, cta: 'Supply USDC to Aave v3 → aEthUSDC' },
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
    depositTarget: YIELD_ADDRESSES.cUSDCv3,
    route: { kind: 'erc20-supply', functionName: 'supply', asset: USDC_ASSET, cta: 'Supply USDC to Compound v3 → cUSDCv3' },
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
    depositTarget: YIELD_ADDRESSES.sUSDS,
    route: { kind: 'erc20-supply', functionName: 'deposit', asset: USDS_ASSET, cta: 'Deposit USDS → sUSDS' },
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
  // The route is asked FIRST so a row with no deposit path keeps its own
  // sentence. The generic address reason would tell a reader an operator could
  // wire cbETH, and no operator can: the mint does not exist to wire.
  if (venue.route.kind === 'none') {
    return { routable: false, venue, reason: venue.route.reason };
  }
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

/**
 * Venues a deposit could actually reach.
 *
 * BOTH halves are required. An address with no route is a row that would render
 * an enabled button with nothing behind it; a route with no address is a
 * function call to nowhere. The pill reads this, and so does every button, which
 * is what makes it impossible for them to disagree.
 */
export function routableYieldVenues(kind?: YieldVenueKind | readonly YieldVenueKind[]): readonly YieldVenue[] {
  return yieldVenues(kind).filter((v) => v.route.kind !== 'none' && isDeployed(v.depositTarget));
}

/**
 * Drives the nav pill.
 *
 * The pill answers one question — can I do the thing this entry names? — and
 * routing is the thing it names, so it is keyed to this and to nothing else. It
 * depends on no environment variable, no server, no indexer and no stored state,
 * which is the /solana-launch failure it was written to avoid: a flag that
 * cleared before the action worked. `deposit.test.ts` and `surface.test.ts`
 * close the other direction, requiring every venue this counts to produce a
 * ready plan whose final step is addressed to that venue's own depositTarget.
 */
export function hasRoutableYieldVenue(): boolean {
  return routableYieldVenues().length > 0;
}
