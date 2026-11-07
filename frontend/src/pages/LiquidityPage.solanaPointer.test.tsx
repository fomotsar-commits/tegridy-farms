// "Pools" on a phone opens this page: the Ethereum form, under a tab named Add / Remove.
// A visitor with a Solana token stopped here, because nothing on the screen said where
// Solana liquidity is (owner on a phone and five phone walks of production, 2026-10-03).
// The pointer is in the page's header, above its paragraph, so it is on the first screen,
// and it promises only what LP's own switch allows on that tab.

import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { LpWriteMode } from '../lib/launcher/solana/lpWriteFlag';

const lp = vi.hoisted(() => ({ mode: 'on' as 'on' | 'withdraw-only' | 'off' }));
vi.mock('../lib/launcher/solana/lpWriteFlag', async (orig) => ({
  ...(await orig<typeof import('../lib/launcher/solana/lpWriteFlag')>()),
  lpWriteMode: () => lp.mode,
}));
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: false }),
  useChainId: () => 1,
  useSwitchChain: () => ({ switchChain: vi.fn() }),
  useChains: () => [],
}));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }));
vi.mock('../hooks/usePoolTVL', () => ({ usePoolTVL: () => ({}) }));
vi.mock('../components/swap/LiquidityTab', () => ({ LiquidityTab: () => null }));
vi.mock('../components/farm/ILCalculator', () => ({ ILCalculator: () => null }));
vi.mock('../components/liquidity/LiquidityPrimer', () => ({ LiquidityPrimer: () => null }));
vi.mock('../components/liquidity/VenuePoolTable', () => ({ VenuePoolTable: () => <div data-testid="pool-table" /> }));

import LiquidityPage from './LiquidityPage';

function mount() {
  render(
    <MemoryRouter initialEntries={['/liquidity']}>
      <LiquidityPage />
    </MemoryRouter>,
  );
  return screen.getByTestId('solana-lp-pointer');
}

afterEach(() => {
  cleanup();
  lp.mode = 'on';
});

describe('/liquidity points a Solana visitor at the Venue AMM tab', () => {
  it('with a link in its header, before the paragraph and the pool table', () => {
    mount();
    const link = screen.getByRole('link', { name: 'On Solana? Create, add or remove on the Venue AMM tab' });
    expect(link).toHaveAttribute('href', '/pools');
    const header = screen.getByRole('heading', { level: 1, name: 'Liquidity' }).parentElement!;
    expect(header).toContainElement(link);
    const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(link, screen.getByText(/Pair two tokens into a pool/))).toBe(true);
    expect(before(link, screen.getByTestId('pool-table'))).toBe(true);
  });

  // How the venue earns stays on screen (owner, 2026-10-09): its cut of the TOWELI/ETH pool
  // fee (on since 2026-10-16), and the separate fee on swaps routed through this site.
  it('says on screen what the venue takes from the TOWELI/ETH pool fee and that swaps through this site pay it a separate fee', () => {
    mount();
    expect(screen.getByText(/On TOWELI\/ETH: 0\.25% to providers, 0\.05% to the venue's treasury \(read 17 October 2026\)/)).toBeVisible();
    expect(screen.getByText(/Swaps made through this site pay the venue a separate fee/)).toBeVisible();
  });

  it.each<[LpWriteMode, string, RegExp]>([
    ['withdraw-only', 'On Solana? Take liquidity out on the Venue AMM tab', /create|add/i],
    ['off', 'On Solana? Find a pool on the Venue AMM tab', /create|add|remove|take/i],
  ])('LP %s: the link promises only what that tab can do', (mode, text, never) => {
    lp.mode = mode;
    const pointer = mount();
    expect(screen.getByRole('link', { name: text })).toHaveAttribute('href', '/pools');
    expect(pointer.textContent ?? '').not.toMatch(never);
  });
});
