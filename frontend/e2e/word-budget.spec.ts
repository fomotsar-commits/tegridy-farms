import { test, expect, type Page } from '@playwright/test';
import { gotoRoute, waitForQuiescence, gotoNakamigos, GECKO_EDGE_GLOB } from './fixtures/routes';

/**
 * The word budget: how many words a visitor can SEE on a route, before pressing anything.
 *
 * Owner, 2026-10-14: "this entire site is super wordy. noone will read this and they
 * will be drowned in too much info and not even see the stuff they are to interact
 * with ... as little words as possible". Owner, 2026-10-13: disclaimers and how-it-works
 * go in closed drop-downs. The rule (components/ui/FinePrint.tsx) says where words go;
 * this spec says how many may stay out. A route that grows past its ceiling fails and
 * names its longest blocks, so a sentence cannot creep back onto the page one PR at a
 * time. A ceiling only comes down (lower it when a route does); raising one is the
 * owner's call.
 *
 * What is counted: the words of `main`'s innerText (what renders; a closed details
 * element contributes only its summary) after the route has settled, in the Bayla
 * skin, on the production build, at a desktop width and at a phone width. The top
 * bar, the footer and the drawer are outside `main` and not counted. A ledger of
 * failed reads (data-unread-ledger) is assembled from what the network answered, so
 * it is not copy and is left out, as the em-dash census leaves it.
 *
 * Numbers move with the chain (a count of pools, a token's name, a date), so each
 * ceiling sits about a tenth above what was measured on 2026-10-14. A failure well
 * under that slack is words, not data.
 */
const PHONE = 390;

/** Measured 2026-10-14 after the fewer-words pass (desktop / phone): / 183 / 183,
 *  /earn 124 / 109, /liquidity 125 / 126, /solana-lp 199 / 194, /pools 264 / 260 (after the
 *  duplicate fee cards went, owner 2026-10-14; 339 / 336 before),
 *  /zap 84 / 84, /nft-finance 246 / 233, /nakamigos 227 / 227, /bayla 288 / 288,
 *  /dashboard 201 / 201. Before the pass, on the phone: /pools 570, /solana-lp 390,
 *  /bayla 351, /nft-finance 320, /dashboard 246, /liquidity 176, /earn 160.
 *  Re-measured 2026-10-15 on both Solana pool tabs after trunk's All pools card (#815)
 *  came in, which the owner kept ("keep the list of all pools"): /solana-lp 238 / 233,
 *  /pools 309 / 305. Each figure also carries the finder's "anyone can copy a name"
 *  warning, back on screen at the address field, and on /pools the line that the
 *  team's vault can pause removing. Here the list's read fails (no pool index behind a
 *  local build), so its "could not be read" line stands where pool rows would. */
const BUDGET: Record<string, { desktop: number; phone: number }> = {
  // Raised 2026-10-16 for the cards the owner asked for on the home (stake BAYLA, add SOL + BAYLA:
  // "put the bayla staking module and the lp pool module here on the homepage"): 373 measured on the
  // desktop with both drawn, 220 of them the cards' (238 when the LP card waits on the venue's read),
  // after the hero's two sentences went into How heat works. 200 / 200 before them.
  '/': { desktop: 410, phone: 410 },
  '/earn': { desktop: 140, phone: 125 },
  '/liquidity': { desktop: 140, phone: 140 },
  // One Rates card and one Swap routes card since 2026-10-14 (four fee cards before);
  // raised 2026-10-15 for the All pools card (290 / 285 before it).
  '/pools': { desktop: 340, phone: 335 },
  '/zap': { desktop: 95, phone: 95 },
  '/nft-finance': { desktop: 275, phone: 260 },
  // Its landing counts live collection data (listings, floors): 227 and 265 on two runs.
  '/nakamigos': { desktop: 300, phone: 300 },
  // Raised 2026-10-21 for the home's three cards on BAYLA's door (owner: "A: raise the limit to
  // 500"), with the lore and the pool on record folded into FinePrint: 345 / 345 measured, 481 / 359
  // before the folds. The cards are 52 to 181 of it, by what the chain reads answer. 320 / 320 before.
  '/bayla': { desktop: 500, phone: 500 },
  '/dashboard': { desktop: 225, phone: 225 },
};

/** Routes with a GeckoTerminal feed: aborted, so a slow edge cannot make the count wait. */
const FEED_ROUTES = new Set(['/', '/bayla', '/dashboard', '/nakamigos']);

async function settle(page: Page, path: string) {
  if (path === '/nakamigos') await gotoNakamigos(page);
  else await gotoRoute(page, path);
  // Three passes down: a scrollTo lands before the sections it reveals have mounted.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
  }
  await waitForQuiescence(page, { quietMs: 600, timeout: 12_000 });
  await page.evaluate(() => window.scrollTo(0, 0));
}

/** Visible words in main, and the longest visible text blocks for the failure message. */
async function visibleWords(page: Page): Promise<{ words: number; longest: string[] }> {
  return page.evaluate(() => {
    const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
    const main = document.querySelector('main') ?? document.body;
    let total = words(main.innerText);
    main.querySelectorAll<HTMLElement>('[data-unread-ledger]').forEach((n) => { total -= words(n.innerText); });
    const blocks = [...main.querySelectorAll<HTMLElement>('p, li, h1, h2, h3, span, div')]
      .filter((el) => el.children.length === 0 && !el.closest('details:not([open])') && el.getBoundingClientRect().height > 0)
      .map((el) => ({ n: words(el.innerText || ''), t: (el.innerText || '').trim().slice(0, 90) }))
      .filter((b) => b.n >= 12)
      .sort((a, b) => b.n - a.n)
      .slice(0, 6)
      .map((b) => `  [${b.n}] ${b.t}`);
    return { words: total, longest: blocks };
  });
}

for (const [path, ceiling] of Object.entries(BUDGET)) {
  for (const width of ['desktop', 'phone'] as const) {
    test(`${path} shows at most ${ceiling[width]} words on ${width}`, async ({ page }) => {
      test.skip(test.info().project.name !== 'chromium', 'one build, one browser: the desktop project measures both widths');
      test.slow();
      if (width === 'phone') await page.setViewportSize({ width: PHONE, height: 844 });
      await page.addInitScript(() => {
        try {
          localStorage.setItem('tegridy-onboarding-seen', '1');
          localStorage.setItem('tegridy_telemetry_consent', 'denied');
          // The live resident skin: its rooms are the ones the owner walks.
          localStorage.setItem('tegridy-bungalow', 'bayla');
        } catch { /* private mode */ }
      });
      if (FEED_ROUTES.has(path)) await page.route(GECKO_EDGE_GLOB, (r) => r.abort());
      await settle(page, path);
      const { words, longest } = await visibleWords(page);
      console.log(`[word-budget] ${path} ${width} ${words}`);
      expect(
        words,
        `${path} (${width}) shows ${words} words, over its ceiling of ${ceiling[width]}. Move explanation into FinePrint. Longest blocks:\n${longest.join('\n')}`,
      ).toBeLessThanOrEqual(ceiling[width]);
    });
  }
}
