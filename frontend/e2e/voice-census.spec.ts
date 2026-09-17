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
  // /launch's two nodes are GONE, both by answer eight's ruling 5 and neither
  // by deletion: the Launch Afterlife card's veTOWELI-and-emissions claim now
  // renders under a declared TOWELI section with its words unchanged, and the
  // venue's own V4 hook renders as the identifier it is, in code font. The
  // entry is deleted rather than set to 0 - a route with no entry is held at
  // zero and fails on its first node, which is the stronger of the two.
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
        // ANSWER EIGHT, ruling 5: A CONTRACT'S NAME IS AN IDENTIFIER, NOT PROSE.
        // `TegridyV4Hook` is what the artifact is called on chain; the venue
        // cannot rename it without misnaming a real thing an operator has to go
        // and find. Set in code font it is the same class as /contracts.
        //
        // SHAPED, NOT MERELY TAGGED. Only a <code> whose whole text is one
        // identifier is skipped - no spaces, no sentence. Wrapping a paragraph
        // in <code> still counts, so this is not a way to launder prose out of
        // the census, and that is the half of the rule worth keeping.
        const code = el.closest('code');
        if (code && /^[A-Za-z0-9_$.]+$/.test((code.textContent ?? '').trim())) continue;
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

  // ANSWER EIGHT, ruling 1: THE BAND IS FIRST IN FLOW AND NEVER COVERED.
  //
  // The island read "You are in the TOWE" on /tokenomics, with the section
  // tabs painting over the rest. Nothing here could see that: the band is
  // covered, not hidden, so toBeVisible() passes and toContainText() resolves
  // textContent without asking what a visitor can actually read or click.
  //
  // So ask the browser the only honest question, the one this repo already
  // learned to ask of controls: at the band's own centre, what does
  // elementFromPoint return? Both widths, because the band is flex-wrap, one
  // line at 1280 and two at 390 - a fix that hard-codes one height passes on
  // the desktop and re-covers the band on a phone.
  for (const route of ROOM) {
    const path = navigablePath(route);
    if (path === '/toweli' || path === '/towelie') continue;
    for (const width of [1280, 390]) {
      test(`${path} shows its band uncovered at ${width}px`, async ({ page }) => {
        test.skip(test.info().project.name !== 'chromium', 'geometry is engine-independent; one desktop project is the honest amount of work');
        test.slow();
        await page.setViewportSize({ width, height: 800 });
        await seedVenueVisitor(page, true);
        await settle(page, path);
        const band = page.locator('[data-room="toweli"]');
        await expect(band).toHaveCount(1);
        // AT THE TOP OF THE PAGE, which is the state the ruling is about:
        // the first line a visitor reads. The band is in flow and scrolls
        // away by design (element E), and a settled route can arrive
        // already scrolled - measured there, the band's centre is above the
        // viewport and elementFromPoint answers null, which is not the
        // defect this guard is for.
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
        const covered = await page.evaluate(() => {
          const el = document.querySelector('[data-room="toweli"]');
          if (!el) return 'no band';
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return 'the band has no box';
          const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
          if (!hit) return `nothing answers at the band centre (top ${Math.round(r.top)}, scrollY ${Math.round(window.scrollY)})`;
          if (hit.closest('[data-room="toweli"]')) return null;
          return `${hit.tagName}.${String((hit as HTMLElement).className || '').slice(0, 48)}`;
        });
        expect(covered, 'something is painted over the room band').toBeNull();
      });
    }
  }

  // ANSWER EIGHT, ruling 1: ONE ROOM AT A TIME.
  //
  // The chrome read ambient storage, never the route, so a visitor who walked
  // through /bayla and then opened a TOWELI protocol page saw the band say
  // TOWELI while the nav chip said Bayla and the footer carried a BAYLA
  // contract card with a Solana explorer link, all in one viewport.
  test('a TOWELI room wears no other resident chrome', async ({ page }) => {
    test.skip(test.info().project.name !== 'chromium', 'rendered chrome is engine-independent');
    test.slow();
    await page.addInitScript(() => {
      try {
        sessionStorage.setItem('tf_loaded', '1');
        localStorage.setItem('tegridy-onboarding-seen', '1');
        localStorage.setItem('tegridy_telemetry_consent', 'denied');
        // The visitor arrives carrying the last door they walked through.
        localStorage.setItem('tegridy-bungalow', 'bayla');
      } catch { /* private mode */ }
    });
    await settle(page, '/tokenomics');
    const body = await page.evaluate(() => document.body.innerText);
    expect(body, 'the room is labelled').toContain('TOWELI room');
    expect(body, 'the footer speaks for another resident').not.toContain('Bayla bungalow');
    expect(body, 'the footer pins another resident contract').not.toContain('BAYLA contract');
    const chip = page.locator('button[aria-label="Choose your bungalow"]');
    await expect(chip).toHaveCount(1);
    expect(await chip.innerText(), 'the nav chip names another resident').not.toContain('Bayla');
  });

  // ANSWER EIGHT, RULING 3: VOICE BY SECTION FOR THE TABBED HOSTS.
  //
  // Four pages choose their panel from the URL's QUERY rather than its path, so
  // the per-path walk above reads exactly ONE panel each - whichever the bare
  // URL lands on - and the other fifteen have never been judged by anything.
  //
  // /community is why the island named this. All four of its tabs are TOWELI's
  // own contracts, and their copy is veTOWELI voting power, TOWELI emissions and
  // a TOWELI bond. None of it renders today (all four addresses are still zero
  // in constants.ts, so every tab shows the deployed-not-wired note), which is
  // exactly why a per-URL row matters: the day they are wired, the difference
  // between "exempt by structure" and "fifteen new violations" is whether
  // anything was ever walking these URLs.
  //
  // THE ROWS ARE URLS, NOT ROUTES - the ruling's own words, "no new routes".
  // e2e/fixtures/routes.ts is re-derived from App.tsx by
  // src/test/a11yRouteCoverage.test.ts, and a query string is not a route, so
  // these rows live here instead of being smuggled into that table.
  interface PanelHost {
    /** The route, exactly as the fixture table has it. */
    path: string;
    param: 'section' | 'tab';
    /** The host's own `id` prefix on its tab buttons, which is how the guard
     *  below asks the app what panels it has instead of trusting this list. */
    prefix: string;
    /** The panel the bare URL lands on. Judged already, by the route's own row. */
    landing: string;
    others: string[];
  }

  const PANEL_HOSTS: PanelHost[] = [
    { path: '/community', param: 'section', prefix: 'community-tab-', landing: 'grants', others: ['bounties', 'bribes', 'gauges'] },
    { path: '/nft-finance', param: 'section', prefix: 'nft-finance-tab-', landing: 'lending', others: ['nftlending', 'pooled', 'bnpl', 'amm', 'launchpad'] },
    { path: '/swap', param: 'tab', prefix: 'trade-tab-', landing: 'swap', others: ['dca', 'limit', 'twap', 'trigger'] },
    // /dashboard IS a ?tab= host and is deliberately NOT here. Its tab strip
    // renders only for a connected wallet (DashboardPage returns the connect
    // wall above it), so a disconnected walk reads the same wall on all four
    // URLs: four identical rows, and a panel guard that could never pass.
    // Connected surfaces are judged where the suite already connects one.
  ];

  /** Measured 2026-09-16 against the production build, one URL at a time. */
  const PANEL_DEBT: Record<string, number> = {};

  const panelUrl = (h: PanelHost, v: string) => `${h.path}?${h.param}=${v}`;

  for (const host of PANEL_HOSTS) {
    // The table above is a claim about the app; this asks the app. A new tab on
    // a host arrives unjudged otherwise, which is the failure this whole block
    // exists to end. It reads only THIS host's own buttons: a section-host tab
    // bar (RouteTabs) puts its own role="tab" nodes on the same page, and those
    // are routes, judged by their own rows.
    test(`${host.path} declares every panel it renders`, async ({ page }) => {
      test.skip(test.info().project.name !== 'chromium', 'the rendered tab strip is engine-independent');
      test.slow();
      await seedVenueVisitor(page, true);
      await settle(page, host.path);
      // SCOPED TO THE HOST'S OWN STRIP, found through the landing tab's id.
      // Reading every role="tab" on the page does not work: the section-host
      // bar above /swap renders `trade-tab--swap`, which starts with the same
      // prefix and is a ROUTE, judged by its own row. Anchoring on the landing
      // tab and walking its tablist asks the host and nothing else.
      const keys = await page.evaluate(
        ({ prefix, landing }) => {
          const anchor = document.getElementById(prefix + landing);
          const strip = anchor?.closest('[role="tablist"]');
          if (!strip) return null;
          return [...strip.querySelectorAll('[role="tab"]')]
            .map((e) => e.id)
            .filter((id) => id.startsWith(prefix))
            .map((id) => id.slice(prefix.length));
        },
        { prefix: host.prefix, landing: host.landing },
      );
      expect(keys, `${host.path} renders no tab strip containing #${host.prefix}${host.landing}`).not.toBeNull();
      expect([...new Set(keys ?? [])].sort(), `${host.path}'s tab strip and PANEL_HOSTS disagree`).toEqual(
        [host.landing, ...host.others].sort(),
      );
    });
  }

  for (const host of PANEL_HOSTS) {
    for (const value of host.others) {
      const url = panelUrl(host, value);
      const budget = PANEL_DEBT[url] ?? 0;
      test(`${url} speaks as the venue: ${budget} TOWELI-voice node${budget === 1 ? '' : 's'}`, async ({ page }) => {
        test.skip(test.info().project.name !== 'chromium', 'rendered copy is engine-independent; one desktop project is the honest amount of work');
        test.slow();
        await seedVenueVisitor(page, true);
        await settle(page, url);
        const hits = await voiceHits(page);
        const shown = hits.slice(0, 8).map((h) => `  ${h}`).join('\n');
        if (budget === 0) {
          expect(hits.length, `${url} speaks TOWELI's protocol as the venue:\n${shown}`).toBe(0);
          return;
        }
        expect(
          hits.length,
          hits.length > budget
            ? `${url} gained TOWELI-voice nodes (${budget} -> ${hits.length}):\n${shown}`
            : `${url} is DOWN to ${hits.length} from ${budget}. Lower PANEL_DEBT (or delete the entry at 0).`,
        ).toBe(budget);
      });
    }
  }
});
