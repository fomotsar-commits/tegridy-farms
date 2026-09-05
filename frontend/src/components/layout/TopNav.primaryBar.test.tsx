/**
 * The top bar after the 2026-09-05 rewrite: six words, no dropdown.
 *
 * ⚠️ THIS FILE REPLACES TWO. `TopNav.condensedMenu.test.tsx` and
 * `TopNav.moreMenu.test.tsx` both tested the "More" dropdown — its collapsed
 * rows, its `aria-expanded`, its Escape handling, its `aria-controls` never
 * pointing at an unmounted popup. That dropdown is deleted, so those assertions
 * had nothing left to protect and were removed rather than adapted.
 *
 * What did NOT go away is the property they existed to guarantee, and it is what
 * this file pins instead: NOTHING BECAME UNREACHABLE. A nav rewrite's real
 * failure mode is not an ugly bar — it is a destination that quietly stops
 * having any path to it, which looks identical to a destination nobody visits.
 *
 * The other half of "nothing was lost" — that every section item survives as a
 * tab on its host — is SectionHost.test.tsx's job, as it was before.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: Object.assign(() => null, { Custom: () => null }),
}));
// TopNav reads `useAccount` to decide whether Dashboard is in the bar. The real
// hook throws without a WagmiProvider, and standing one up here would drag a
// chain config into a test about link text — so the connection state is the mock
// surface, and each test says which state it is asserting.
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
import { NAV_SECTIONS, MORE_NAV } from '../../lib/navConfig';

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

/** The desktop row. There is exactly one element with this accessible name. */
function bar() {
  return screen.getByRole('navigation', { name: 'Main navigation' });
}

describe('TopNav — the primary bar', () => {
  it('renders one word per section, and nothing else', () => {
    mount();
    const links = within(bar()).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(NAV_SECTIONS.map((s) => s.heading));
  });

  it('has no "More" disclosure left to open', () => {
    mount();
    // The button and its popup are both gone. Queried by the exact accessible
    // names the deleted dropdown used, so a revert fails here.
    expect(screen.queryByRole('button', { name: 'More navigation' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'More destinations' })).toBeNull();
  });

  it('points each word at a destination inside its own section', () => {
    mount();
    for (const section of NAV_SECTIONS) {
      const link = within(bar()).getByRole('link', { name: section.heading });
      const to = link.getAttribute('href');
      // `primaryTo` (Swap's bungalow-aware landing) must still be one of the
      // section's own items, or the word would open a page whose tab strip
      // highlights nothing.
      expect(
        section.items.map((i) => i.to),
        `"${section.heading}" points at ${to}, which is not one of its items`,
      ).toContain(to);
    }
  });

  it('keeps Dashboard out of the bar until a wallet is connected', () => {
    mount('/', false);
    expect(within(bar()).queryByRole('link', { name: 'Dashboard' })).toBeNull();
  });

  it('appends Dashboard LAST once connected — never first, which is where it used to be', () => {
    mount('/', true);
    const labels = within(bar()).getAllByRole('link').map((l) => l.textContent);
    expect(labels[labels.length - 1]).toBe('Dashboard');
    expect(labels).toHaveLength(NAV_SECTIONS.length + 1);
  });

  it('lights a word for its WHOLE section, not just its own href', () => {
    // Standing on /scan — a Check destination that is NOT the section's hub.
    // A plain <NavLink to={hub}> would render this inactive, which is the bug
    // sectionIsActive() exists to prevent.
    mount('/scan');
    const check = within(bar()).getByRole('link', { name: 'Check' });
    expect(check.className).toContain('active');
  });

  it('leaves every other word unlit on that same page', () => {
    mount('/scan');
    for (const s of NAV_SECTIONS.filter((x) => x.heading !== 'Check')) {
      const link = within(bar()).getByRole('link', { name: s.heading });
      expect(link.className, `"${s.heading}" should be dim on /scan`).not.toContain('active');
    }
  });
});

/**
 * THE REACHABILITY GUARANTEE.
 *
 * The drawer is the whole nav below 800px — BottomNav carries five tabs at most
 * — so if a destination is missing from BOTH the desktop bar's sections and this
 * drawer, it is reachable only by typing its URL.
 */
describe('TopNav — the mobile drawer is a complete nav', () => {
  function openDrawer(connected = false) {
    mount('/', connected);
    // fireEvent, not `.click()` — React's synthetic handler is delegated and a
    // bare DOM click does not reliably reach it in jsdom.
    fireEvent.click(screen.getByRole('button', { name: /open navigation menu/i }));
    return screen;
  }

  it('lists every sectioned destination, expanded', () => {
    openDrawer();
    // Each item's canonical label appears at least once. Not an equality check:
    // the drawer also renders the six section words as group headings, and the
    // desktop bar is in the same tree.
    for (const item of MORE_NAV) {
      expect(
        screen.getAllByText(item.label).length,
        `${item.to} ("${item.label}") is not in the drawer`,
      ).toBeGreaterThan(0);
    }
  });
});
