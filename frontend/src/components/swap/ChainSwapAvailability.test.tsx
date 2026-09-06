import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { ChainSwapAvailability } from './ChainSwapAvailability';
import { CHAINS, CONFIGURED_CHAIN_IDS, getChainConfig } from '../../lib/chains/registry';

/**
 * The page must say WHY it cannot serve you. Before this, a wallet on Base or
 * Robinhood got a dead form and no words: the quote reads are gated off, the
 * CTA disables itself, and the wrong-network banner stays silent because both
 * chains ARE configured.
 *
 * These assert the RULE, not the current roster — they derive both the
 * "explains itself" and the "stays quiet" cases from `capabilities.ammSwap`, so
 * adding a fourth chain, or flipping Base on once its pools exist, moves the
 * chain between the two cases automatically instead of leaving a stale literal.
 */
function mount(chainId: number | undefined | null) {
  return render(
    <MemoryRouter>
      <ChainSwapAvailability chainId={chainId} />
    </MemoryRouter>,
  );
}

const SWAPPABLE = CONFIGURED_CHAIN_IDS.filter((id) => CHAINS[id]!.capabilities.ammSwap);
const NOT_SWAPPABLE = CONFIGURED_CHAIN_IDS.filter((id) => !CHAINS[id]!.capabilities.ammSwap);

describe('ChainSwapAvailability', () => {
  it('the fixture is not vacuous — there is at least one chain of each kind', () => {
    // Without this, both loops below could pass over an empty list and prove
    // nothing at all. The whole point is that the two cases coexist today.
    expect(SWAPPABLE.length, 'no swappable chain — the quiet case is untested').toBeGreaterThan(0);
    expect(
      NOT_SWAPPABLE.length,
      'no unswappable chain — the explanation case is untested',
    ).toBeGreaterThan(0);
  });

  it('says nothing on a chain that can actually swap', () => {
    for (const id of SWAPPABLE) {
      const { container, unmount } = mount(id);
      expect(container.textContent ?? '', `${CHAINS[id]!.name} should stay quiet`).toBe('');
      unmount();
    }
  });

  it('explains itself, by name, on a chain we serve but cannot swap on', () => {
    for (const id of NOT_SWAPPABLE) {
      const name = CHAINS[id]!.name;
      const { unmount } = mount(id);
      expect(
        screen.getByText(new RegExp(`not live on ${name}`, 'i')),
        `${name} left the visitor with no explanation`,
      ).toBeInTheDocument();
      unmount();
    }
  });

  it('offers the curve on that same chain, which is what actually works there', () => {
    for (const id of NOT_SWAPPABLE) {
      const { unmount } = mount(id);
      const curve = screen.getByRole('link', { name: /curve/i });
      // The chain id must ride along — a bare /eth-curve lands on the default
      // chain, which is the one the visitor is NOT on.
      expect(curve).toHaveAttribute('href', `/eth-curve?c=${id}`);
      unmount();
    }
  });

  it('stays quiet on an unconfigured chain, where the app-wide banner speaks', () => {
    // Two banners disagreeing about one wallet is worse than one.
    const unconfigured = 999_999;
    expect(getChainConfig(unconfigured), 'fixture drifted — 999999 is configured now').toBeNull();
    const { container } = mount(unconfigured);
    expect(container.textContent ?? '').toBe('');
  });

  it('stays quiet with no chain at all, rather than rendering a nameless warning', () => {
    expect(mount(undefined).container.textContent ?? '').toBe('');
    expect(mount(null).container.textContent ?? '').toBe('');
  });
});
