/**
 * The network map behind Swap, Pools and Launch's drop-down. Every "serves" is read from the
 * registry the page reads, so these pin today's facts AND that they come from there: a chain
 * whose launcher or router were zeroed would drop out of the drop-down with it.
 */
import { describe, it, expect } from 'vitest';
import { LAUNCH_SECTION, POOLS_SECTION, SWAP_SECTION } from './navConfig';
import { getChainConfig } from './chains/registry';
import {
  VENUE_CHAINS,
  chainDestination,
  chainHref,
  parseVenueChain,
  sectionHasChain,
  tabChains,
  venueChainOfEvm,
} from './sectionChains';

describe('the four networks', () => {
  it('are Ethereum, Base, Robinhood Chain and Solana, named as the registry names them', () => {
    expect(VENUE_CHAINS.map((c) => c.name)).toEqual(['Ethereum', 'Base', 'Robinhood Chain', 'Solana']);
    for (const c of VENUE_CHAINS) {
      if (c.evmChainId !== null) expect(getChainConfig(c.evmChainId)?.name).toBe(c.name);
    }
  });

  it('map EVM ids both ways, and refuse what the venue does not run on', () => {
    expect(venueChainOfEvm(8453)).toBe('base');
    expect(venueChainOfEvm(4663)).toBe('robinhood');
    expect(venueChainOfEvm(42161)).toBeNull();
    expect(parseVenueChain('solana')).toBe('solana');
    expect(parseVenueChain('arbitrum')).toBeNull();
  });
});

describe('which tab serves which network', () => {
  it('swaps on every EVM chain with a swap venue, and on Solana', () => {
    expect(tabChains('/swap')).toEqual(['ethereum', 'base', 'robinhood']);
    expect(tabChains('/solana')).toEqual(['solana']);
  });

  it('adds liquidity wherever our router, factory and WETH are deployed', () => {
    expect(tabChains('/liquidity')).toEqual(['ethereum', 'base', 'robinhood']);
    expect(tabChains('/zap')).toEqual(['ethereum']);
    expect(tabChains('/solana-lp')).toEqual(['solana']);
    expect(tabChains('/pools')).toEqual(['solana']);
  });

  it('launches on the EVM curve wherever its launcher is deployed, and the simulator names none', () => {
    expect(tabChains('/eth-curve')).toEqual(['ethereum', 'base', 'robinhood']);
    expect(tabChains('/launch')).toEqual(['ethereum']);
    expect(tabChains('/curve-launch')).toEqual(['solana']);
    expect(tabChains('/launch-simulator')).toBe('any');
  });
});

describe('where a pick goes', () => {
  const pools = POOLS_SECTION.items;
  const launch = LAUNCH_SECTION.items;

  it('stays on the tab the visitor is on when it serves the network', () => {
    expect(chainDestination(launch, '/eth-curve', 'base')).toBe('/eth-curve');
    expect(chainDestination(pools, '/liquidity', 'robinhood')).toBe('/liquidity');
    expect(chainDestination(launch, '/launch-simulator', 'base')).toBe('/launch-simulator');
  });

  it("else goes to the section's first live tab on that network", () => {
    expect(chainDestination(pools, '/liquidity', 'solana')).toBe('/solana-lp');
    expect(chainDestination(pools, '/pools', 'ethereum')).toBe('/liquidity');
    expect(chainDestination(pools, '/zap', 'base')).toBe('/liquidity');
    expect(chainDestination(launch, '/launch', 'robinhood')).toBe('/eth-curve');
    expect(chainDestination(SWAP_SECTION.items, '/solana', 'ethereum')).toBe('/swap');
  });

  it('goes nowhere on a network the section has nothing on', () => {
    const items = [{ to: '/zap', label: 'Zap' }];
    expect(chainDestination(items, '/zap', 'base')).toBeNull();
    expect(sectionHasChain(items, '/zap', 'robinhood')).toBe(false);
  });

  it('sends a Swap pick on Base or Robinhood to the same EVM swap page', () => {
    expect(chainDestination(SWAP_SECTION.items, '/swap', 'base')).toBe('/swap');
    expect(chainDestination(SWAP_SECTION.items, '/solana', 'robinhood')).toBe('/swap');
  });

  it('never sends a pick to a tab that is off, but lights the network of the off page the visitor is on', () => {
    const items = [
      { to: '/eth-curve', label: 'Curve' },
      { to: '/curve-launch', label: 'Solana Curve', soon: true },
      { to: '/launch-simulator', label: 'Simulator' },
    ];
    expect(sectionHasChain(items, '/eth-curve', 'solana')).toBe(false);
    expect(chainDestination(items, '/launch-simulator', 'solana')).toBeNull();
    expect(sectionHasChain(items, '/curve-launch', 'solana')).toBe(true);
  });

  it("carries the network in the address the page reads it from", () => {
    expect(chainHref('/eth-curve', 'base')).toBe('/eth-curve?c=8453');
    expect(chainHref('/liquidity', 'robinhood')).toBe('/liquidity?c=4663');
    expect(chainHref('/launch-simulator', 'solana')).toBe('/launch-simulator?chain=solana');
    expect(chainHref('/swap', 'ethereum')).toBe('/swap?c=1');
    expect(chainHref('/swap', 'base')).toBe('/swap?c=8453');
    expect(chainHref('/solana-lp', 'solana')).toBe('/solana-lp');
  });
});
