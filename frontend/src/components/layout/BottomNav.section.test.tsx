// The phone bar says which section you are in on every page of that section, as the top
// bar's word does. Lit only on its own URL, "Pools" went dark on the Solana LP tab one
// press away from it, so the bar no longer showed where a phone was (three phone walks of
// production, 2026-10-03).

import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const account = vi.hoisted(() => ({ isConnected: false }));
vi.mock('wagmi', () => ({ useAccount: () => account }));

import { BottomNav } from './BottomNav';
import { CHECK_SECTION, EARN_SECTION, POOLS_SECTION, SWAP_SECTION } from '../../lib/navConfig';

function lit(path: string): string[] {
  const { unmount } = render(
    <MemoryRouter initialEntries={[path]}>
      <BottomNav />
    </MemoryRouter>,
  );
  const names = screen
    .getAllByRole('link')
    .filter((a) => a.className.includes('text-purple-400'))
    .map((a) => a.getAttribute('aria-label') ?? '');
  unmount();
  return names;
}

afterEach(() => {
  account.isConnected = false;
});

describe('BottomNav: a tab is lit on every page of its section', () => {
  it.each(POOLS_SECTION.items.map((i) => i.to))('Pools on %s', (to) => {
    expect(lit(to)).toEqual(['Pools']);
  });

  it('Pools on a token link into the Solana LP tab', () => {
    expect(lit('/solana-lp?mint=7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump')).toEqual(['Pools']);
  });

  it.each([
    ['Swap', SWAP_SECTION],
    ['Earn', EARN_SECTION],
    ['Check', CHECK_SECTION],
  ] as const)('%s on each of its own pages', (label, section) => {
    for (const item of section.items) expect(lit(item.to), item.to).toEqual([label]);
  });

  // Owner, 2026-10-03: "pools land on solana lp".
  it('the Pools tab opens the Solana LP tab', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <BottomNav />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Pools' })).toHaveAttribute('href', '/solana-lp');
  });

  it('nothing is lit on a page that belongs to no tab', () => {
    expect(lit('/changelog')).toEqual([]);
  });

  it('connected: Dashboard is lit on /dashboard only, and never steals a section page', () => {
    account.isConnected = true;
    expect(lit('/dashboard')).toEqual(['Dashboard']);
    expect(lit('/solana-lp')).toEqual(['Pools']);
  });
});
