// The phone bar says which section you are in on every page of that section, as the top
// bar's word does. Lit only on its own URL, "Pools" went dark on the Solana LP tab one
// press away from it, so the bar no longer showed where a phone was (three phone walks of
// production, 2026-10-03).

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('wagmi', () => ({ useAccount: () => ({ isConnected: false }) }));

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

  it('nothing is lit on a page that belongs to no tab', () => {
    expect(lit('/changelog')).toEqual([]);
  });
});
