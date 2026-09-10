import { test, expect, type Page } from '@playwright/test';
import { gotoRoute, waitForQuiescence, gotoNakamigos } from './fixtures/routes';

// ELEMENT I — ZERO EM DASHES IN VENUE-VOICE PROSE, AND THE DEBT ON THE WAY THERE.
//
// THE DISCRIMINATOR, which is the whole reason this guard can exist.
//
// The em dash is two different things in this repo and only one of them is
// copy. `usePoolMarket.ts:13` states the other outright: "null means NOT READ,
// and the UI must render it as '—', never as 0". A dozen surfaces emit that
// bare dash when a read fails, and it must never be edited away — a zero where
// a read failed is the repo's most repeated bug class.
//
// So a body-wide count cannot answer this element's question, and neither can a
// copy review: somebody has to decide, per dash, which of the two it is. That
// is an exemption list, and an exemption list rots.
//
// The rule that replaces it is structural, and it needs no judgement at all:
//
//   a text node that CONTAINS U+2014 and whose trimmed content is NOT exactly
//   U+2014 is PROSE and fails; a node whose trimmed content IS exactly U+2014
//   is the unreadable placeholder and passes BY CONSTRUCTION.
//
// The placeholder emitters are all `{cond ? value : '—'}` — their own JSX
// expression child, therefore their own text node, therefore exactly U+2014.
// They are safe without being named, and they stay safe as new ones are added.
//
// TEXT NODES, NEVER innerText. innerText flattens an element's whole subtree
// into one string, which glues a placeholder to the prose beside it and reports
// both as one prose hit. The walker below reads the nodes themselves.
//
// ── THE DEBT ────────────────────────────────────────────────────────────────
//
// 487 prose dashes across 52 routes today, so this cannot land as `toBe(0)`
// without landing red, and a permanently red gate is a gate people learn to
// ignore. It lands as the repo's own knownViolations idiom instead
// (e2e/fixtures/routes.ts): an EXACT count per route, asserted both ways.
//
// Both ways is the point. A new dash fails the route, AND a fixed one fails it
// too, until the number here comes down with it. A list that can only be
// appended to is a list that stops being read.
//
// Where the count is 0 the route is finished, and the assertion is the island's
// ruling exactly: it fails on the first prose node, and it prints that node's
// text so the failure names the copy rather than a number.
//
// ── SCOPE ───────────────────────────────────────────────────────────────────
//
// Every venue-voice route: everything AUDITABLE_ROUTES reaches minus the
// thirteen bungalow doors and /toweli, which speak their own token's voice and
// their own farm's voice and are not this element's subject.
//
// The nine routes measured before this guard existed were the ones the island
// and the venue had both been walking by hand; they came to 141. They are nine
// of fifty-one. The venue's own nav reaches the rest.

/** Routes whose numbers are not a guess. Measured 2026-09-09 against the
 *  production build under `vite preview`, twice, identical both passes. */
const VENUE_VOICE_DEBT: Record<string, number> = {
  '/': 0,
  '/faq': 0,
  '/history': 0,
  '/start': 0,
  '/admin': 0,
  '/launch/0x0000000000000000000000000000000000000000': 0,
  '/vesting': 1,
  '/exposure': 1,
  '/nakamigos': 1,
  '/eth-curve/0x0000000000000000000000000000000000000000': 1,
  '/farm': 2,
  '/swap': 2,
  '/airdrop': 2,
  '/zap': 2,
  '/island': 2,
  '/scan': 2,
  '/deployer': 2,
  '/checkout': 2,
  '/chart': 2,
  '/dashboard': 3,
  '/tokenomics': 3,
  '/lore': 3,
  '/terms': 3,
  '/terminal': 3,
  '/solana': 4,
  '/launch-simulator': 4,
  '/leaderboard': 4,
  '/community': 5,
  '/liquidity': 6,
  '/referrals': 6,
  '/premium': 7,
  '/privacy': 7,
  '/trust': 7,
  '/pools': 9,
  '/contracts': 9,
  '/nft-finance': 10,
  '/treasury': 10,
  '/developers': 10,
  '/security': 11,
  '/risks': 12,
  '/copy-trading': 12,
  '/tax': 13,
  '/curve-launch': 14,
  '/eth-curve': 15,
  '/alerts': 17,
  '/competitions': 18,
  '/yield': 21,
  '/launch': 32,
  '/gallery': 82,
  '/changelog': 104,

};

/**
 * The four GeckoTerminal routes, with the feed aborted at the browser.
 *
 * e2e/fixtures/routes.ts already measured what these routes do: /copy-trading
 * is a 154-row table of ~31.8k chars when the feed answers and a ~5.5k-char
 * list of "could not be read" notices when it does not. Its own note says a
 * stub is warranted for "a route whose two branches DO differ" — an a11y rule
 * set survives that difference, a CHARACTER COUNT plainly might not.
 *
 * So the feed is aborted here and the degraded branch is what is pinned. The
 * abort really intercepts because playwright.config sets serviceWorkers:
 * 'block'; without it public/sw.js answers first and the stub is a no-op.
 *
 * MEASURED, NOT ASSUMED: aborted, these four read 3 / 2 / 12 / 18, which is
 * what the unstubbed sweep read too. OWED, and not claimed: I cannot make a
 * third party answer on demand, so I have not walked the ready branch's copy
 * with the feed certainly live. If those tables carry dashes, they are not in
 * this baseline.
 */
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
  // The repo's settle, rather than a fixed sleep: routes.ts's own header
  // records that a fixed wait under-reported findings on /farm.
  await waitForQuiescence(page, { quietMs: 600, timeout: 12_000 });
}

test.describe('element I: em dashes in venue-voice prose', () => {
  // THE DESKTOP PROJECT ONLY, AND IT MUST BE MATCHED BY PROJECT NAME.
  //
  // `browserName !== 'chromium'` is the wrong test and it cost a CI run to
  // learn: the `mobile-chrome` project is a Pixel 5, so its browserName is
  // 'chromium' too, and the guard ran there with the desktop baseline. At a
  // phone width /exposure reads 2 where the desktop reads 1 — not different
  // copy, a different set of components rendering. The numbers below are a
  // desktop measurement and only the desktop project may be judged by them.
  //
  // Rendered copy is not engine-dependent, so one project is the honest amount
  // of work here; four would also put a fifty-route serial sweep on the two
  // WebKit projects, which this box already collapses under load.
  //
  // NOT WALKED, and therefore not claimed: copy that only a narrow viewport
  // renders — the BottomNav's four tabs and the hamburger drawer. A mobile
  // baseline is its own list, and this element has not asked for one yet.
  // (asserted per test below, via test.info().project.name)

  for (const [path, budget] of Object.entries(VENUE_VOICE_DEBT)) {
    test(`${path} carries ${budget} prose em dash${budget === 1 ? '' : 'es'}`, async ({ page }) => {
      test.skip(test.info().project.name !== 'chromium', 'the debt here is a desktop measurement');
      test.slow();
      await page.addInitScript(() => {
        try {
          sessionStorage.setItem('tf_loaded', '1');
          localStorage.setItem('tegridy-onboarding-seen', '1');
          localStorage.setItem('tegridy_telemetry_consent', 'denied');
          // 'venue', NOT the wallet fixture's 'toweli'. Footer.tsx:180 renders
          // `🏝️ Bungalows — Toweli` as its own text node whenever any registry
          // bungalow is active, which would put one prose dash in the footer of
          // every route on this list and blame each page for its chrome.
          // 'venue' is the "seen, chose nothing" sentinel and resolves to null.
          localStorage.setItem('tegridy-bungalow', 'venue');
        } catch { /* private mode */ }
      });
      if (FEED_ROUTES.has(path)) {
        await page.route('**api.geckoterminal.com/**', (r) => r.abort());
      }

      await settle(page, path);

      const hits = await proseDashes(page);
      const shown = hits.slice(0, 8).map((h) => `  ${h.owner}: ${h.text}`).join('\n');

      if (budget === 0) {
        // FINISHED ROUTE. The island's ruling, exactly: fail on the first prose
        // node, and name the copy rather than a count.
        expect(hits.length, `${path} is at zero and gained prose em dashes:\n${shown}`).toBe(0);
        return;
      }

      // BOTH WAYS. Fewer than the number here is a fix, and it fails until the
      // number comes down with it -- that is what stops this list from becoming
      // an append-only tally nobody reads.
      expect(
        hits.length,
        hits.length > budget
          ? `${path} gained prose em dashes (${budget} -> ${hits.length}). First few:\n${shown}`
          : `${path} is DOWN to ${hits.length} from ${budget}. Good: lower the number in VENUE_VOICE_DEBT to ${hits.length} (or delete the entry if it is 0).`,
      ).toBe(budget);
    });
  }
});
