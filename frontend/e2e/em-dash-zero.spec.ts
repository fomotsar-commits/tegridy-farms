import { test, expect, type Page } from '@playwright/test';
import {
  gotoRoute,
  waitForQuiescence,
  gotoNakamigos,
  ROUTES,
  navigablePath,
  GECKO_EDGE_GLOB,
} from './fixtures/routes';

// Element I: zero em dashes in venue-voice prose, and an exact count per route until then.
// A text node that contains U+2014 and whose trimmed content is not exactly U+2014 is prose
// and counts; a node that is exactly U+2014 is the placeholder a failed read renders, and
// passes by construction. Text nodes, never innerText, which glues a placeholder to the
// prose beside it. Each count holds both ways: a new dash fails its route, and so does a
// fixed one until the number comes down.

// A CI measurement under `vite preview`: no /api function (a few /api paths proxy live, per
// vite.config.ts), no VITE_INDEXER_URL and no push keys, so production renders branches this
// table never walks. The chart's own branches are guarded in src/components/chart/chartCopyDashes.test.ts.

/** Venue-voice routes, counted on the desktop production build. At 0 a route is finished
 *  and fails on its first prose node, naming the copy. */
const VENUE_VOICE_DEBT: Record<string, number> = {
  '/': 0,
  // The 404 catch-all, reached by a path that matches no route (navigablePath).
  '/this-path-matches-no-route-a11y-sweep': 0,
  '/faq': 0,
  '/history': 0,
  '/start': 0,
  '/admin': 0,
  '/launch/0x0000000000000000000000000000000000000000': 0,
  '/vesting': 0,
  '/farm': 0,
  '/island': 0,
  '/airdrop': 0,
  '/exposure': 0,
  '/chart': 0,
  '/checkout': 0,
  '/dashboard': 0,
  '/deployer': 0,
  '/scan': 0,
  '/swap': 0,
  '/eth-curve/0x0000000000000000000000000000000000000000': 0,
  '/gallery': 0,
  '/security': 0,
  // Records: the record subtree is skipped by structure, and the chrome around it is held at 0.
  '/changelog': 0,
  '/contracts': 0,
  '/nakamigos': 1,
  '/terms': 3,
  '/terminal': 2,
  '/solana': 4,
  '/launch-simulator': 4,
  '/leaderboard': 3,
  '/community': 2,
  '/liquidity': 6,
  '/privacy': 7,
  '/trust': 7,
  '/pools': 9,
  '/nft-finance': 10,
  '/developers': 10,
  '/risks': 3,
  '/copy-trading': 11,
  '/tax': 13,
  '/curve-launch': 13,
  '/eth-curve': 15,
  '/alerts': 17,
  // ScoringRules' written paragraphs; the Cup's coverage notice is a data-unread-ledger.
  '/competitions': 3,
  '/yield': 21,
  '/launch': 26,

};

/** The four GeckoTerminal routes, read with the feed aborted, so the degraded branch is
 *  what is pinned. The abort needs serviceWorkers: 'block' in playwright.config and a glob
 *  that matches the same-origin edge: import GECKO_EDGE_GLOB, never a literal. A dead stub
 *  fails nothing; it measures the SPA fallback's parse failure instead. */
const FEED_ROUTES = new Set(['/terminal', '/chart', '/copy-trading', '/competitions']);

/** `/nakamigos` opens on a full-viewport splash with no `main` behind it, so it
 *  needs the fixture's own driver rather than the standard mount probe. */
const NAKAMIGOS = '/nakamigos';

interface ProseHit {
  text: string;
  owner: string;
}

/** Every prose em-dash text node on the page, in document order. */
async function proseDashes(page: Page): Promise<ProseHit[]> {
  return page.evaluate(() => {
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
    const hits: { text: string; owner: string }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const data = node.textContent ?? '';
      if (!data.includes('—')) continue;
      const el = node.parentElement;
      if (!el) continue;
      // Never rendered, or hidden from everyone: not copy anybody reads.
      if (SKIP.has(el.tagName)) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      // A record keeps its words; src/pages/recordSurfaces.test.ts pins who may declare one.
      if (el.closest('[data-record]')) continue;
      // TOWELI's voice (a toweli data-voice section or data-room band), not the venue's.
      if (el.closest('[data-voice="toweli"]') || el.closest('[data-room="toweli"]')) continue;
      // A report of failed reads (data-unread-ledger) is assembled from what the network
      // answered, so it is not copy and its length is not this repo's.
      if (el.closest('[data-unread-ledger]')) continue;
      // THE DISCRIMINATOR. Exactly U+2014 is the unreadable placeholder.
      if (data.trim() === '—') continue;
      hits.push({ text: data.trim().slice(0, 90), owner: el.tagName });
    }
    return hits;
  });
}

/** Mount the route and let the whileInView sections arrive before reading. */
async function settle(page: Page, path: string) {
  if (path === NAKAMIGOS) await gotoNakamigos(page);
  else await gotoRoute(page, path);
  // Three passes down: one scrollTo lands before the sections it reveals have
  // mounted, and each newly mounted section makes the page taller.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
  }
  // The repo's settle, not a fixed sleep, which under-reported findings on /farm.
  await waitForQuiescence(page, { quietMs: 600, timeout: 12_000 });
}

test.describe('element I: em dashes in venue-voice prose', () => {
  // Desktop project only, matched by name: mobile-chrome is chromium too, and a phone width
  // renders a different set of components. Copy only a narrow viewport renders (BottomNav,
  // the drawer) is not walked and not claimed.

  for (const [path, budget] of Object.entries(VENUE_VOICE_DEBT)) {
    test(`${path} carries ${budget} prose em dash${budget === 1 ? '' : 'es'}`, async ({ page }) => {
      test.skip(test.info().project.name !== 'chromium', 'the debt here is a desktop measurement');
      test.slow();
      await page.addInitScript(() => {
        try {
          localStorage.setItem('tegridy-onboarding-seen', '1');
          localStorage.setItem('tegridy_telemetry_consent', 'denied');
          // 'venue', not the wallet fixture's 'toweli': an active bungalow puts a dashed
          // footer node (Footer.tsx) on every route.
          localStorage.setItem('tegridy-bungalow', 'venue');
        } catch { /* private mode */ }
      });
      if (FEED_ROUTES.has(path)) {
        await page.route(GECKO_EDGE_GLOB, (r) => r.abort());
      }

      await settle(page, path);

      const hits = await proseDashes(page);
      const shown = hits.slice(0, 8).map((h) => `  ${h.owner}: ${h.text}`).join('\n');

      if (budget === 0) {
        // Finished: fail on the first prose node, and name the copy.
        expect(hits.length, `${path} is at zero and gained prose em dashes:\n${shown}`).toBe(0);
        return;
      }

      // Both ways: fewer than the number here is a fix, and it fails until the number follows.
      expect(
        hits.length,
        hits.length > budget
          ? `${path} gained prose em dashes (${budget} -> ${hits.length}). First few:\n${shown}`
          : `${path} is DOWN to ${hits.length} from ${budget}. Good: lower the number in VENUE_VOICE_DEBT to ${hits.length} (or delete the entry if it is 0).`,
      ).toBe(budget);
    });
  }

  // A skipped record is honest only while it renders, labeled as the venue's, and still
  // holds the dashes it was written with; a record that reads clean was swept.
  for (const path of ['/changelog', '/contracts']) {
    test(`${path} keeps its record, labeled as the venue's`, async ({ page }) => {
      test.skip(test.info().project.name !== 'chromium', 'measured on the desktop project only');
      test.slow();
      await page.addInitScript(() => {
        try {
          localStorage.setItem('tegridy-onboarding-seen', '1');
          localStorage.setItem('tegridy_telemetry_consent', 'denied');
          localStorage.setItem('tegridy-bungalow', 'venue');
        } catch { /* private mode */ }
      });
      await settle(page, path);

      const record = page.locator('[data-record]');
      await expect(record).toHaveCount(1);
      await expect(
        page.getByText(/^The venue's record\. Entries keep the words they were written in\.$/),
      ).toBeVisible();
      const recordText = await record.evaluate((el) => el.textContent ?? '');
      expect(recordText.length, `${path}'s record rendered empty`).toBeGreaterThan(500);
      expect(recordText, `${path}'s record reads clean of dashes, so it was swept`).toContain('—');
    });
  }

  // The venue table walks venue-voice routes only, by the route census.
  test('the debt table walks only routes the census gives the venue', () => {
    for (const path of Object.keys(VENUE_VOICE_DEBT)) {
      const route = ROUTES.find((r) => navigablePath(r) === path);
      expect(route, `${path} is not in the route fixture`).toBeTruthy();
      expect(['venue', 'record', 'legal'], `${path} has census voice ${route?.voice}`).toContain(route?.voice);
    }
  });
});

// Element I in the rooms: a second table, owed by different people. Fourteen doors, the
// thirteen registry ids plus the /towelie alias. On /toweli and /towelie TOWELI's protocol
// copy counts, because in its own room it is that room's prose.
const ROOM_VOICE_DEBT: Record<string, number> = {
  // The settled rooms are at 0 and fail on their first prose dash (roomProse.test.tsx guards
  // the same sources on every push). The TOWELI-skin doors carry the protocol cluster.
  '/toweli': 22,
  '/towelie': 22,
  '/bayla': 0,
  '/pepe': 0,
  '/qr': 0,
  '/mfer': 0,
  '/bnkr': 0,
  '/drb': 0,
  '/bobo': 0,
  '/jbm': 0,
  '/soy': 0,
  '/brainlet': 0,
  '/rizz': 0,
  '/nb1': 0,
};

test.describe('element I: em dashes in the rooms', () => {
  for (const [path, budget] of Object.entries(ROOM_VOICE_DEBT)) {
    test(`${path} carries ${budget} prose em dash${budget === 1 ? '' : 'es'}`, async ({ page }) => {
      test.skip(test.info().project.name !== 'chromium', 'the debt here is a desktop measurement');
      test.slow();
      await page.addInitScript(() => {
        try {
          localStorage.setItem('tegridy-onboarding-seen', '1');
          localStorage.setItem('tegridy_telemetry_consent', 'denied');
          // The door sets its own skin; this is the sentinel a stranger carries in.
          localStorage.setItem('tegridy-bungalow', 'venue');
        } catch { /* private mode */ }
      });
      await settle(page, path);

      const hits = await proseDashes(page);
      const shown = hits.slice(0, 8).map((h) => `  ${h.owner}: ${h.text}`).join('\n');

      if (budget === 0) {
        expect(hits.length, `${path} is at zero and gained prose em dashes:\n${shown}`).toBe(0);
        return;
      }
      expect(
        hits.length,
        hits.length > budget
          ? `${path} gained prose em dashes (${budget} -> ${hits.length}). First few:\n${shown}`
          : `${path} is DOWN to ${hits.length} from ${budget}. Good: lower the number in ROOM_VOICE_DEBT to ${hits.length}.`,
      ).toBe(budget);
    });
  }

  // Every door the app routes, and only doors: a door is the home page under a resident's
  // skin, which leaves out TOWELI's protocol rooms (counted above, under the census).
  test('the room table walks every door the app routes, and only doors', () => {
    const doors = ROUTES
      .filter((r) => r.owner === 'pages/HomePage.tsx' && r.voice !== 'venue')
      .map(navigablePath);
    expect(doors.length, 'the app routes fourteen doors, thirteen ids plus the towelie alias').toBe(14);
    expect(Object.keys(ROOM_VOICE_DEBT).sort()).toEqual([...doors].sort());
  });
});

// Element I on each room's farm, /farm?bungalow=<id>, keyed by registry id. The reads are
// sealed (every /api path and every host but localhost aborted), so each pool card renders
// its unread branch and the count holds from run to run; live-read copy is not walked here.
// toweli's farm is its own room's prose, and nb1, not yet live, falls through to the venue's.
const ROOM_FARM_DEBT: Record<string, number> = {
  toweli: 11,
  bayla: 0,
  bobo: 0,
  soy: 0,
  brainlet: 0,
  rizz: 0,
  // The six EVM ladders: the unread card's "The pool could not be read just now" line.
  pepe: 1,
  qr: 1,
  mfer: 1,
  bnkr: 1,
  drb: 1,
  jbm: 1,
  nb1: 0,
};

test.describe("element I: em dashes on each room's farm", () => {
  for (const [id, budget] of Object.entries(ROOM_FARM_DEBT)) {
    const path = `/farm?bungalow=${id}`;
    test(`${path} carries ${budget} prose em dash${budget === 1 ? '' : 'es'}`, async ({ page }) => {
      test.skip(test.info().project.name !== 'chromium', 'the debt here is a desktop measurement');
      test.slow();
      await page.addInitScript(() => {
        try {
          localStorage.setItem('tegridy-onboarding-seen', '1');
          localStorage.setItem('tegridy_telemetry_consent', 'denied');
          localStorage.setItem('tegridy-bungalow', 'venue');
        } catch { /* private mode */ }
      });
      await page.route('**/api/**', (r) => r.abort());
      await page.route((url) => url.hostname !== 'localhost', (r) => r.abort());
      await settle(page, path);

      const hits = await proseDashes(page);
      const shown = hits.slice(0, 8).map((h) => `  ${h.owner}: ${h.text}`).join('\n');

      if (budget === 0) {
        expect(hits.length, `${path} is at zero and gained prose em dashes:\n${shown}`).toBe(0);
        return;
      }
      expect(
        hits.length,
        hits.length > budget
          ? `${path} gained prose em dashes (${budget} -> ${hits.length}). First few:\n${shown}`
          : `${path} is DOWN to ${hits.length} from ${budget}. Good: lower the number in ROOM_FARM_DEBT to ${hits.length}.`,
      ).toBe(budget);
    });
  }

  test('the farm table walks every registry id the doors route, once', () => {
    const ids = ROUTES
      .filter((r) => r.owner === 'pages/HomePage.tsx' && r.voice !== 'venue')
      .map((r) => navigablePath(r).slice(1))
      .filter((id) => id !== 'towelie');
    expect(ids.length, 'thirteen registry ids').toBe(13);
    expect(Object.keys(ROOM_FARM_DEBT).sort()).toEqual([...ids].sort());
  });
});
