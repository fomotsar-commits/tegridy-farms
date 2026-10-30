// The Cardano swap's switch, and everything that hangs off it.
import { describe, expect, it, vi } from 'vitest';
import { CARDANO_OWN_POOLS_OPEN, CARDANO_SWAP_OPEN, cardanoOwnPoolsVisible, cardanoSwapVisible } from './flags';
import { isCardanoPage } from '../routeVoice';

describe('the Cardano swap switch', () => {
  it('is open (owner, 2026-10-24, after a real buy and sell on mainnet); closed, a production build hides it', () => {
    expect(CARDANO_SWAP_OPEN).toBe(true);
    expect(cardanoSwapVisible()).toBe(true);
    expect(cardanoSwapVisible(false, 'production')).toBe(false);
  });

  it('shows in a cardano-preview build, or once opened', () => {
    expect(cardanoSwapVisible(false, 'cardano-preview')).toBe(true);
    expect(cardanoSwapVisible(true, 'production')).toBe(true);
  });

  it('marks /cardano as a Cardano page, exactly, and only while the swap is shown', () => {
    expect(isCardanoPage('/cardano', true)).toBe(true);
    expect(isCardanoPage('/cardano/', true)).toBe(true);
    expect(isCardanoPage('/solana', true)).toBe(false);
    expect(isCardanoPage('/cardano-lp', true)).toBe(false);
    // Closed, /cardano is the 404 page: the top bar keeps its usual wallet button.
    expect(isCardanoPage('/cardano', false)).toBe(false);
    // As shipped (open), it is the Cardano page.
    expect(isCardanoPage('/cardano')).toBe(true);
  });
});

// Each test re-imports navConfig and sectionChains from scratch (resetModules): about 2.5 s
// alone, past 5 s on a busy machine. 20 s, as the repo's other cold-import tests.
describe('with the swap shown', () => {
  it('lists Cardano last in the drop-down, and /cardano serves it', async () => {
    vi.resetModules();
    vi.doMock('./flags', () => ({ CARDANO_SWAP_OPEN: true, cardanoSwapVisible: () => true, CARDANO_OWN_POOLS_OPEN: false, cardanoOwnPoolsVisible: () => false }));
    const { VENUE_CHAINS, tabChains } = await import('../sectionChains');
    const { SWAP_SECTION } = await import('../navConfig');
    expect(VENUE_CHAINS.map((c) => c.id)).toEqual(['ethereum', 'base', 'robinhood', 'solana', 'cardano']);
    expect(VENUE_CHAINS.at(-1)).toEqual({ id: 'cardano', name: 'Cardano', short: 'Cardano', evmChainId: null });
    expect(tabChains('/cardano')).toEqual(['cardano']);
    expect(SWAP_SECTION.items.map((i) => i.to)).toContain('/cardano');
    vi.doUnmock('./flags');
  }, 20_000);

  it('and with it hidden, no drop-down or tab carries Cardano', async () => {
    vi.resetModules();
    vi.doMock('./flags', () => ({ CARDANO_SWAP_OPEN: false, cardanoSwapVisible: () => false, CARDANO_OWN_POOLS_OPEN: false, cardanoOwnPoolsVisible: () => false }));
    const { VENUE_CHAINS } = await import('../sectionChains');
    const { SWAP_SECTION } = await import('../navConfig');
    expect(VENUE_CHAINS.map((c) => c.id)).not.toContain('cardano');
    expect(SWAP_SECTION.items.map((i) => i.to)).not.toContain('/cardano');
    vi.doUnmock('./flags');
  }, 20_000);
});

describe('the venue’s own Cardano pools switch', () => {
  it('is off as shipped: nothing is on chain, so a production build has no tab, no route and no drop-down row for it', () => {
    expect(CARDANO_OWN_POOLS_OPEN).toBe(false);
    expect(cardanoOwnPoolsVisible(false, 'production')).toBe(false);
    expect(cardanoOwnPoolsVisible()).toBe(false);
  });

  it('shows in a cardano-preview build, or once opened', () => {
    expect(cardanoOwnPoolsVisible(false, 'cardano-preview')).toBe(true);
    expect(cardanoOwnPoolsVisible(true, 'production')).toBe(true);
  });

  it('makes /cardano-pools a Cardano page only while the pools are shown', () => {
    expect(isCardanoPage('/cardano-pools', false, true)).toBe(true);
    expect(isCardanoPage('/cardano-pools/', false, true)).toBe(true);
    expect(isCardanoPage('/cardano-pools', true, false)).toBe(false);
    expect(isCardanoPage('/cardano-pools')).toBe(false);
  });

  it('shown, the Pools section carries its tab on Cardano; hidden, it carries none', async () => {
    vi.resetModules();
    vi.doMock('./flags', () => ({ CARDANO_SWAP_OPEN: false, cardanoSwapVisible: () => false, CARDANO_OWN_POOLS_OPEN: true, cardanoOwnPoolsVisible: () => true }));
    const shown = await import('../navConfig');
    const chains = await import('../sectionChains');
    expect(shown.POOLS_SECTION.items.map((i) => i.to)).toContain('/cardano-pools');
    expect(chains.tabChains('/cardano-pools')).toEqual(['cardano']);
    expect(chains.VENUE_CHAINS.map((c) => c.id)).toContain('cardano');
    vi.resetModules();
    vi.doMock('./flags', () => ({ CARDANO_SWAP_OPEN: true, cardanoSwapVisible: () => true, CARDANO_OWN_POOLS_OPEN: false, cardanoOwnPoolsVisible: () => false }));
    const hidden = await import('../navConfig');
    expect(hidden.POOLS_SECTION.items.map((i) => i.to)).not.toContain('/cardano-pools');
    vi.doUnmock('./flags');
  }, 20_000);
});
