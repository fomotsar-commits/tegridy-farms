// The phone bar reads Island · Lock · Launch · Swap (owner, 2026-10-03 and 2026-10-18). Five tabs is the
// ceiling at 390px, so Dashboard is a drawer row. A word is lit on every page it owns, as the top
// bar's is: lit only on its own URL, a word went dark one press away from it.

import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const account = vi.hoisted(() => ({ isConnected: false }));
vi.mock('wagmi', () => ({ useAccount: () => account }));

import { BottomNav } from './BottomNav';
import { LAUNCH_SECTION, LOCK_SECTION, SWAP_SECTION } from '../../lib/navConfig';

function mount(path = '/', hash = '') {
  return render(
    <MemoryRouter initialEntries={[{ pathname: path, hash }]}>
      <BottomNav />
    </MemoryRouter>,
  );
}

function tabs(path = '/', hash = '') {
  mount(path, hash);
  return screen.getAllByRole('link');
}

function lit(path: string, hash = ''): string[] {
  const { unmount } = mount(path, hash);
  const names = screen
    .getAllByRole('link')
    .filter((a) => a.className.includes('text-purple-400'))
    .map((a) => a.getAttribute('aria-label') ?? '');
  unmount();
  return names;
}

afterEach(() => {
  account.isConnected = false;
  window.localStorage.clear();
});

describe('BottomNav: the four words', () => {
  it('reads Island · Lock · Launch · Swap, each with its icon', () => {
    const links = tabs();
    expect(links.map((a) => a.getAttribute('aria-label'))).toEqual(['Island', 'Lock', 'Launch', 'Swap']);
    for (const a of links) expect(a.querySelector('svg'), a.getAttribute('aria-label')!).not.toBeNull();
  });

  it('stays four when a wallet connects: Dashboard is in the drawer', () => {
    account.isConnected = true;
    expect(tabs().map((a) => a.getAttribute('aria-label'))).toEqual(['Island', 'Lock', 'Launch', 'Swap']);
  });

  it('opens Island on the home and Lock on the list of pools', () => {
    const href = (name: string) => screen.getByRole('link', { name }).getAttribute('href');
    tabs();
    expect(href('Island')).toBe('/');
    expect(href('Lock')).toBe('/earn');
    expect(href('Launch')).toBe('/launch');
  });
});

describe('BottomNav: a word is lit on every page it owns', () => {
  it('Island on the home, its hall asked for or not', () => {
    expect(lit('/')).toEqual(['Island']);
    expect(lit('/', '#hall')).toEqual(['Island']);
  });

  it.each(['/bayla', '/pepe', '/towelie', '/nb1', '/island', '/gallery'])('Island on %s, a door or an island page', (path) => {
    expect(lit(path)).toEqual(['Island']);
  });

  it('Lock under a pool, on the pool its door opens', () => {
    expect(lit('/earn/bayla')).toEqual(['Lock']);
  });

  it.each([
    ['Lock', LOCK_SECTION],
    ['Launch', LAUNCH_SECTION],
    ['Swap', SWAP_SECTION],
  ] as const)('%s on each of its own pages', (label, section) => {
    for (const item of section.items) expect(lit(item.to), item.to).toEqual([label]);
  });

  it.each(['/pools', '/liquidity', '/trust', '/changelog', '/dashboard'])('nothing on %s', (path) => {
    account.isConnected = true;
    expect(lit(path)).toEqual([]);
  });

  it('says which word is the page you are on', () => {
    tabs('/earn');
    expect(screen.getByRole('link', { name: 'Lock' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Island' })).not.toHaveAttribute('aria-current');
  });
});

// Owner, 2026-10-17, of the word Island replaced: inside a room it opens that room's own page and owns it.
describe('BottomNav: Island stays in the room', () => {
  it("inside BAYLA's room, Island opens /bayla and is the word lit there", () => {
    window.localStorage.setItem('tegridy-bungalow', 'bayla');
    tabs('/bayla');
    expect(screen.getByRole('link', { name: 'Island' }).getAttribute('href')).toBe('/bayla');
    cleanup();
    expect(lit('/bayla')).toEqual(['Island']);
  });
});
