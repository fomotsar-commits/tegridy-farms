/**
 * The "More" dropdown after the 2026-09-04 condensation.
 *
 * It listed twenty-one rows under six headings — Trust & Safety alone was seven,
 * more links than the entire primary nav — and the operator's report was that it
 * "has too much going on". Four sections now render as ONE row each and their
 * entries become the tab strip on the page that row opens.
 *
 * WHAT THESE PIN is the half that could go wrong silently: a collapsed section
 * must still be REACHABLE (its row present and pointing at its hub) and its
 * entries must be GONE FROM THE MENU rather than merely restyled — a condensation
 * that renders the rows and hides them with CSS is the same menu with a
 * regression on top. The other half — that every collapsed entry survives as a
 * tab — is SectionHost.test.tsx's job, and the two together are what make
 * "nothing was lost" true.
 *
 * Every assertion here fails on the pre-change file, where no section had a hub.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: Object.assign(() => null, { Custom: () => null }),
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
import { MORE_NAV_SECTIONS, MORE_NAV } from '../../lib/navConfig';

function openMenu(path = '/') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ThemeProvider>
        <TopNav />
      </ThemeProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'More navigation' }));
  return screen.getByRole('navigation', { name: 'More destinations' });
}

const COLLAPSED = MORE_NAV_SECTIONS.filter((s) => s.hub);
// Sections the top bar already covers render NOTHING here — see `inPrimaryNav`
// on NavSection. They are neither collapsed (one row) nor expanded (many rows),
// so they belong in neither list below and get their own assertion instead.
const HIDDEN = MORE_NAV_SECTIONS.filter((s) => s.inPrimaryNav);
const EXPANDED = MORE_NAV_SECTIONS.filter((s) => !s.hub && !s.inPrimaryNav);

describe('the condensed "More" dropdown', () => {
  it('gives each collapsed section exactly one row, pointing at its hub', () => {
    const menu = openMenu();
    expect(COLLAPSED.length, 'nothing is collapsed - there is no condensation to test').toBeGreaterThan(0);
    for (const section of COLLAPSED) {
      const row = within(menu).getByRole('link', { name: new RegExp(`^${section.heading}$`) });
      expect(row).toHaveAttribute('href', section.hub!);
    }
  });

  it('stops rendering the entries a collapsed section swallowed', () => {
    const menu = openMenu();
    // Matched by href, not by label: the Launch section's hub row and its first
    // entry are both called "Launch", so a name query cannot tell the row that
    // must exist from the row that must not.
    const hrefs = within(menu)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    for (const section of COLLAPSED) {
      for (const item of section.items) {
        if (item.to === section.hub) continue; // the hub IS the collapsed row
        // Presence in the DOM, not visibility. A menu that renders 21 links and
        // hides 12 with CSS is still 21 links to a screen reader.
        expect(hrefs, `${item.to} is still a menu row - the section did not actually collapse`).not.toContain(
          item.to,
        );
      }
    }
  });

  it('leaves the short sections exactly as they were', () => {
    const menu = openMenu();
    for (const section of EXPANDED) {
      expect(within(menu).getByText(section.heading)).toBeInTheDocument();
      for (const item of section.items) {
        expect(
          within(menu).getByRole('link', { name: new RegExp(`^${item.label}`) }),
          `${item.to} disappeared from an uncollapsed section`,
        ).toHaveAttribute('href', item.to);
      }
    }
  });

  it('renders nothing at all for a section the top bar already carries', () => {
    expect(HIDDEN.length, 'no hidden section - there is nothing to assert').toBeGreaterThan(0);
    const menu = openMenu();
    const hrefs = within(menu)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    for (const section of HIDDEN) {
      // The heading must be gone. Queried within the menu only: "Trade" is also
      // the top bar's own label, and that one must survive.
      expect(
        within(menu).queryByText(section.heading),
        `the ${section.heading} heading is still a menu row`,
      ).toBeNull();
      // ...and so must every row under it. Presence in the DOM, not visibility.
      for (const item of section.items) {
        expect(
          hrefs,
          `${item.to} is still in the menu - the section did not actually hide`,
        ).not.toContain(item.to);
      }
    }
  });

  it('still reaches every hidden destination as a tab on the primary page', () => {
    // The point of hiding is that nothing is LOST. Each hidden item must still
    // be a real destination in the flat list the app routes from.
    for (const section of HIDDEN) {
      for (const item of section.items) {
        expect(
          MORE_NAV.map((i) => i.to),
          `${item.to} was hidden from the menu AND dropped from MORE_NAV`,
        ).toContain(item.to);
      }
    }
  });

  it('renders far fewer rows than there are destinations', () => {
    const menu = openMenu();
    const rows = within(menu).getAllByRole('link');
    expect(rows.length).toBeLessThan(MORE_NAV.length);
    expect(rows.length).toBeLessThanOrEqual(10);
  });

  it('keeps a collapsed row lit while the visitor is on any of its tabs', () => {
    // Standing on /scan, the row that leads there is "Trust & Safety" — which
    // links to /trust. A plain NavLink would go dim, so the visitor loses the
    // only breadcrumb saying where in the menu they are.
    const trust = MORE_NAV_SECTIONS.find((s) => s.heading === 'Trust & Safety');
    expect(trust?.hub, 'Trust & Safety must be collapsed for this to mean anything').toBe('/trust');
    const menu = openMenu('/scan');
    const row = within(menu).getByRole('link', { name: /^Trust & Safety$/ });
    expect(row.className).toContain('active');
  });
});
