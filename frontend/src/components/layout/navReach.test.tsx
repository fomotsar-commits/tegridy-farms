// Nothing is reachable only by typing its URL. A visitor starts from the bar, the drawer or the
// footer; a page they land on adds its own tab strip, and the island lobby adds its doors. Every
// routed page a visitor may be sent to must be found that way. The few that are URL-only by
// design are named below with their reason.
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div> },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

import { Footer } from './Footer';
import {
  BAR_NAV,
  DASHBOARD_NAV,
  DRAWER_LINKS,
  INDEX_PAGES,
  DRAWER_SECTIONS,
  ISLAND_SECTION,
  NAV_SECTIONS,
  NUMBERS_TABS,
} from '../../lib/navConfig';
import { BUNGALOWS } from '../../lib/bungalows';
import { REDIRECT_ROUTES, ROUTES } from '../../../e2e/fixtures/routes';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The `to:` entries of a host page's own tab list, read from its source. */
function tabsOf(rel: string, list: string): string[] {
  const source = readFileSync(join(SRC, rel), 'utf8');
  const start = source.indexOf(`const ${list}`);
  expect(start, `${rel} has no ${list}`).toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf('];', start));
  const tos = [...body.matchAll(/to: '(\/[^']*)'/g)].map((m) => m[1]!);
  expect(tos.length, `read no tabs from ${rel}`).toBeGreaterThan(1);
  return tos;
}

/** URL-only on purpose. Each one is a decision, and listing one deletes it from here. */
const URL_ONLY: Record<string, string> = {
  '/airdrop': 'its rails are undeployed (navConfig.test.ts)',
  '/vesting': 'its rails are undeployed (navConfig.test.ts)',
  '/admin': 'an operator page behind a browser flag',
  '/start': "the home's own door, under the read field",
  '/towelie': 'another name for /toweli, whose door is in the hall',
  '/art-studio': 'a dev studio',
  '/bayla-studio': 'a studio',
  '/door-studio': 'a studio',
  // Owner, 2026-10-24: the Nakamigos marketplace left the home, the nav and the venue's
  // metadata (a drainer-profile surface on the venue's domain); the route stays.
  '/nakamigos': "the Nakamigos marketplace: off the nav since 2026-10-24; the bungalow rooms' Marketplace door still opens it",
};

/** Where a visitor can start: the four words, the drawer and the footer's own links. */
function starts(): string[] {
  const { container, unmount } = render(
    <MemoryRouter initialEntries={['/']}>
      <Footer />
    </MemoryRouter>,
  );
  const footer = [...container.querySelectorAll('footer a[href^="/"]')].map((a) => a.getAttribute('href')!);
  unmount();
  expect(footer.length, 'read no links from the footer').toBeGreaterThan(3);
  return [
    ...BAR_NAV.map((w) => w.to),
    ...DRAWER_SECTIONS.map((s) => s.primaryTo ?? s.hub),
    ...DRAWER_LINKS.map((l) => l.to),
    ...INDEX_PAGES.map((i) => i.to), // the menu's index: every section's pages, one tap each
    DASHBOARD_NAV.to, // a drawer row once a wallet connects
    ...footer,
  ].map((to) => to.split('#')[0]!);
}

function reachable(): Set<string> {
  // A page that is in a strip opens the whole strip; the island lobby opens its doors.
  const groups: string[][] = [
    ...NAV_SECTIONS.filter((s) => s !== ISLAND_SECTION).map((s) => s.items.filter((i) => !i.soon).map((i) => i.to)),
    NUMBERS_TABS.map((i) => i.to),
    tabsOf('pages/ActivityPage.tsx', 'ALL_TABS'),
    tabsOf('pages/InfoPage.tsx', 'TABS'),
    tabsOf('pages/LearnPage.tsx', 'TABS'),
  ];
  const seen = new Set(starts());
  // Island opens the home, whose hall carries a door for every room and a link to the island
  // lobby (VenueDoors.tsx; VenueDoors.test.tsx holds the link).
  if (seen.has('/')) {
    for (const b of BUNGALOWS) seen.add(`/${b.id}`);
    seen.add(ISLAND_SECTION.hub);
  }
  if (seen.has(ISLAND_SECTION.hub)) for (const i of ISLAND_SECTION.items) seen.add(i.to);
  for (let grew = true; grew; ) {
    grew = false;
    for (const g of groups) {
      if (!g.some((to) => seen.has(to))) continue;
      for (const to of g) {
        if (seen.has(to)) continue;
        seen.add(to);
        grew = true;
      }
    }
  }
  return seen;
}

describe('the nav strands no page', () => {
  it('reaches every routed page from the bar, the drawer or the footer, in a few taps', () => {
    const redirects = new Set(REDIRECT_ROUTES.map((r) => r.path));
    // Not routed in this build at all (the route table's 'not-yet-routed'), so nothing to reach.
    const notRouted = new Set(ROUTES.filter((r) => r.gate === 'not-yet-routed').map((r) => r.path));
    const seen = reachable();
    const offToday = new Set(NAV_SECTIONS.flatMap((s) => s.items).filter((i) => i.soon).map((i) => i.to));
    const stranded = ROUTES.map((r) => r.path).filter(
      (p) => !p.includes(':') && p !== '/*' && !redirects.has(p) && !notRouted.has(p) && !(p in URL_ONLY) && !offToday.has(p) && !seen.has(p),
    );
    expect(stranded, 'reachable only by typing the URL').toEqual([]);
  });

  it('names a reason for every page it lets stay URL-only, and each one is routed', () => {
    const routed = new Set(ROUTES.map((r) => r.path));
    for (const [path, why] of Object.entries(URL_ONLY)) {
      expect(routed, `${path} is no longer routed; drop it here`).toContain(path);
      expect(why.length).toBeGreaterThan(5);
    }
  });
});
