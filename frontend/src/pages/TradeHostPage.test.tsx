import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Owner, 2026-10-13: one "Ethereum / Solana" switcher above the swap card, the one in the
// page flow (ChainSwitch, inside each swap page). The section's fixed tab strip repeated
// it and, once the page scrolled, sat over the top of the form and of the review.
vi.mock('./TradePage', () => ({ default: () => <p>the Ethereum swap page</p> }));
vi.mock('./SolanaSwapPage', () => ({ default: () => <p>the Solana swap page</p> }));
vi.mock('../lib/navConfig', async (orig) => {
  const real = await orig<typeof import('../lib/navConfig')>();
  // Both chains listed, as on the live site, whatever this machine's switches say.
  return { ...real, SWAP_SECTION: { ...real.SWAP_SECTION, items: [{ to: '/swap', label: 'Swap', tabLabel: 'Ethereum' }, { to: '/solana', label: 'Solana Swap', tabLabel: 'Solana' }] } };
});

import TradeHostPage from './TradeHostPage';

afterEach(cleanup);

describe('the swap section draws no switcher of its own: the one in each page is the only one', () => {
  it.each([
    ['/swap', 'the Ethereum swap page'],
    ['/solana', 'the Solana swap page'],
    ['/solana/anything', 'the Solana swap page'],
  ])('%s opens %s, with no tab strip over it', async (path, page) => {
    render(<MemoryRouter initialEntries={[path]}><TradeHostPage /></MemoryRouter>);
    expect(await screen.findByText(page)).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    // Nothing fixed is drawn over the page, so nothing has to be cleared under it.
    expect(document.documentElement.classList.contains('has-route-tabs')).toBe(false);
  });
});
