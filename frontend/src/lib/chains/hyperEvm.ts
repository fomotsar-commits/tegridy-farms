import { HYPEREVM_DEPLOYMENT, type HyperEvmDeployment } from './hyperEvmDeployment';

/**
 * HyperEVM (chain 999): our own Uniswap V3 venue, Uniswap's code unchanged under our Safe
 * (SPEC-2026-11-19-hyperevm-uniswap-v3.md). Not in registry.ts's CHAINS: that record is
 * the V2-fork venue's shape, and every slot it requires is absent here. Plain text only, so
 * the nav reads `hyperEvmLive()` in the main bundle without loading any HyperEVM code.
 */
export const HYPEREVM_CHAIN_ID = 999;
export const HYPEREVM_NAME = 'HyperEVM';
/** Wrapped HYPE, the WETH9 our position manager and router hold (read on chain 2026-11-20: WHYPE, 18 decimals). */
export const WHYPE: `0x${string}` = '0x5555555555555555555555555555555555555555';
export const HYPEREVM_EXPLORER = 'https://hyperevmscan.io';
/** Both answer eth_blockNumber with `access-control-allow-origin: *` (read 2026-11-20). */
export const HYPEREVM_RPCS = ['https://rpc.hyperliquid.xyz/evm', 'https://hyperliquid.drpc.org'] as const;

/** Every address the site needs, all set, plus the owner's site-fee rate. */
export interface HyperEvmVenue {
  readonly chainId: typeof HYPEREVM_CHAIN_ID;
  readonly name: typeof HYPEREVM_NAME;
  readonly whype: `0x${string}`;
  readonly factory: `0x${string}`;
  readonly positionManager: `0x${string}`;
  readonly quoterV2: `0x${string}`;
  readonly universalRouter: `0x${string}`;
  readonly feeAdapter: `0x${string}`;
  readonly treasury: `0x${string}`;
  readonly siteFeeBps: bigint;
  /** Where anyone opens a pool for its fee; null until deployed (the open form stays hidden). */
  readonly poolOpener: `0x${string}` | null;
}

/** The site never charges more than this on a swap, whatever the record says (Base's SwapFeeRouter cap). */
export const MAX_SITE_FEE_BPS = 100;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/;
const set = (a: `0x${string}` | null): a is `0x${string}` => a !== null && ADDRESS.test(a) && !ZERO.test(a);

/** The venue, or null while any address is unset (or the fee rate is unset or out of range). */
export function hyperEvmVenueFrom(d: HyperEvmDeployment): HyperEvmVenue | null {
  const { factory, positionManager, quoterV2, universalRouter, feeAdapter, treasury, siteFeeBps } = d;
  if (!set(factory) || !set(positionManager) || !set(quoterV2) || !set(universalRouter) || !set(feeAdapter) || !set(treasury)) return null;
  if (siteFeeBps === null || !Number.isInteger(siteFeeBps) || siteFeeBps < 0 || siteFeeBps > MAX_SITE_FEE_BPS) return null;
  return Object.freeze({
    chainId: HYPEREVM_CHAIN_ID,
    name: HYPEREVM_NAME,
    whype: WHYPE,
    factory,
    positionManager,
    quoterV2,
    universalRouter,
    feeAdapter,
    treasury,
    siteFeeBps: BigInt(siteFeeBps),
    poolOpener: d.poolOpener && set(d.poolOpener) ? d.poolOpener : null,
  });
}

const VENUE = hyperEvmVenueFrom(HYPEREVM_DEPLOYMENT);

/** Our HyperEVM venue, or null until every address is deployed and set. */
export function hyperEvmVenue(): HyperEvmVenue | null {
  return VENUE;
}

/** Whether HyperEVM shows anywhere: its network row, tabs, routes, wallet chain and sheet row. */
export function hyperEvmLive(): boolean {
  return VENUE !== null;
}

/** Uniswap V3's four fee tiers (the factory's defaults) and their tick spacing. */
export const V3_FEE_TIERS: readonly { fee: number; tickSpacing: number }[] = Object.freeze([
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
]);

export interface HyperEvmToken {
  readonly address: `0x${string}`;
  /** The token's own ticker, as its contract returns it. */
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  /** HYPE itself: sent as the call's value, wrapped to WHYPE by the router. */
  readonly isNative?: true;
  /**
   * Not on the site's list: a coin someone opened a pool for. Its `symbol` is its own claim,
   * cleaned for the screen ("fake USDC" for a copy, coins.ts), and its whole address always shows.
   */
  readonly unlisted?: true;
  /** An unlisted coin whose ticker contains a listed one's ("USDC.e"): the screens warn, never rename. */
  readonly lookalike?: string;
}

/** HYPE has no contract; this is the pseudo-address the site's token lists use for a chain's own coin. */
export const NATIVE_HYPE_ADDRESS: `0x${string}` = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/**
 * The coins the HyperEVM forms list, each read on chain 2026-11-20 (symbol, name, decimals).
 * A pool shows only when both its coins are here, so a pool of a copy-coin never does.
 */
export const HYPEREVM_TOKENS: readonly HyperEvmToken[] = Object.freeze([
  { address: NATIVE_HYPE_ADDRESS, symbol: 'HYPE', name: 'HYPE', decimals: 18, isNative: true },
  { address: WHYPE, symbol: 'WHYPE', name: 'Wrapped HYPE', decimals: 18 },
  { address: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', symbol: 'USD₮0', name: 'USD₮0', decimals: 6 },
  { address: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', symbol: 'USDC', name: 'USDC', decimals: 6 },
]);

/** The ERC-20 a pool holds for a listed token: WHYPE for HYPE. */
export function poolSide(token: HyperEvmToken): `0x${string}` {
  return token.isNative ? WHYPE : token.address;
}

export function hyperEvmTxUrl(hash: string): string {
  return `${HYPEREVM_EXPLORER}/tx/${hash}`;
}

export function hyperEvmAddressUrl(address: string): string {
  return `${HYPEREVM_EXPLORER}/address/${address}`;
}
