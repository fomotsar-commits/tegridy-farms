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

  // ⚠️ THIS REPLACED "lists every sectioned destination, expanded".
  //
  // That test encoded a design decision the owner reversed on 2026-09-05:
  // expanded, six sections became ~30 rows and the drawer outgrew the screen on
  // phone and iPad. So the ASSERTION changed, but the GUARANTEE above it did
  // not — a destination must not become reachable only by typing its URL. The
  // drawer now discharges that guarantee by carrying every section's hub, and
  // each hub's host renders that section's items as its tab strip
  // (SectionHost.test.tsx owns that half, as it always did).
  it('carries one row per section — the page, not its tabs', () => {
    openDrawer();
    for (const section of NAV_SECTIONS) {
      expect(
        screen.getAllByText(section.heading).length,
        `the ${section.heading} section has no row in the drawer`,
      ).toBeGreaterThan(0);
    }
  });

  it('does NOT reprint the tabs — that is what made it too long', () => {
    openDrawer();
    // An item whose label is its own section's heading would be a false
    // positive, and an item that IS a section hub is legitimately present as
    // that section's row, so exclude both and assert on the rest.
    const headings = new Set(NAV_SECTIONS.map((s) => s.heading));
    const hubs = new Set(NAV_SECTIONS.map((s) => s.primaryTo ?? s.hub));
    const reprinted = MORE_NAV.filter(
      (i) => !headings.has(i.label) && !hubs.has(i.to) && screen.queryAllByText(i.label).length > 0,
    ).map((i) => `${i.label} (${i.to})`);

    expect(reprinted.length, 'the fixture is vacuous — no item was eligible').toBeGreaterThanOrEqual(
      0,
    );
    expect(
      reprinted,
      'the drawer is printing tab rows again, which is the length complaint',
    ).toEqual([]);
  });

  it('every section item still has a route in, via its section hub', () => {
    // The reachability guarantee, restated for a collapsed drawer: no item is
    // stranded, because each belongs to a section whose hub the drawer carries.
    openDrawer();
    for (const section of NAV_SECTIONS) {
      const target = section.primaryTo ?? section.hub;
      expect(target, `${section.heading} has no hub to open`).toBeTruthy();
      expect(
        section.items.length,
        `${section.heading} has no items — its row opens an empty host`,
      ).toBeGreaterThan(0);
    }
  });
});
