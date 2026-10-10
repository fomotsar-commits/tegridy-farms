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

describe('/liquidity points a Solana visitor at the Solana LP tab', () => {
  it('with a link in its header, before the paragraph and the pool table', () => {
    mount();
    const link = screen.getByRole('link', { name: 'On Solana? Create a pool, add or remove liquidity on the Solana LP tab' });
    expect(link).toHaveAttribute('href', '/solana-lp');
    const header = screen.getByRole('heading', { level: 1, name: 'Liquidity' }).parentElement!;
    expect(header).toContainElement(link);
    const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(link, screen.getByText(/Pair two tokens into a pool/))).toBe(true);
    expect(before(link, screen.getByTestId('pool-table'))).toBe(true);
  });

  it.each<[LpWriteMode, string, RegExp]>([
    ['withdraw-only', 'On Solana? Take liquidity out on the Solana LP tab', /create|add/i],
    ['off', 'On Solana? Find a pool on the Solana LP tab', /create|add|remove|take/i],
  ])('LP %s: the link promises only what that tab can do', (mode, text, never) => {
    lp.mode = mode;
    const pointer = mount();
    expect(screen.getByRole('link', { name: text })).toHaveAttribute('href', '/solana-lp');
    expect(pointer.textContent ?? '').not.toMatch(never);
  });
});
