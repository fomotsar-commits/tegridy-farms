// The island's dashboard (owner, 2026-10-21): every pool on the island, from the registry, each
// a real link to its own room, and no rate it has not read. It holds the same rules /earn's index
// holds (venueVoice.test.tsx), because it is the same list.

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { IslandDashboard } from './IslandDashboard';
import { venuePoolRows } from '../lib/venuePools';
import { MIN_BOOST_BPS, MAX_BOOST_BPS } from '../lib/constants';

function mount(headingLevel?: 1 | 2) {
  return render(
    <MemoryRouter>
      <IslandDashboard headingLevel={headingLevel} />
    </MemoryRouter>,
  );
}

describe('IslandDashboard', () => {
  it('lists every pool on the island, each opening its own room', () => {
    mount();
    const rows = venuePoolRows();
    expect(rows.length, 'precondition: the island has several pools').toBeGreaterThan(3);
    const list = screen.getByRole('list', { name: 'Pools on the island' });
    const links = within(list).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('aria-label'))).toEqual(rows.map((r) => `Open ${r.symbol}`));
    for (const r of rows) {
      expect(within(list).getByRole('link', { name: `Open ${r.symbol}` })).toHaveAttribute('href', `/earn/${r.id}`);
    }
    // TOWELI is a peer row, once.
    expect(links.filter((l) => l.getAttribute('aria-label') === 'Open TOWELI')).toHaveLength(1);
  });

  it('counts its pools and chains from the same list', () => {
    mount();
    const rows = venuePoolRows();
    const chains = new Set(rows.map((r) => r.chain).filter((c) => c !== 'tbd')).size;
    const pad = (n: number) => String(n).padStart(2, '0');
    const stats = screen.getByText('Pools').closest('dl')!;
    expect(stats.textContent).toContain(`Pools${pad(rows.length)}`);
    expect(stats.textContent).toContain(`Chains${pad(chains)}`);
  });

  it('publishes no rate, and states the ladder at its real floor and ceiling', () => {
    mount();
    const list = screen.getByRole('list', { name: 'Pools on the island' });
    expect(list.textContent).not.toMatch(/%/);
    expect(list.textContent).toContain(`${(MIN_BOOST_BPS / 10_000).toFixed(2)}×`);
    expect(list.textContent).toContain(`${(MAX_BOOST_BPS / 10_000).toFixed(2)}×`);
    expect(list.textContent).not.toContain('1.00×');
    expect(screen.getByText(/No rate is shown here because none is read here/)).toBeInTheDocument();
  });

  it('is the page heading on /dashboard and a section heading on the home', () => {
    const { unmount } = mount(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Dashboard');
    unmount();
    mount();
    expect(screen.getByRole('heading', { level: 2, name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('routes to the venue\'s own liquidity', () => {
    mount();
    expect(screen.getByRole('link', { name: /provide liquidity on venue pools/i })).toHaveAttribute('href', '/liquidity');
  });
});
