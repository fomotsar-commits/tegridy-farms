import { test, expect, type Page } from '@playwright/test';
import { coldArrival, ROOM_ROUTES, SAMPLE_MS, summarize, type Arrival } from './fixtures/roomArrival';

// A ROOM OPENS ONCE, ON ITS HERO. Each arrival is a new browser context, so
// nothing is stored and the door has to change the skin. One document per
// arrival, scrollY 0 at 1, 3 and 7 s, and the room's H1 in the viewport at 3
// and 7 s. The 1 s H1 is logged, not asserted: one-document arrivals paint the
// hero after about 1.1 s, and the door HTML carries no static first frame.
// ROOM_ARRIVALS sets the arrivals per route (default 2).
//
// Chromium classes only (desktop and Pixel 5): these are the measured classes.

const ARRIVALS = Number(process.env.ROOM_ARRIVALS ?? 2);

test.use({ serviceWorkers: 'block' });

test.beforeEach(() => {
  const project = test.info().project.name;
  test.skip(project !== 'chromium' && project !== 'mobile-chrome', 'measured on the Chromium desktop and phone classes');
});

function expectOnHero(a: Arrival) {
  expect.soft(a.loads, `${a.url}: documents loaded in the tab`).toBe(1);
  expect.soft(a.documents, `${a.url}: main-frame document requests`).toBe(1);
  // loads and documents carry the one-document claim. This names the kind: a
  // reload or a restored entry is a failure, an empty list is only a document
  // whose DOMContentLoaded had not landed, and the H1 assertions say that.
  expect.soft(a.navTypes.filter((t) => t !== 'navigate'), `${a.url}: navigation types other than 'navigate'`).toEqual([]);
  for (const ms of SAMPLE_MS) {
    expect.soft(a.at[ms]?.y, `${a.url}: scrollY at ${ms} ms`).toBe(0);
    if (ms >= 3000) expect.soft(a.at[ms]?.h1InView, `${a.url}: H1 in the viewport at ${ms} ms`).toBe(true);
  }
}

for (const route of ROOM_ROUTES) {
  test(`a cold arrival at ${route} loads one document and rests on its hero`, async ({ browser }, info) => {
    test.setTimeout(30_000 + ARRIVALS * 25_000);
    const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL } = info.project.use;
    const arrivals: Arrival[] = [];
    for (let i = 0; i < ARRIVALS; i++) {
      const a = await coldArrival(
        browser,
        { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL, serviceWorkers: 'block' },
        route,
      );
      arrivals.push(a);
      expectOnHero(a);
    }
    const line = summarize(`${info.project.name} ${route}`, arrivals);
    console.log(line);
    await info.attach('arrivals', { body: JSON.stringify(arrivals, null, 2), contentType: 'application/json' });
  });
}

/** Counts main-frame documents from here on. */
function countDocuments(page: Page) {
  const seen = { n: 0 };
  page.on('request', (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) seen.n += 1;
  });
  return seen;
}

test.describe('a door walked inside the app', () => {
  test('the TOWELI door from the venue home opens the TOWELI room with no new document', async ({ page }) => {
    const docs = countDocuments(page);
    await page.goto('/');
    await expect(page.locator('main#main-content h1').first()).toBeVisible({ timeout: 20_000 });
    const before = docs.n;
    const door = page.locator('a[href="/toweli"]').first();
    await door.scrollIntoViewIfNeeded();
    await door.click();
    await expect(page).toHaveURL(/\/toweli$/);
    const h1 = page.locator('main#main-content h1').first();
    await expect(h1, 'the room renders its own hero, not the venue home it was entered from').toContainText('Farm TOWELI.', {
      timeout: 20_000,
    });
    await expect(page.getByRole('heading', { name: 'Protocol Overview' })).toBeAttached();
    await expect(h1).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(docs.n - before, 'walking a door loaded a new document').toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('tegridy-bungalow'))).toBe('toweli');
  });

  test('a Solana room moves the Swap word to the Solana swap in place', async ({ page }, info) => {
    const docs = countDocuments(page);
    await page.goto('/pepe');
    await expect(page.locator('main#main-content h1').first()).toContainText('PEPE', { timeout: 20_000 });
    const before = docs.n;
    await page.evaluate(() => {
      window.history.pushState({}, '', '/bayla');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('main#main-content h1').first()).toContainText('BAYLA', { timeout: 20_000 });
    const swap = info.project.name === 'mobile-chrome'
      ? page.locator('nav[aria-label="Main navigation"] a[aria-label="Swap"]')
      : page.locator('header nav[aria-label="Main navigation"] a', { hasText: /^Swap$/ });
    await expect(swap).toHaveAttribute('href', '/solana');
    expect(docs.n - before).toBe(0);
  });

  test('"Open" on the Earn index enters that room in place', async ({ page }) => {
    const docs = countDocuments(page);
    await page.goto('/farm');
    const open = page.getByRole('button', { name: 'Open PEPE' });
    await expect(open).toBeVisible({ timeout: 20_000 });
    const before = docs.n;
    await open.click();
    await expect(page).toHaveURL(/\/farm$/);
    await expect(page.getByRole('button', { name: 'Open PEPE' })).toHaveCount(0, { timeout: 20_000 });
    expect(await page.evaluate(() => localStorage.getItem('tegridy-bungalow'))).toBe('pepe');
    expect(docs.n - before, 'opening a room loaded a new document').toBe(0);
  });
});
