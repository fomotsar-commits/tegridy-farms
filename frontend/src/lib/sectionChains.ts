import type { NavItem } from './navConfig';
import { getChainConfig } from './chains/registry';
import { liquidityVenueOn } from './chains/liquidityVenue';
import { curveLauncherOn } from './launcher/curve';
// Plain text only: whether the Cardano swap or pools are shown, without loading any Cardano code.
import { cardanoOwnPoolsVisible, cardanoSwapVisible } from './cardano/flags';

/**
 * The four networks the venue runs on, and which tab of Swap, Pools and Launch serves which
 * (owner, 2026-10-15: "a drop down for all chains including sol, like uniswap"). The section's
 * network drop-down (ChainPicker) lists all four; a network the section has nothing on is
 * listed, greyed, with its reason, so a visitor never lands on an empty page.
 *
 * Every "serves" below is read from the registry the page itself reads, never typed: a chain
 * whose launcher or router is not deployed drops out of the drop-down with it.
 */
export type VenueChain = 'ethereum' | 'base' | 'robinhood' | 'solana' | 'cardano';

export interface VenueChainInfo {
  id: VenueChain;
  /** The network's name, as the registry and the wallet say it. */
  name: string;
  /** On the drop-down's button, where a phone has room for one short word. */
  short: string;
  /** The EVM chain id; null for Solana and Cardano, which are not wagmi chains. */
  evmChainId: number | null;
}

const ETHEREUM: VenueChainInfo = { id: 'ethereum', name: 'Ethereum', short: 'Ethereum', evmChainId: 1 };

/** Order of the drop-down: Ethereum first, Solana last, as Uniswap lists them. */
export const VENUE_CHAINS: readonly VenueChainInfo[] = [
  ETHEREUM,
  { id: 'base', name: 'Base', short: 'Base', evmChainId: 8453 },
  { id: 'robinhood', name: 'Robinhood Chain', short: 'Robinhood', evmChainId: 4663 },
  { id: 'solana', name: 'Solana', short: 'Solana', evmChainId: null },
  // Cardano (owner, 2026-10-24: "cardano integrated in every aspect") is listed only once its
  // swap or its pools are shown (lib/cardano/flags.ts), so until then no drop-down carries a greyed row for it.
  ...(cardanoSwapVisible() || cardanoOwnPoolsVisible() ? [{ id: 'cardano' as const, name: 'Cardano', short: 'Cardano', evmChainId: null }] : []),
];

export function venueChain(id: VenueChain): VenueChainInfo {
  return VENUE_CHAINS.find((c) => c.id === id) ?? ETHEREUM;
}

/** The venue network for an EVM chain id; null for a chain the venue does not run on. */
export function venueChainOfEvm(chainId: number | null | undefined): VenueChain | null {
  return VENUE_CHAINS.find((c) => c.evmChainId !== null && c.evmChainId === chainId)?.id ?? null;
}

/** A network named in a URL (`?chain=`); null for anything else. */
export function parseVenueChain(value: string | null): VenueChain | null {
  return VENUE_CHAINS.find((c) => c.id === value)?.id ?? null;
}

/** 'any': a tab that names no network (the launch simulator), so it shows on all four. */
export type TabChains = readonly VenueChain[] | 'any';

function evmWhere(test: (chainId: number) => boolean): VenueChain[] {
  return VENUE_CHAINS.filter((c) => c.evmChainId !== null && test(c.evmChainId)).map((c) => c.id);
}

/** Which networks a section tab serves, by its route. */
export function tabChains(to: string): TabChains {
  switch (to) {
    // The swap runs wherever a swap venue resolves (registry `ammSwap`; lib/chains/swapVenue.ts).
    case '/swap':
      return evmWhere((id) => getChainConfig(id)?.capabilities.ammSwap === true);
    // Add / remove follows the wallet's chain wherever our router, factory and WETH are deployed.
    case '/liquidity':
      return evmWhere((id) => liquidityVenueOn(id) !== null);
    // The zap plan compiles at CHAIN_ID, and the Doppler launchpad refuses every other chain.
    case '/zap':
    case '/launch':
      return ['ethereum'];
    // Our own EVM curve, on every chain its launcher is deployed to (`?c=<chainId>` picks one).
    case '/eth-curve':
      return evmWhere((id) => curveLauncherOn(id).status === 'deployed');
    case '/solana':
    case '/range-pools':
    case '/pools':
    case '/curve-launch':
      return ['solana'];
    // The swap through Minswap V2 pools with the venue's own fee line (lib/cardano/), and the
    // venue's own Cardano pools (lib/cardano/ownPools/).
    case '/cardano':
    case '/cardano-pools':
      return ['cardano'];
    default:
      return 'any';
  }
}

export function tabServes(to: string, chain: VenueChain): boolean {
  const chains = tabChains(to);
  return chains === 'any' || chains.includes(chain);
}

/** A tab on a network of its own (not 'any') that is on today. */
function liveTabOn(item: NavItem, chain: VenueChain): boolean {
  const chains = tabChains(item.to);
  return !item.soon && chains !== 'any' && chains.includes(chain);
}

/**
 * Does the section have anything on `chain`? A live tab of that network, or the page the
 * visitor is on (an off tab still opens by URL, and its own network is lit there).
 */
export function sectionHasChain(items: readonly NavItem[], activeTo: string, chain: VenueChain): boolean {
  if (items.some((i) => liveTabOn(i, chain))) return true;
  const chains = tabChains(activeTo);
  return chains !== 'any' && chains.includes(chain);
}

/**
 * The tab picking `chain` lands on: the visitor's own tab when it serves that network (the
 * curve stays the curve, Base to Ethereum), else the section's first live tab on it. Null when
 * the section has nothing there.
 */
export function chainDestination(items: readonly NavItem[], activeTo: string, chain: VenueChain): string | null {
  if (!sectionHasChain(items, activeTo, chain)) return null;
  if (tabServes(activeTo, chain)) return activeTo;
  return items.find((i) => liveTabOn(i, chain))?.to ?? null;
}

/**
 * A tab's address on `chain`. The pages that serve several networks read it from the URL:
 * `?c=<chainId>` (the curve's own param, which the add / remove form now reads too), and a tab
 * that names no network carries `?chain=` so the strip keeps the network it was opened from.
 */
export function chainHref(to: string, chain: VenueChain): string {
  const chains = tabChains(to);
  if (chains === 'any') return `${to}?chain=${chain}`;
  const evm = venueChain(chain).evmChainId;
  if (chains.length > 1 && evm !== null) return `${to}?c=${evm}`;
  return to;
}
