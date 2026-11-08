import { UNISWAP_V2_FACTORY, UNISWAP_V2_ROUTER, CHAIN_ID } from '../constants';
import type { Address, ChainConfig } from './types';
import { getChainConfig } from './registry';

/**
 * Everything the swap reads and signs on ONE chain, resolved together: our pools
 * (factory + router, written through SwapFeeRouter) and the outside pools they are
 * compared with (Uniswap V2), plus the WETH both route through.
 *
 * ONE OBJECT FOR THE SAME REASON AS liquidityVenue.ts: several of our addresses are
 * a different live contract on another chain (mainnet TEGRIDY_ROUTER_ADDRESS is
 * Robinhood's swapFeeRouter; mainnet TEGRIDY_FACTORY_ADDRESS is Base's). With
 * `chainId` bound into the same object as every address, a call site cannot hold
 * one chain's address and another chain's id.
 *
 * MAINNET MUST RESOLVE TO EXACTLY WHAT THE CONSTANTS SAID; swapVenue.test.ts checks
 * it against `lib/constants`, not a copy.
 *
 * THE RULE IS ETHEREUM'S, UNCHANGED (owner, 2026-10-17: "use same logic as on eth
 * and sol route to better pool unless our pools are better"). useSwapQuote compares
 * our pool's output NET of the SwapFeeRouter fee with Uniswap V2's and takes ours on
 * a tie or better. Uniswap V3 / V4 pools are not compared on any chain.
 */
export interface SwapVenue {
  /** The chain these addresses belong to. Never pass one without the others. */
  readonly chainId: number;
  readonly name: string;
  readonly weth: Address;
  /** Our pools. */
  readonly factory: Address;
  readonly router: Address;
  /** Our router's front door: takes the venue fee, then swaps through `router`. */
  readonly swapFeeRouter: Address;
  /** The outside pools our quote is compared with. */
  readonly uniswapV2Router: Address;
  readonly uniswapV2Factory: Address;
  /** Where the venue fee lands: 'distributor' reaches stakers; 'remittance' is a Safe on that chain. */
  readonly feeSink: ChainConfig['feeSink'];
}

/**
 * Uniswap V2 per chain, each read on chain 2026-10-17:
 *   Ethereum — the canonical pair the swap has always compared with.
 *   Base     — Uniswap's documented V2 deployment; router.factory() and router.WETH()
 *              read back the factory below and the OP-stack WETH predeploy.
 *   Robinhood — Uniswap's docs list only V3 here. The factory is the `factoryV2()` of
 *              Uniswap's documented SwapRouter02 (0xcaf681a6…5cb2); the router is the
 *              contract that sends most V2 trades on that factory, and its code is
 *              byte-identical to Uniswap's V2 Router02 on Unichain once the factory and
 *              WETH addresses built into it are blanked out.
 */
const UNISWAP_V2: Readonly<Record<number, { router: Address; factory: Address }>> = Object.freeze({
  [CHAIN_ID]: { router: UNISWAP_V2_ROUTER, factory: UNISWAP_V2_FACTORY },
  8453: {
    router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
    factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
  },
  4663: {
    router: '0x89e5DB8B5aA49aA85AC63f691524311AEB649eba',
    factory: '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f',
  },
});

const VENUES = new Map<number, SwapVenue>();

/**
 * The swap venue for a chain, or null where the swap does not run.
 *
 * Null means "do not quote and do not build a transaction": an unconfigured chain, a
 * chain whose `ammSwap` is off, or one missing any address above. Callers render that
 * as a refusal and never fall back to another chain.
 */
export function swapVenueOn(chainId: number | undefined | null): SwapVenue | null {
  const config = getChainConfig(chainId);
  if (!config || !config.capabilities.ammSwap) return null;
  // One frozen object per chain, so a hook that depends on the venue keeps a stable
  // identity across renders (the registry never changes at runtime).
  const cached = VENUES.get(config.id);
  if (cached) return cached;
  const outside = UNISWAP_V2[config.id];
  const { weth, factory, router, swapFeeRouter } = config.contracts;
  if (!outside || !weth || !factory || !router || !swapFeeRouter) return null;
  const venue: SwapVenue = Object.freeze({
    chainId: config.id,
    name: config.name,
    weth,
    factory,
    router,
    swapFeeRouter,
    uniswapV2Router: outside.router,
    uniswapV2Factory: outside.factory,
    feeSink: config.feeSink,
  });
  VENUES.set(config.id, venue);
  return venue;
}

const OPENING_VENUES = new Map<number, SwapVenue>();

/**
 * The same chain's venue for pools on the factory that charges 0.006 ETH to open a pool
 * (owner ruling 2026-10-25): its factory, its router, and the SwapFeeRouter bound to that
 * router, which takes the same venue fee as `swapFeeRouter`. Uniswap V2, WETH and the fee sink
 * are unchanged. Null until all three are deployed on this chain, so nothing changes before.
 *
 * Pools on the old factory are swapped through `venue`; pools on the new one through this. The
 * quote (useSwapQuote) says which of the two won, and useSwap signs and approves against it.
 */
export function openingSwapVenue(venue: SwapVenue | null): SwapVenue | null {
  if (!venue) return null;
  const cached = OPENING_VENUES.get(venue.chainId);
  if (cached) return cached;
  const config = getChainConfig(venue.chainId);
  const { openingFactory, openingRouter, openingSwapFeeRouter } = config?.contracts ?? {};
  if (!openingFactory || !openingRouter || !openingSwapFeeRouter) return null;
  const opening: SwapVenue = Object.freeze({
    ...venue,
    factory: openingFactory,
    router: openingRouter,
    swapFeeRouter: openingSwapFeeRouter,
  });
  OPENING_VENUES.set(venue.chainId, opening);
  return opening;
}
