import { test, expect, type Page } from '@playwright/test';

// A SECTION LINK LANDS ON ITS SECTION.
// A link or an address naming #section brings that section to the top of the
// screen once the page's code has drawn it, however long that takes. Back,
// Forward and a reload are the browser's to place. Every scrollIntoView and
// window scroll the page makes is recorded, so "the venue made no jump" is a
// count, not a look.

/** The home page's own chunk: the one a link from another page waits on. */
const HOME_CHUNK = /\/assets\/HomePage-[\w-]+\.js$/;

/** Longer than the venue holds a landed section while the page settles (SECTION_SETTLE_MS). */
const SETTLED_MS = 2_500;

/** A scroll the page made: to an element by its id, or of the window ('window'). */
interface Jump { id: string }
type Recorded = Window & { __jumps: Jump[] };

async function prepare(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('tegridy-onboarding-seen', '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
      localStorage.setItem('tegridy-bungalow', 'venue');
    } catch { /* private mode */ }
    const jumps: Jump[] = [];
    (window as unknown as Recorded).__jumps = jumps;
    const real = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, ...args: Parameters<Element['scrollIntoView']>) {
      jumps.push({ id: this.id });
      return real.apply(this, args);
    };
    for (const name of ['scrollTo', 'scroll', 'scrollBy'] as const) {
      const realScroll = window[name].bind(window) as (...args: unknown[]) => void;
      window[name] = ((...args: unknown[]) => {
        jumps.push({ id: 'window' });
        return realScroll(...args);
      }) as typeof window.scrollTo;
    }
  });
}

/** Holds every request for `chunk` until released, as a slow network would. */
async function holdChunk(page: Page, chunk: RegExp) {
  let asked = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(chunk, async (route) => {
    asked += 1;
    await gate;
    await route.continue().catch(() => { /* the page went away */ });
  });
  return { asked: () => asked, release: () => release() };
}

/**
 * 'landed' when the section's top edge is in the top half of the screen and is
 * what a finger there would touch, not the top bar; otherwise where it is.
 */
const placement = (page: Page, id: string) => page.evaluate((id) => {
  const section = document.getElementById(id);
  const screen = document.documentElement.clientHeight;
  if (!section) return `no #${id} in the document, window at ${Math.round(window.scrollY)}`;
  const box = section.getBoundingClientRect();
  const top = Math.round(box.top);
  if (top < 0 || top > screen / 2) return `#${id} top at ${top} on a ${screen} px screen`;
  const seen = document.elementFromPoint(box.left + box.width / 2, box.top + 4);
  return seen && section.contains(seen) ? 'landed' : `#${id} top at ${top}, under ${seen?.tagName.toLowerCase() ?? 'nothing'}`;
}, id);

/** Lands, and is still there once the page has settled around it. */
async function expectLanded(page: Page, id: string) {
  await expect.poll(() => placement(page, id), { message: `#${id} is at the top of the screen`, timeout: 20_000 })
    .toBe('landed');
  await page.waitForTimeout(SETTLED_MS);
  expect(await placement(page, id), `#${id} is still at the top of the screen once the page has settled`).toBe('landed');
}

/** Jumps to the section, and any scroll of the window, since the record was last cleared. */
const jumpsTo = (page: Page, id: string) =>
  page.evaluate((id) => (window as unknown as Recorded).__jumps.filter((j) => j.id === id || j.id === 'window').length, id);

const forgetJumps = (page: Page) => page.evaluate(() => { (window as unknown as Recorded).__jumps.length = 0; });

/** One frame after the next, so anything the last commit set off has run. */
const twoFrames = (page: Page) =>
  page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

const bungalowsLink = (page: Page) => page.getByRole('link', { name: 'The bungalows' });

test.describe('a section link to another page', () => {
  test('lands once the page is drawn, however long its code takes to arrive', async ({ page }) => {
    await prepare(page);
    const hold = await holdChunk(page, HOME_CHUNK);
    await page.goto('/island');
    await bungalowsLink(page).click();
    await expect(page).toHaveURL((url) => url.pathname === '/' && url.hash === '#hall');
    await expect.poll(hold.asked, { message: 'the home page code was asked for, and is held' }).toBeGreaterThan(0);
    // Longer than any fixed retry: the page is still loading after it.
    await page.waitForTimeout(1_000);
    await expect(page.locator('#hall'), 'nothing of the home page is drawn while its code is held').toHaveCount(0);
    hold.release();
    await expectLanded(page, 'hall');
  });

  test('lands when the page code is already loaded', async ({ page }) => {
    await prepare(page);
    await page.goto('/island');
    await bungalowsLink(page).click();
    await expect(page.locator('#hall')).toBeAttached({ timeout: 20_000 });
    await page.goBack();
    await bungalowsLink(page).click();
    await expectLanded(page, 'hall');
  });

  test('a visitor who moves the page while it loads is not pulled away when it is drawn', async ({ page }) => {
    await prepare(page);
    const hold = await holdChunk(page, HOME_CHUNK);
    await page.goto('/island');
    await bungalowsLink(page).click();
    await expect(page).toHaveURL((url) => url.hash === '#hall');
    await expect.poll(hold.asked, { message: 'the home page code was asked for, and is held' }).toBeGreaterThan(0);
    await page.waitForTimeout(1_000);
    // The page change put the window at the top already; what counts is what follows the move.
    await forgetJumps(page);
    await page.keyboard.press('PageDown');
    hold.release();
    await expect(page.locator('#hall')).toBeAttached({ timeout: 20_000 });
    await twoFrames(page);
    expect(await jumpsTo(page, 'hall'), 'jumps to the hall after the visitor moved the page').toBe(0);
  });

  test('a second tap while it loads does not stop the landing', async ({ page }) => {
    await prepare(page);
    const hold = await holdChunk(page, HOME_CHUNK);
    await page.goto('/island');
    await bungalowsLink(page).click();
    await expect(page).toHaveURL((url) => url.hash === '#hall');
    await expect.poll(hold.asked, { message: 'the home page code was asked for, and is held' }).toBeGreaterThan(0);
    await page.waitForTimeout(1_000);
    // On screen while the code is held: the home page's first frame. Its heading is no link.
    await page.locator('main h1').first().click();
    hold.release();
    await expectLanded(page, 'hall');
  });
});

test.describe('a section link on its own page', () => {
  test('pressed again after scrolling away, it lands again', async ({ page }) => {
    await prepare(page);
    // No bar word opens the hall since Heat and Rooms became Island (2026-10-18), so the press
    // is the island lobby's "The bungalows", made again after scrolling away and going Back.
    // useSectionLink.test.tsx holds a second press made on the page itself.
    await page.goto('/island');
    for (const press of [1, 2, 3]) {
      await expect(bungalowsLink(page)).toBeVisible({ timeout: 20_000 });
      await bungalowsLink(page).click();
      await expect.poll(() => placement(page, 'hall'), { message: `press ${press} lands on the hall`, timeout: 20_000 })
        .toBe('landed');
      // The scroll below is the test's, not a visitor's: let the landing settle first.
      await page.waitForTimeout(SETTLED_MS);
      // Past the hall, then Back to the lobby.
      await page.evaluate(() => {
        const hall = document.getElementById('hall');
        if (hall) window.scrollTo(0, window.scrollY + hall.getBoundingClientRect().bottom + 10);
      });
      expect(await placement(page, 'hall'), `after press ${press}, the hall is above the screen`).toMatch(/^#hall top at -/);
      await page.goBack();
    }
  });

  // The browser's own: a plain <a href="#provide"> is a POP the venue leaves alone.
  // A guard that the venue still does, not a test of the fix.
  test('a plain #section link is the browser\'s, and still lands', async ({ page }) => {
    await prepare(page);
    await page.goto('/liquidity');
    const provide = page.locator('a[href="#provide"]').first();
    await expect(provide).toBeVisible({ timeout: 20_000 });
    await provide.click();
    await expectLanded(page, 'provide');
  });
});

test.describe('a section address opened directly', () => {
  test('lands once the page is drawn', async ({ page }) => {
    await prepare(page);
    await page.goto('/#hall');
    await expectLanded(page, 'hall');
  });

  test('a reload is the browser\'s to place: the venue makes no jump', async ({ page }) => {
    await prepare(page);
    await page.goto('/#hall');
    await expect(page.locator('#hall')).toBeAttached({ timeout: 20_000 });
    await page.reload();
    await expect(page.locator('#hall')).toBeAttached({ timeout: 20_000 });
    await twoFrames(page);
    expect(await jumpsTo(page, 'hall'), 'jumps to the hall made on the reload').toBe(0);
  });

  test('Back to it is the browser\'s to place: the venue makes no jump', async ({ page }) => {
    await prepare(page);
    await page.goto('/#hall');
    const toNftFinance = page.locator('section[aria-label="Paths"] a[href="/nft-finance"]');
    await expect(toNftFinance).toBeVisible({ timeout: 20_000 });
    await toNftFinance.click();
    await expect(page.getByRole('heading', { name: 'NFT Finance', level: 1 })).toBeVisible({ timeout: 20_000 });
    const awayTitle = await page.title();
    await forgetJumps(page);
    await page.goBack();
    await expect(page.locator('#hall')).toBeAttached({ timeout: 20_000 });
    // The home page sets its title in an effect of the commit that drew it, after the venue's own.
    await expect(page).not.toHaveTitle(awayTitle, { timeout: 20_000 });
    await twoFrames(page);
    expect(await jumpsTo(page, 'hall'), 'jumps to the hall made on Back').toBe(0);
  });
});

test.describe('the estimate link on the TOWELI farm', () => {
  test('"See what you\'d earn" lands on the estimate, its page shown from the top while it loads', async ({ page }) => {
    await prepare(page);
    const hold = await holdChunk(page, HOME_CHUNK);
    await page.goto('/earn/toweli');
    const estimate = page.getByRole('link', { name: /See what you.d earn/ });
    await expect(estimate).toBeVisible({ timeout: 20_000 });
    await estimate.click();
    await expect(page).toHaveURL((url) => url.hash === '#yield-calculator');
    await expect.poll(hold.asked, { message: 'the home page code was asked for, and is held' }).toBeGreaterThan(0);
    // The link sits far down the farm page; the page it opens starts at its top.
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY)), { message: 'the window, while the page loads' })
      .toBe(0);
    hold.release();
    await expectLanded(page, 'yield-calculator');
  });
});
