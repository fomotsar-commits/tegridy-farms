// The phone bar reads Heat · Rooms · Lock · Launch · Swap (owner, 2026-10-03). Five tabs is the
// ceiling at 390px, so Dashboard is a drawer row. A word is lit on every page it owns, as the top
// bar's is: lit only on its own URL, a word went dark one press away from it.

import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});

describe('BottomNav: the five words', () => {
  it('reads Heat · Rooms · Lock · Launch · Swap, each with its icon', () => {
    const links = tabs();
    expect(links.map((a) => a.getAttribute('aria-label'))).toEqual(['Heat', 'Rooms', 'Lock', 'Launch', 'Swap']);
    for (const a of links) expect(a.querySelector('svg'), a.getAttribute('aria-label')!).not.toBeNull();
  });

  it('stays five when a wallet connects: Dashboard is in the drawer', () => {
    account.isConnected = true;
    expect(tabs().map((a) => a.getAttribute('aria-label'))).toEqual(['Heat', 'Rooms', 'Lock', 'Launch', 'Swap']);
  });

  it('opens Heat on the home, Rooms on the hall and Lock on the list of pools', () => {
    const href = (name: string) => screen.getByRole('link', { name }).getAttribute('href');
    tabs();
    expect(href('Heat')).toBe('/');
    expect(href('Rooms')).toBe('/#hall');
    expect(href('Lock')).toBe('/earn');
    expect(href('Launch')).toBe('/launch');
  });
});

describe('BottomNav: a word is lit on every page it owns', () => {
  it('Heat on the home, and Rooms once the hall is asked for', () => {
    expect(lit('/')).toEqual(['Heat']);
    expect(lit('/', '#hall')).toEqual(['Rooms']);
  });

  it.each(['/bayla', '/pepe', '/towelie', '/nb1'])('Rooms on the door %s', (path) => {
    expect(lit(path)).toEqual(['Rooms']);
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

  it.each(['/solana-lp', '/liquidity', '/trust', '/changelog', '/dashboard'])('nothing on %s', (path) => {
    account.isConnected = true;
    expect(lit(path)).toEqual([]);
  });

  it('says which word is the page you are on', () => {
    tabs('/earn');
    expect(screen.getByRole('link', { name: 'Lock' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Heat' })).not.toHaveAttribute('aria-current');
  });
});
