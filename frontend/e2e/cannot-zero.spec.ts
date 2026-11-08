import { test, expect, type Page } from '@playwright/test';
import { AUDITABLE_ROUTES, ROUTES, gotoNakamigos, gotoRoute, navigablePath, waitForQuiescence } from './fixtures/routes';

// The word Cannot, nowhere on the venue (island answer twenty-four, build 5; answer twenty-five,
// screen 2: "grep the page text of every route, red first against today's trunk"). A visitor is
// told what is true and the next move, never "Cannot", in capitals or not.
//
// Walked as element I walks em dashes (em-dash-zero.spec.ts): text nodes, never innerText, which
// skips a closed <details> a visitor can still open. Also the words a visitor meets on a control
// without reading them as text: its title, placeholder, aria-label and alt. A record keeps the
// words it was written in (src/pages/recordSurfaces.test.ts pins who may declare one), so a
// [data-record] subtree is not walked; aria-hidden copy is read by nobody.
//
// Every read is sealed (every /api path and every host but localhost aborted), as on the room and
// farm tables there: each route then renders the branches that could not read anything, where a
// refusal is likeliest, and the walk holds from run to run.

const WORD = /\bcannot\b/i;

/** Where the word still stands in copy this build may not touch, with the count and the owner.
 *  Held both ways, as element I's table is: a new one fails its route, and so does a fixed one
 *  until the number here comes down. Every route not named is at zero. */
const CANNOT_DEBT: Record<string, number> = {
  // VENUE.heroCopy in lib/arrival.ts, "It cannot be bought and it cannot be faked.", on the
  // onboarding flow: the arrival words, held by session B's other builders while this one ran.
  '/start': 2,
};

interface Hit {
  where: string;
  text: string;
}

/** Every time a visitor reads the word on the page, in document order: each one, so a second
 *  in the same sentence is never hidden behind the first. */
async function cannots(page: Page): Promise<Hit[]> {
  return page.evaluate((source) => {
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
    const unread = (el: Element) => !!el.closest('[aria-hidden="true"]') || !!el.closest('[data-record]');
    // The words around each one, so a failure names the sentence to fix.
    const each = (text: string) =>
      Array.from(text.matchAll(new RegExp(source, 'gi')), (m) =>
        text.slice(Math.max(0, m.index - 60), m.index + 70).replace(/\s+/g, ' ').trim(),
      );
    const hits: { where: string; text: string }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const el = node.parentElement;
      if (!el || SKIP.has(el.tagName) || unread(el)) continue;
      for (const text of each(node.textContent ?? '')) hits.push({ where: el.tagName, text });
    }
    for (const el of Array.from(document.body.querySelectorAll('[title], [placeholder], [aria-label], [alt]'))) {
      if (unread(el)) continue;
      for (const attr of ['title', 'placeholder', 'aria-label', 'alt']) {
        for (const text of each(el.getAttribute(attr) ?? '')) hits.push({ where: `${el.tagName}[${attr}]`, text });
      }
    }
    return hits;
  }, WORD.source);
}

/** Mount the route, let the whileInView sections arrive, then wait for the page to stop moving. */
async function settle(page: Page, path: string) {
  if (path === '/nakamigos') await gotoNakamigos(page);
  else await gotoRoute(page, path);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
  }
  await waitForQuiescence(page, { quietMs: 600, timeout: 12_000 });
}

/** Every route the census renders, once each, and every room's farm (one route, thirteen pools). */
const DOOR_IDS = ROUTES.filter((r) => r.owner === 'pages/HomePage.tsx' && r.voice !== 'venue')
  .map((r) => navigablePath(r).slice(1))
  .filter((id) => id !== 'towelie');
const PATHS = [...new Set([...AUDITABLE_ROUTES.map(navigablePath), ...DOOR_IDS.map((id) => `/earn/${id}`)])];

test.describe('the word Cannot appears nowhere on the venue', () => {
  for (const path of PATHS) {
    test(`${path} says Cannot nowhere`, async ({ page }) => {
      test.skip(test.info().project.name !== 'chromium', 'a word is not engine-dependent: walked on the desktop project');
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

      const hits = await cannots(page);
      const shown = hits.map((h) => `  ${h.where}: ${h.text}`).join('\n');
      const budget = CANNOT_DEBT[path] ?? 0;
      expect(
        hits.length,
        hits.length > budget
          ? `${path} tells a visitor "Cannot":\n${shown}`
          : `${path} is DOWN to ${hits.length} from ${budget}. Good: lower CANNOT_DEBT to ${hits.length} (or delete the entry at 0).`,
      ).toBe(budget);
    });
  }

  test('the walk covers every route the census renders, and the thirteen farms', () => {
    expect(DOOR_IDS.length, 'thirteen registry ids').toBe(13);
    for (const route of AUDITABLE_ROUTES) expect(PATHS).toContain(navigablePath(route));
    for (const path of Object.keys(CANNOT_DEBT)) expect(PATHS, `${path} is owed but never walked`).toContain(path);
  });
});
