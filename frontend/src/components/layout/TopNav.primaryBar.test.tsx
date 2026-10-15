// The top bar reads Heat · Rooms · Lock · Launch · Swap (owner, 2026-10-03), and everything
// else is one drawer that opens at every width. navReach.test.tsx proves no page is stranded;
// SectionHost.test.tsx that every section item survives as a tab on its host.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: Object.assign(() => null, { Custom: () => null }),
}));
// The real hook throws without a WagmiProvider; each test says which state it asserts.
const mockIsConnected = vi.hoisted(() => ({ value: false }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: mockIsConnected.value }),
}));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    },
  );
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  };
});
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));

import { TopNav } from './TopNav';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { BAR_NAV, DRAWER_SECTIONS, MORE_NAV } from '../../lib/navConfig';

const WORDS = ['Heat', 'Rooms', 'Lock', 'Launch', 'Swap'];

function mount(path = '/', connected = false) {
  mockIsConnected.value = connected;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ThemeProvider>
        <TopNav />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

/** The wide-screen row. There is exactly one element with this accessible name. */
function bar() {
  return screen.getByRole('navigation', { name: 'Main navigation' });
}

function openDrawer(path = '/', connected = false) {
  mount(path, connected);
  // fireEvent: React's handler is delegated and a bare DOM click does not reliably reach it.
  fireEvent.click(screen.getByRole('button', { name: /open navigation menu/i }));
  return screen.getByRole('dialog', { name: 'Navigation menu' });
}

describe('TopNav: the bar', () => {
  it('reads Heat · Rooms · Lock · Launch · Swap, and nothing else', () => {
    mount();
    expect(within(bar()).getAllByRole('link').map((l) => l.textContent)).toEqual(WORDS);
  });

  it('has no "More" disclosure', () => {
    mount();
    expect(screen.queryByRole('button', { name: 'More navigation' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'More destinations' })).toBeNull();
  });

  it('opens Heat on the home, Rooms on the hall of doors, and each other word on its section', () => {
    mount();
    for (const w of BAR_NAV) {
      expect(within(bar()).getByRole('link', { name: w.label }).getAttribute('href'), w.label).toBe(w.to);
    }
    expect(within(bar()).getByRole('link', { name: 'Rooms' }).getAttribute('href')).toBe('/#hall');
    expect(within(bar()).getByRole('link', { name: 'Lock' }).getAttribute('href')).toBe('/earn');
  });

  it('keeps Dashboard off the bar, connected or not', () => {
    mount('/', true);
    expect(within(bar()).getAllByRole('link').map((l) => l.textContent)).toEqual(WORDS);
  });

  it.each([
    ['/', 'Heat'],
    ['/bayla', 'Rooms'],
    ['/earn/pepe', 'Lock'],
    ['/nft-finance', 'Lock'],
    ['/eth-curve', 'Launch'],
    ['/solana', 'Swap'],
  ])('lights exactly one word on %s: %s', (path, word) => {
    mount(path);
    const lit = within(bar())
      .getAllByRole('link')
      .filter((l) => l.className.split(/\s+/).includes('active'));
    expect(lit.map((l) => l.textContent)).toEqual([word]);
    expect(lit[0]).toHaveAttribute('aria-current', 'page');
  });

  it.each(['/solana-lp', '/trust', '/island'])('lights no word on %s, a drawer page', (path) => {
    mount(path);
    const lit = within(bar())
      .getAllByRole('link')
      .filter((l) => l.className.split(/\s+/).includes('active') || l.hasAttribute('aria-current'));
    expect(lit).toEqual([]);
  });
});

describe('TopNav: the drawer', () => {
  it('opens at every width: neither its button nor its panel hides at 800px', () => {
    const drawer = openDrawer();
    const button = screen.getByRole('button', { name: /open navigation menu/i });
    for (const el of [button, drawer]) {
      expect(el.className, 'the drawer is hidden on a wide screen again').not.toMatch(/min-\[800px\]:hidden/);
    }
  });

  it('carries Pools, Check and Island, one row each, with Pools first and on Solana LP', () => {
    const drawer = openDrawer();
    const rows = DRAWER_SECTIONS.map((s) => within(drawer).getByRole('link', { name: s.heading }));
    expect(rows.map((r) => r.textContent)).toEqual(['Pools', 'Check', 'Island']);
    expect(rows[0]).toHaveAttribute('href', '/solana-lp');
    expect(rows[1]).toHaveAttribute('href', '/trust');
    expect(rows[2]).toHaveAttribute('href', '/island');
  });

  it("does not repeat the bar's words or print the tabs", () => {
    const drawer = openDrawer();
    for (const w of WORDS) {
      expect(within(drawer).queryByRole('link', { name: w }), `${w} is on the bar already`).toBeNull();
    }
    const hubs = new Set(DRAWER_SECTIONS.map((s) => s.primaryTo ?? s.hub));
    const reprinted = MORE_NAV.filter((i) => !hubs.has(i.to) && within(drawer).queryAllByText(i.label).length > 0);
    expect(reprinted.map((i) => i.label), 'the drawer is printing tab rows again').toEqual([]);
  });

  it('carries the records and the developer API', () => {
    const drawer = openDrawer();
    expect(within(drawer).getByRole('link', { name: 'Changelog' })).toHaveAttribute('href', '/changelog');
    expect(within(drawer).getByRole('link', { name: 'Contracts' })).toHaveAttribute('href', '/contracts');
    expect(within(drawer).getByRole('link', { name: 'Developer API' })).toHaveAttribute('href', '/developers');
  });

  it('carries Dashboard once a wallet connects, and not before', () => {
    expect(within(openDrawer('/', false)).queryByRole('link', { name: 'Dashboard' })).toBeNull();
  });

  it('carries Dashboard for a connected wallet', () => {
    expect(within(openDrawer('/', true)).getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/dashboard');
  });

  it('marks the row of the page you are on', () => {
    const drawer = openDrawer('/scan');
    expect(within(drawer).getByRole('link', { name: 'Check' })).toHaveAttribute('aria-current', 'page');
    expect(within(drawer).getByRole('link', { name: 'Pools' })).not.toHaveAttribute('aria-current');
  });
});
