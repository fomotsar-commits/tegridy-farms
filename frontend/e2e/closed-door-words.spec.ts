import { test, expect, type Page } from '@playwright/test';
import { AUDITABLE_ROUTES, ROUTES, gotoNakamigos, gotoRoute, navigablePath, waitForQuiescence, waitForReads } from './fixtures/routes';

// Island answer twenty-six (2026-11-03): no token launch is live on the venue until the island
// says so, on any rail, and the venue never prints the word Drifter. Done means "the page text of
// every route at 390 reads 'Launch a token' 0, 'LIVE ON ETHEREUM' 0, 'Drifter' 0, 'Cannot' 0,
// 'Soon' 0", red first against the trunk where /launch read "Launch a token".
//
// Walked as cannot-zero.spec.ts walks Cannot, at 390 wide: the single words in text nodes, never
// innerText (which skips a closed <details> a visitor can still open), and on controls (title,
// placeholder, aria-label, alt); the two phrases in the page's text as a visitor reads it (PHRASES).
// A [data-record] subtree keeps the words it was written in, and aria-hidden copy is read by
// nobody. Every read is sealed, so each route renders the branches that could not read anything,
// and the walk holds from run to run. The words are matched in any case: a mark in capitals by its
// type ("LIVE ON ETHEREUM") is the same words in its text.

const WORDS = {
  'Launch a token': /\blaunch a token\b/i,
  'LIVE ON ETHEREUM': /\blive on ethereum\b/i,
  Drifter: /\bdrifter\b/i,
  Cannot: /\bcannot\b/i,
  Soon: /\bsoon\b/i,
} as const;
type Word = keyof typeof WORDS;
/** The two phrases are read in the page's text as a visitor reads it (innerText), as the island
 *  reads them: the curve's mark is set in pieces ("Live on " and the chain's name), so a phrase
 *  across two text nodes is still one phrase. The TOWELI farm's link is labelled "Live on Ethereum:
 *  farm and stake TOWELI", which is true and no launch, and a label is not page text. */
const PHRASES = new Set<Word>(['Launch a token', 'LIVE ON ETHEREUM']);

/** Where a word still stands in copy this build may not touch, with the count and the owner. Held
 *  both ways: a new one fails its route, and so does a fixed one until the number comes down. */
const DEBT: Record<string, Partial<Record<Word, number>>> = {
  // VENUE.heroCopy in lib/arrival.ts, "It cannot be bought and it cannot be faked.": the island's
  // own sentence (cannot-zero.spec.ts holds the same two), raised with the island in answer 25.
  '/start': { Cannot: 2 },
  // /risks carried "Launch a token" 1 (the launcher risk's heading, the owner's legal copy) until
  // RisksPage.tsx LAUNCH_RISK: while the door is closed the heading says launching is not switched
  // on yet, and the owner's heading returns as written once it opens.
};

interface Hit {
  word: Word;
  where: string;
  text: string;
}

async function hits(page: Page): Promise<Hit[]> {
  const sources = Object.fromEntries(Object.entries(WORDS).map(([w, re]) => [w, re.source]));
  return page.evaluate(({ words, phrases }) => {
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
    const unread = (el: Element) => !!el.closest('[aria-hidden="true"]') || !!el.closest('[data-record]');
    const found: { word: string; where: string; text: string }[] = [];
    const each = (text: string, where: string, asPhrase = false) => {
      for (const [word, source] of Object.entries(words)) {
        if (phrases.includes(word) !== asPhrase) continue;
        for (const m of text.matchAll(new RegExp(source, 'gi'))) {
          found.push({ word, where, text: text.slice(Math.max(0, m.index - 60), m.index + 70).replace(/\s+/g, ' ').trim() });
        }
      }
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const el = node.parentElement;
      if (!el || SKIP.has(el.tagName) || unread(el)) continue;
      each(node.textContent ?? '', el.tagName);
    }
    for (const el of Array.from(document.body.querySelectorAll('[title], [placeholder], [aria-label], [alt]'))) {
      if (unread(el)) continue;
      for (const attr of ['title', 'placeholder', 'aria-label', 'alt']) each(el.getAttribute(attr) ?? '', `${el.tagName}[${attr}]`);
    }
    each(document.body.innerText, 'innerText', true);
    return found;
  }, { words: sources, phrases: [...PHRASES] as string[] }) as Promise<Hit[]>;
}

/** Mount the route, let the whileInView sections arrive, then wait for the page to stop moving. */
async function settle(page: Page, path: string) {
  if (path === '/nakamigos') await gotoNakamigos(page);
  else {
    await gotoRoute(page, path);
    await waitForReads(page);
  }
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
  }
  await waitForQuiescence(page, { quietMs: 600, timeout: 12_000 });
}

/** Every route the census renders, once each, the launch rails' own addresses, and every room's farm. */
const DOOR_IDS = ROUTES.filter((r) => r.owner === 'pages/HomePage.tsx' && r.voice !== 'venue')
  .map((r) => navigablePath(r).slice(1))
  .filter((id) => id !== 'towelie');
const PATHS = [
  ...new Set([
    ...AUDITABLE_ROUTES.map(navigablePath),
    '/launch',
    '/eth-curve',
    '/curve-launch',
    '/launch-simulator',
    ...DOOR_IDS.map((id) => `/earn/${id}`),
  ]),
];

test.use({ viewport: { width: 390, height: 844 } });

test.describe('the launch door is closed, and Drifter is never printed, on every route at 390', () => {
  for (const path of PATHS) {
    test(`${path} reads none of the five words`, async ({ page }) => {
      test.skip(test.info().project.name !== 'chromium', 'a word is not engine-dependent: walked on the desktop project, at 390');
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

      const found = await hits(page);
      for (const word of Object.keys(WORDS) as Word[]) {
        const mine = found.filter((h) => h.word === word);
        const budget = DEBT[path]?.[word] ?? 0;
        const shown = mine.map((h) => `  ${h.where}: ${h.text}`).join('\n');
        expect(
          mine.length,
          mine.length > budget
            ? `${path} reads "${word}":\n${shown}`
            : `${path} is DOWN to ${mine.length} "${word}" from ${budget}. Good: lower its DEBT (or delete the entry at 0).`,
        ).toBe(budget);
      }
    });
  }

  // The home's chain pills speak to a screen reader in their labels, which the walk's phrases (read
  // as the page's text) never see: no curve pill may say a launch is open while the door is shut.
  test('no curve pill on the home tells a screen reader it can launch', async ({ page }) => {
    test.skip(test.info().project.name !== 'chromium', 'a label is not engine-dependent: read on the desktop project, at 390');
    await page.addInitScript(() => {
      try {
        localStorage.setItem('tegridy-onboarding-seen', '1');
        localStorage.setItem('tegridy_telemetry_consent', 'denied');
        localStorage.setItem('tegridy-bungalow', 'venue');
      } catch { /* private mode */ }
    });
    await page.route('**/api/**', (r) => r.abort());
    await page.route((url) => url.hostname !== 'localhost', (r) => r.abort());
    await settle(page, '/');
    const labels = await page
      .locator('a.badge[href^="/eth-curve"][aria-label]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
    expect(labels.length, 'the Base pill, at least').toBeGreaterThanOrEqual(1);
    // "launch", the whole word ("launch and trade"); "launching not switched on yet" is the truth.
    expect(labels.filter((label) => /\blaunch\b/i.test(label)), 'a curve pill says a launch is open').toEqual([]);
  });

  test('the walk covers every route the census renders, the four launch addresses, and the thirteen farms', () => {
    expect(DOOR_IDS.length, 'thirteen registry ids').toBe(13);
    for (const route of AUDITABLE_ROUTES) expect(PATHS).toContain(navigablePath(route));
    for (const path of Object.keys(DEBT)) expect(PATHS, `${path} is owed but never walked`).toContain(path);
  });
});
