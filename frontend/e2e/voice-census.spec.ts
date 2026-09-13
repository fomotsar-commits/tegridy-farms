import { test, expect, type Page } from '@playwright/test';
import {
  AUDITABLE_ROUTES,
  gotoNakamigos,
  gotoRoute,
  navigablePath,
  waitForQuiescence,
  GECKO_EDGE_GLOB,
  type RouteSpec,
} from './fixtures/routes';

// WAVE SEVEN, RULING 2 (ROW Q): THE ROUTE CENSUS.
//
// "Every route speaks as the venue or lives behind /toweli." The island's test
// for that is this walk, not a list of spot fixes: every walkable route in
// e2e/fixtures/routes.ts carries a `voice` verdict, and this file reads it.
//
//   venue, record, legal  the page speaks as the venue. Outside a record
//                         (ruling 1) and outside a declared TOWELI section, it
//                         renders zero "Tegridy" and zero TOWELI-only content.
//   toweli                a TOWELI room route. Its protocol pages carry the
//                         room's band with the way back; its two doors are the
//                         room itself, under the venue's wordmark link home.
//   bungalow              another resident's door. e2e/bungalow-doors.spec.ts
//                         walks all thirteen ("no TOWELI anywhere"), and
//                         a11yRouteCoverage.test.ts holds this verdict to the
//                         registry's own doors, so they are not walked twice.
//
// TOWELI-ONLY CONTENT, DEFINED. The word alone is not it: TOWELI is one
// resident among thirteen, and a pool list, a chart pair or a room door naming
// it is the venue speaking about a resident. What is TOWELI's alone is its
// protocol: staking or locking it, its emissions, rewards and boosts, veTOWELI,
// the Gold Card paid in it. A text node that names TOWELI within one clause of
// any of those is counted. "Tegridy" is counted wherever it appears: the
// retired brand, and the on-chain names of the classic contracts, which may
// only render inside that protocol's own section.
//
// BY TEXT NODE, HIDDEN INCLUDED. A closed FAQ answer is still the page's copy
// (FAQPage keeps every answer on the page for exactly this reason), so the walk
// does not skip `hidden` or aria-hidden text. It skips scripts and styles, a
// record, a declared TOWELI section and the TOWELI room's band, by structure.
//
// THE DEBT. Some venue pages still speak TOWELI's protocol today, so this lands
// as the repo's knownViolations idiom: an exact count per route, both ways. A
// route missing from VOICE_DEBT is at zero and fails on its first node.

const TEGRIDY = 'tegridy';
const PROTOCOL = '(stak(e|ed|es|ing)|lock(ed|s|ing)?|emissions?|rewards?|boost(s|ed)?|gold card)';
const TOWELI_ONLY =
  `\\bveTOWELI\\b|\\bTOWELI\\b[^.!?]{0,60}\\b${PROTOCOL}\\b|\\b${PROTOCOL}\\b[^.!?]{0,60}\\bTOWELI\\b`;

/** Measured 2026-09-10 against the production build under `vite preview`. */
const VOICE_DEBT: Record<string, number> = {
  // The graduation fold ("How the rail works"), two nodes, both a question for
  // the island rather than a copy defect: "The Launch Afterlife" card sells a
  // launch on veTOWELI boosts and TOWELI emissions (TOWELI's section on /launch,
  // or a product claim to rewrite?), and the venue's own V4 hook is named by
  // its on-chain name, TegridyV4Hook (are on-chain identifiers exempt by
  // structure?). The third node the census found here, an OPERATOR instruction
  // printed to visitors, was a defect and is cut.
  '/launch': 2,
  // The binding document (voice 'legal'): the protocol description, the
  // disclaimer and the fee section name TOWELI or Tegridy, and a test requires
  // two of them. Moves only through its amendment clause and an owner's sign-off.
  '/terms': 3,
  // The general DeFi disclosure's lock-period paragraph ("Staked TOWELI tokens
  // are subject to lock periods"): liability text, left for the owner's review.
  '/risks': 1,
};

const NAKAMIGOS = '/nakamigos';
// The same four GeckoTerminal routes element I pins in their degraded branch,
// for the same reason: a count must not depend on a third party answering.
const FEED_ROUTES = new Set(['/terminal', '/chart', '/copy-trading', '/competitions']);

async function settle(page: Page, path: string) {
  if (path === NAKAMIGOS) await gotoNakamigos(page);
  else await gotoRoute(page, path);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
  }
  await waitForQuiescence(page, { quietMs: 600, timeout: 12_000 });
}

async function voiceHits(page: Page): Promise<string[]> {
  return page.evaluate(
    ({ tegridy, toweliOnly }) => {
      const T = new RegExp(tegridy, 'i');
      const O = new RegExp(toweliOnly, 'i');
      const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
      const hits: string[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const el = node.parentElement;
        if (!el || SKIP.has(el.tagName)) continue;
        if (el.closest('[data-record]') || el.closest('[data-voice="toweli"]') || el.closest('[data-room="toweli"]')) continue;
        const text = (node.textContent ?? '').trim();
        if (text && (T.test(text) || O.test(text))) hits.push(text.slice(0, 110));
      }
      return hits;
    },
    { tegridy: TEGRIDY, toweliOnly: TOWELI_ONLY },
  );
}

function seedVenueVisitor(page: Page, withSkin: boolean) {
  return page.addInitScript((skin) => {
    try {
      sessionStorage.setItem('tf_loaded', '1');
      localStorage.setItem('tegridy-onboarding-seen', '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
      // A VENUE visitor, the "seen, chose nothing" sentinel: the ruling is about
      // what a stranger who lands by URL is told. Not seeded on the TOWELI doors,
      // which set their own skin and reload once.
      if (skin) localStorage.setItem('tegridy-bungalow', 'venue');
    } catch { /* private mode */ }
  }, withSkin);
}

const JUDGED: RouteSpec[] = AUDITABLE_ROUTES.filter((r) => r.voice === 'venue' || r.voice === 'record' || r.voice === 'legal');
const ROOM: RouteSpec[] = AUDITABLE_ROUTES.filter((r) => r.voice === 'toweli');

test.describe('row Q: the route census', () => {
  test('every walkable route is judged here, or by the doors spec', () => {
    const walked = new Set([...JUDGED, ...ROOM].map((r) => r.path));
    for (const r of AUDITABLE_ROUTES) {
      expect(walked.has(r.path) || r.voice === 'bungalow', `${r.path} (${r.voice}) is walked by nobody`).toBe(true);
    }
  });

  for (const route of JUDGED) {
    const path = navigablePath(route);
    const budget = VOICE_DEBT[path] ?? 0;
    test(`${path} speaks as the venue (${route.voice}): ${budget} TOWELI-voice node${budget === 1 ? '' : 's'}`, async ({ page }) => {
      test.skip(test.info().project.name !== 'chromium', 'rendered copy is engine-independent; one desktop project is the honest amount of work');
      test.slow();
      await seedVenueVisitor(page, true);
      if (FEED_ROUTES.has(path)) await page.route(GECKO_EDGE_GLOB, (r) => r.abort());
      await settle(page, path);
      if (route.voice === 'record') await expect(page.locator('[data-record]')).toHaveCount(1);

      const hits = await voiceHits(page);
      const shown = hits.slice(0, 8).map((h) => `  ${h}`).join('\n');
      if (budget === 0) {
        expect(hits.length, `${path} speaks TOWELI's protocol as the venue:\n${shown}`).toBe(0);
        return;
      }
      expect(
        hits.length,
        hits.length > budget
          ? `${path} gained TOWELI-voice nodes (${budget} -> ${hits.length}):\n${shown}`
          : `${path} is DOWN to ${hits.length} from ${budget}. Lower VOICE_DEBT (or delete the entry at 0).`,
      ).toBe(budget);
    });
  }

  for (const route of ROOM) {
    const path = navigablePath(route);
    const isDoor = path === '/toweli' || path === '/towelie';
    test(`${path} opens in the TOWELI room, with the way back`, async ({ page }) => {
      test.skip(test.info().project.name !== 'chromium', 'rendered copy is engine-independent; one desktop project is the honest amount of work');
      test.slow();
      await seedVenueVisitor(page, !isDoor);
      await settle(page, path);
      if (isDoor) {
        // The room itself: TOWELI's own voice, and the venue's wordmark home.
        await expect(page.locator('a[href="/"][title="Back to memetics.finance"]').first()).toBeAttached();
        expect(await page.evaluate(() => document.body.innerText)).toContain('TOWELI');
        return;
      }
      const band = page.locator('[data-room="toweli"]');
      await expect(band).toHaveCount(1);
      await expect(band).toContainText('TOWELI room');
      await expect(band.getByRole('link', { name: 'Back to memetics.finance' })).toHaveAttribute('href', '/');
    });
  }
});
