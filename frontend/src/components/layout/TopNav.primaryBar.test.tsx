// The top bar reads Island · Swap · Add · Lock · Launch (owner, 2026-10-03 and 2026-10-18; build 2,
// 2026-11-01), and everything else is one drawer that opens at every width. navReach.test.tsx
// proves no page is stranded; SectionHost.test.tsx that every section item survives as a tab on its host.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

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
import { BAR_NAV, INDEX_GROUPS, indexName } from '../../lib/navConfig';

const WORDS = ['Island', 'Swap', 'Add', 'Lock', 'Launch'];

/** Where the router is: what "Jump to" opened. */
function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function mount(path = '/', connected = false) {
  mockIsConnected.value = connected;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ThemeProvider>
        <TopNav />
        <Where />
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
  it('reads Island · Swap · Add · Lock · Launch, and nothing else', () => {
    mount();
    expect(within(bar()).getAllByRole('link').map((l) => l.textContent)).toEqual(WORDS);
  });

  it('has no "More" disclosure', () => {
    mount();
    expect(screen.queryByRole('button', { name: 'More navigation' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'More destinations' })).toBeNull();
  });

  it('opens Island on the home, and each other word on its section', () => {
    mount();
    for (const w of BAR_NAV) {
      expect(within(bar()).getByRole('link', { name: w.label }).getAttribute('href'), w.label).toBe(w.to);
    }
    expect(within(bar()).getByRole('link', { name: 'Island' }).getAttribute('href')).toBe('/');
    expect(within(bar()).getByRole('link', { name: 'Lock' }).getAttribute('href')).toBe('/earn');
  });

  it('keeps Dashboard off the bar, connected or not', () => {
    mount('/', true);
    expect(within(bar()).getAllByRole('link').map((l) => l.textContent)).toEqual(WORDS);
  });

  it.each([
    ['/', 'Island'],
    ['/bayla', 'Island'],
    ['/island', 'Island'],
    ['/earn/pepe', 'Lock'],
    ['/nft-finance', 'Lock'],
    ['/eth-curve', 'Launch'],
    ['/solana', 'Swap'],
    ['/pools', 'Add'],
    ['/liquidity', 'Add'],
  ])('lights exactly one word on %s: %s', (path, word) => {
    mount(path);
    const lit = within(bar())
      .getAllByRole('link')
      .filter((l) => l.className.split(/\s+/).includes('active'));
    expect(lit.map((l) => l.textContent)).toEqual([word]);
    expect(lit[0]).toHaveAttribute('aria-current', 'page');
  });

  it.each(['/trust', '/history'])('lights no word on %s, a drawer page', (path) => {
    mount(path);
    const lit = within(bar())
      .getAllByRole('link')
      .filter((l) => l.className.split(/\s+/).includes('active') || l.hasAttribute('aria-current'));
    expect(lit).toEqual([]);
  });
});

describe('TopNav: the menu', () => {
  it('opens at every width: neither its button nor its panel hides at 800px', () => {
    const drawer = openDrawer();
    const button = screen.getByRole('button', { name: /open navigation menu/i });
    for (const el of [button, drawer]) {
      expect(el.className, 'the drawer is hidden on a wide screen again').not.toMatch(/min-\[800px\]:hidden/);
    }
  });

  // Owner, 2026-10-18: "put marketplace, nft finance, and other things here that dont have a
  // direct access on the app"; 2026-10-19: organise them, on the desktop as on a phone.
  it("is the site's index: one group per section, in the order a visitor moves, then the records", () => {
    const drawer = openDrawer();
    const index = within(drawer).getByRole('navigation', { name: 'Site index' });
    expect(within(index).getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(
      ['Island', 'Swap', 'Pools', 'Lock', 'Launch', 'Check', 'Records'],
    );
  });

  it("lists every page under its group's word, named as its tab is; Pools lands on Venue AMM, Check on the overview", () => {
    const drawer = openDrawer();
    for (const group of INDEX_GROUPS) {
      const region = within(drawer).getByRole('region', { name: group.heading });
      if (group.to !== undefined) {
        expect(within(region).getByRole('link', { name: group.heading })).toHaveAttribute('href', group.to);
      }
      const pages = within(region).getAllByRole('link').filter((l) => l.textContent !== group.heading);
      expect(pages.map((l) => [l.textContent, l.getAttribute('href')]), group.heading)
        .toEqual(group.items.map((i) => [indexName(group, i), i.to]));
    }
    expect(within(drawer).getByRole('link', { name: 'Pools' })).toHaveAttribute('href', '/pools');
    expect(within(drawer).getByRole('link', { name: 'Check' })).toHaveAttribute('href', '/trust');
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

  it('marks the group and the page you are on', () => {
    const drawer = openDrawer('/scan');
    expect(within(drawer).getByRole('link', { name: 'Check' })).toHaveAttribute('aria-current', 'page');
    expect(within(drawer).getByRole('link', { name: 'Scanner' })).toHaveAttribute('aria-current', 'page');
    expect(within(drawer).getByRole('link', { name: 'Pools' })).not.toHaveAttribute('aria-current');
    expect(within(drawer).getByRole('link', { name: 'Gallery' })).not.toHaveAttribute('aria-current');
  });

  // The framer-motion stand-in above hands out a new component on every `m.div` read, so a
  // re-render remounts the panel: query the dialog and its field afresh after each change.
  const dialog = () => screen.getByRole('dialog', { name: 'Navigation menu' });
  const field = () => within(dialog()).getByRole('searchbox', { name: 'Jump to a page' });

  it('Jump to narrows the index to the pages called that, and Enter opens the first', () => {
    openDrawer();
    fireEvent.change(field(), { target: { value: 'chart' } });
    expect(within(dialog()).getAllByRole('link').map((l) => l.textContent)).toEqual(['Check', 'Charting']);
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(screen.queryByRole('dialog', { name: 'Navigation menu' })).toBeNull();
    expect(screen.getByTestId('where').textContent).toBe('/chart');
  });

  it("keeps a group whole when its own word is typed, and says so when nothing is called that", () => {
    openDrawer();
    fireEvent.change(field(), { target: { value: 'pools' } });
    expect(within(dialog()).getAllByRole('link').map((l) => l.textContent)).toEqual(['Pools', 'Add / Remove', 'Venue AMM', 'Range', 'Zap']);
    fireEvent.change(field(), { target: { value: 'zebra' } });
    expect(within(dialog()).queryAllByRole('link')).toEqual([]);
    expect(within(dialog()).getByRole('status').textContent).toMatch(/zebra/);
  });

  it('opens from Ctrl+K with the cursor in Jump to, and closes on it again', () => {
    mount();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const drawer = screen.getByRole('dialog', { name: 'Navigation menu' });
    expect(within(drawer).getByRole('searchbox', { name: 'Jump to a page' })).toHaveFocus();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.queryByRole('dialog', { name: 'Navigation menu' })).toBeNull();
  });

  it('leaves the cursor where it was when the button is tapped: a phone keeps its keyboard down', () => {
    const drawer = openDrawer();
    expect(within(drawer).getByRole('searchbox', { name: 'Jump to a page' })).not.toHaveFocus();
  });
});
