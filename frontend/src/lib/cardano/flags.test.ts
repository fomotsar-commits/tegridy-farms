// The Cardano swap's switch, and everything that hangs off it.
import { describe, expect, it, vi } from 'vitest';
import { CARDANO_SWAP_OPEN, cardanoSwapVisible } from './flags';
import { isCardanoPage } from '../routeVoice';

describe('the Cardano swap switch', () => {
  it('ships off: the owner opens it once a fee address is registered and a real swap is walked', () => {
    expect(CARDANO_SWAP_OPEN).toBe(false);
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
    // Off (as shipped), /cardano is the 404 page: the top bar keeps its usual wallet button.
    expect(isCardanoPage('/cardano')).toBe(false);
  });
});

describe('with the swap shown', () => {
  it('lists Cardano last in the drop-down, and /cardano serves it', async () => {
    vi.resetModules();
    vi.doMock('./flags', () => ({ CARDANO_SWAP_OPEN: true, cardanoSwapVisible: () => true }));
    const { VENUE_CHAINS, tabChains } = await import('../sectionChains');
    const { SWAP_SECTION } = await import('../navConfig');
    expect(VENUE_CHAINS.map((c) => c.id)).toEqual(['ethereum', 'base', 'robinhood', 'solana', 'cardano']);
    expect(VENUE_CHAINS.at(-1)).toEqual({ id: 'cardano', name: 'Cardano', short: 'Cardano', evmChainId: null });
    expect(tabChains('/cardano')).toEqual(['cardano']);
    expect(SWAP_SECTION.items.map((i) => i.to)).toContain('/cardano');
    vi.doUnmock('./flags');
  });

  it('and with it hidden, no drop-down or tab carries Cardano', async () => {
    vi.resetModules();
    const { VENUE_CHAINS } = await import('../sectionChains');
    const { SWAP_SECTION } = await import('../navConfig');
    expect(VENUE_CHAINS.map((c) => c.id)).not.toContain('cardano');
    expect(SWAP_SECTION.items.map((i) => i.to)).not.toContain('/cardano');
  });
});
