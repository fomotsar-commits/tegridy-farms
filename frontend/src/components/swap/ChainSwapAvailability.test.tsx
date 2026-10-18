import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { ChainSwapAvailability } from './ChainSwapAvailability';
import { CHAINS, CONFIGURED_CHAIN_IDS, getChainConfig } from '../../lib/chains/registry';
import { CHAIN_ID } from '../../lib/constants';

/**
 * The page must say WHY a tab cannot serve you. Before this, a wallet on Base or
 * Robinhood got a dead form and no words: the reads are gated off, the CTA disables
 * itself, and the wrong-network banner stays silent because both chains ARE
 * configured.
 *
 * Since 2026-10-17 Swap runs on both L2s, and DCA, Limit, TWAP and Trigger still run
 * on Ethereum only. These assert the RULE, derived from the registry, so a chain that
 * gains or loses `ammSwap` moves between the cases without a stale literal.
 */
function mount(chainId: number | undefined | null, swapTab = false) {
  return render(
    <MemoryRouter>
      <ChainSwapAvailability chainId={chainId} swapTab={swapTab} />
    </MemoryRouter>,
  );
}

const L2_SWAPS = CONFIGURED_CHAIN_IDS.filter((id) => id !== CHAIN_ID && CHAINS[id]!.capabilities.ammSwap);
const NOT_SWAPPABLE = CONFIGURED_CHAIN_IDS.filter((id) => !CHAINS[id]!.capabilities.ammSwap);

describe('ChainSwapAvailability', () => {
  it('the fixture is not vacuous: at least one chain other than Ethereum swaps', () => {
    expect(L2_SWAPS.length, 'no L2 swaps — the "only Swap runs here" case is untested').toBeGreaterThan(0);
  });

  it('says nothing on Ethereum, on any tab', () => {
    for (const swapTab of [true, false]) {
      const { container, unmount } = mount(CHAIN_ID, swapTab);
      expect(container.textContent ?? '').toBe('');
      unmount();
    }
  });

  it('says nothing on the Swap tab of a chain that swaps', () => {
    for (const id of L2_SWAPS) {
      const { container, unmount } = mount(id, true);
      expect(container.textContent ?? '', `${CHAINS[id]!.name} Swap tab should stay quiet`).toBe('');
      unmount();
    }
  });

  it('on the other tabs of such a chain, says by name that only Swap runs there', () => {
    for (const id of L2_SWAPS) {
      const name = CHAINS[id]!.name;
      const { unmount } = mount(id, false);
      expect(screen.getByText(`Only Swap runs on ${name}`)).toBeInTheDocument();
      expect(screen.getByText('DCA, Limit, TWAP and Trigger run on Ethereum only.')).toBeInTheDocument();
      unmount();
    }
  });

  it('offers the curve on that same chain, which also works there', () => {
    for (const id of L2_SWAPS) {
      const { unmount } = mount(id, false);
      // The chain id must ride along — a bare /eth-curve lands on the default
      // chain, which is the one the visitor is NOT on.
      expect(screen.getByRole('link', { name: /curve/i })).toHaveAttribute('href', `/eth-curve?c=${id}`);
      unmount();
    }
  });

  it('still explains a chain we serve that cannot swap, if one is ever configured', () => {
    for (const id of NOT_SWAPPABLE) {
      const { unmount } = mount(id, true);
      expect(screen.getByText(new RegExp(`not live on ${CHAINS[id]!.name}`, 'i'))).toBeInTheDocument();
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
