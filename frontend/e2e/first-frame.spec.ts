import { test, expect, type Page } from '@playwright/test';
import { phoneThrottle } from './fixtures/doorFrame';

// THE FIRST FRAME IS THE HERO (answer ten, ruling 2), on a production build. The H1's
// paint is read from Element Timing, not the DOM; a MutationObserver armed before any
// script sees any "Loading" that came and went; an address submitted with no script
// lands on /?heat= and reads. Chromium only: the throttle is CDP.

const ADDRESS = '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a';
const OTHER = '0x420698cfdeddea6bc78d59bc17798113ad278f9d';
const REF = '0x1111111111111111111111111111111111111111';

/** Hold every request matching `glob` until released: slow, not absent. */
async function hold(page: Page, glob: string): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(glob, async (route) => {
    await gate;
    await route.continue().catch(() => { /* the page moved on while it was held */ });
  });
  return release;
}

/** The island's read, stubbed, counting each time the app actually asks. */
async function stubHeatRead(page: Page, onRead: () => void) {
  await page.route('**/api/aggregator**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('resource') !== 'heat') return route.fallback();
    onRead();
    const now = Math.floor(Date.now() / 1000);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        address: ADDRESS, degrees: 195.54, tier: 'Builder', is_cold: false,
        held_since_unix: now - 400 * 86_400, as_of_unix: now - 3_600, token_count: 1,
        breakdown: [{ token_address: '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D', chain: 'ethereum', name: 'Towelie', symbol: 'TOWELI', heat_degrees: 195.54, first_seen_at_unix: now - 400 * 86_400, last_transfer_at_unix: now - 30 * 86_400 }],
      }),
    });
  });
}

/** A client-side navigation, the way a nav link makes one: history, then the router. */
async function clientNavigate(page: Page, path: string) {
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

/** A cold visitor: no stored skin, nothing seeded, so `/` opens the venue's frame. */
test.use({ serviceWorkers: 'block' });

test.describe('the first frame is the hero (ruling 2)', () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'chromium', 'paint timing and the throttle are CDP, Chromium only');
  });

  test('the H1 paints under 1,500 ms on the phone throttle, and "Loading" never appears', async ({ page }) => {
    test.slow();
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __loadingSeen: string[] }).__loadingSeen = seen;
      const check = (n: Node) => {
        const t = n.textContent ?? '';
        if (/Loading/.test(t)) seen.push(t.trim().slice(0, 60));
      };
      new MutationObserver((records) => {
        for (const r of records) for (const n of Array.from(r.addedNodes)) check(n);
      }).observe(document, { childList: true, subtree: true });
      const paints: number[] = [];
      (window as unknown as { __h1Paint: number[] }).__h1Paint = paints;
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as PerformanceEntry[] & { identifier?: string; renderTime?: number }[]) {
            const el = e as unknown as { identifier: string; renderTime: number; loadTime: number };
            if (el.identifier === 'first-frame-h1') paints.push(el.renderTime || el.loadTime);
          }
        }).observe({ type: 'element', buffered: true });
      } catch { /* no Element Timing: the assertion below fails loudly on an empty list */ }
    });
    await phoneThrottle(page);
    await page.goto('/', { waitUntil: 'commit' });

    await expect
      .poll(async () => page.evaluate(() => (window as unknown as { __h1Paint: number[] }).__h1Paint.length), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
    const painted = await page.evaluate(() => (window as unknown as { __h1Paint: number[] }).__h1Paint[0]!);
    console.log(`[first-frame] H1 painted at ${Math.round(painted)} ms on the phone throttle`);
    expect(painted, 'the hero H1 was not on screen within 1,500 ms').toBeLessThan(1_500);

    // Let the whole app arrive and settle, then read what was ever inserted.
    await expect(page.locator('main#main-content h1')).toBeAttached({ timeout: 60_000 });
    await page.waitForTimeout(3_000);
    const loading = await page.evaluate(() => (window as unknown as { __loadingSeen: string[] }).__loadingSeen);
    expect(loading, '"Loading" entered the page on /').toEqual([]);
    // And the static frame's own copy never carried it either.
    expect(await page.content()).not.toMatch(/Loading\.\.\./);
  });

  test('an address submitted before any JavaScript runs lands on /?heat= and reads', async ({ page }) => {
    test.slow();
    // No script at all: the entry chunk never arrives.
    await page.route('**/assets/index-*.js', (route) => route.abort());
    await page.goto('/');
    const field = page.locator('#first-frame input[name="heat"]');
    await expect(field, 'the static field is not on screen with scripts blocked').toBeVisible({ timeout: 15_000 });
    await field.fill(ADDRESS);
    await Promise.all([page.waitForURL(/\/\?heat=/), field.press('Enter')]);
    expect(new URL(page.url()).searchParams.get('heat')).toBe(ADDRESS);

    // Now let the app load on that URL, with the island's read stubbed.
    await page.unroute('**/assets/index-*.js');
    const now = Math.floor(Date.now() / 1000);
    await page.route('**/api/aggregator**', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('resource') !== 'heat') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          address: ADDRESS, degrees: 195.54, tier: 'Builder', is_cold: false,
          held_since_unix: now - 400 * 86_400, as_of_unix: now - 3_600, token_count: 1,
          breakdown: [{ token_address: '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D', chain: 'ethereum', name: 'Towelie', symbol: 'TOWELI', heat_degrees: 195.54, first_seen_at_unix: now - 400 * 86_400, last_transfer_at_unix: now - 30 * 86_400 }],
        }),
      });
    });
    await page.reload();
    await expect(page.locator('main#main-content').getByText('Builder').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('main#main-content').getByText(/195\.5/).first()).toBeVisible();
  });

  // The seconds while the frame is on screen and the app is still arriving: these hold
  // the chunks and release them by hand, the way a phone delivers them. The field must
  // be wired before the module graph runs, survive both swaps with its focus and hidden
  // inputs, and never be read until it is submitted.

  test('while the app is still arriving, a shared read is in the field and a referral rides the form', async ({ page }) => {
    test.slow();
    const releaseEntry = await hold(page, '**/assets/index-*.js');
    await page.goto(`/?heat=${ADDRESS}&ref=${REF}`, { waitUntil: 'commit' });
    const form = page.locator('#first-frame form');
    const field = form.locator('input[name="heat"]');
    await expect(field).toBeVisible({ timeout: 15_000 });
    // The entry chunk is still held: this is the static frame, before any module ran.
    await expect(field, 'the shared read is not in the field while the app is arriving').toHaveValue(ADDRESS, { timeout: 5_000 });
    await expect(form.locator('input[type="hidden"][name="ref"]'), 'the referral is not carried by the frame form').toHaveValue(REF);

    await field.fill(OTHER);
    // 'commit': the new page cannot reach `load` while its entry chunk is still held.
    await Promise.all([page.waitForURL(/[?&]heat=/, { waitUntil: 'commit' }), field.press('Enter')]);
    const landed = new URL(page.url()).searchParams;
    expect(landed.get('heat')).toBe(OTHER);
    expect(landed.get('ref'), 'a submit from the frame dropped the referral').toBe(REF);
    releaseEntry();
  });

  test('an address typed before the app arrives survives both swaps, keeps focus, and is read only when submitted', async ({ page }) => {
    test.slow();
    let heatReads = 0;
    await stubHeatRead(page, () => { heatReads += 1; });
    const releaseEntry = await hold(page, '**/assets/index-*.js');
    const releaseHome = await hold(page, '**/assets/HomePage-*.js');
    await page.goto(`/?ref=${REF}`, { waitUntil: 'commit' });

    const staticField = page.locator('#first-frame input[name="heat"]');
    await expect(staticField).toBeVisible({ timeout: 15_000 });
    await staticField.fill(ADDRESS.slice(0, 12));
    releaseEntry();

    // React's fallback on `/`, with the home page's chunk still held.
    const fallback = page.locator('main#main-content [aria-busy="true"]');
    const fallbackField = fallback.locator('input[name="heat"]');
    await expect(fallbackField).toBeVisible({ timeout: 60_000 });
    await expect(fallbackField, 'the fallback blanked what was typed into the frame').toHaveValue(ADDRESS.slice(0, 12));
    await expect(fallbackField, 'focus fell out of the field when React took over').toBeFocused();
    await expect(fallback.locator('input[type="hidden"][name="ref"]'), 'a submit from the fallback would drop the referral').toHaveValue(REF);

    // The visitor keeps typing where they already are.
    await page.keyboard.type(ADDRESS.slice(12));
    await expect(fallbackField).toHaveValue(ADDRESS);

    releaseHome();
    const heroField = page.locator('main#main-content form input[aria-label="Wallet address to read Heat for (Ethereum or Solana)"]:not([name])');
    await expect(heroField).toBeVisible({ timeout: 60_000 });
    await expect(heroField, 'the hero dropped the address typed before it arrived').toHaveValue(ADDRESS);
    await expect(heroField, 'focus fell out of the field when the hero arrived').toBeFocused();
    await page.waitForTimeout(2_000);
    expect(heatReads, 'the hero read an address nobody submitted').toBe(0);

    await heroField.press('Enter');
    await expect.poll(() => heatReads, { timeout: 15_000 }).toBe(1);
  });

  test('an unsubmitted address does not come back after leaving the page', async ({ page }) => {
    test.slow();
    await stubHeatRead(page, () => {});
    const releaseHome = await hold(page, '**/assets/HomePage-*.js');
    await page.goto('/');
    const fallbackField = page.locator('main#main-content [aria-busy="true"] input[name="heat"]');
    await expect(fallbackField).toBeVisible({ timeout: 60_000 });
    await fallbackField.fill(ADDRESS);

    // Leave before the home page ever mounts, then come back to it client-side.
    await clientNavigate(page, '/farm');
    await expect(page.locator('main#main-content [aria-busy="true"] input[name="heat"]')).toHaveCount(0, { timeout: 15_000 });
    releaseHome();
    await clientNavigate(page, '/');
    const heroField = page.locator('main#main-content form input[aria-label="Wallet address to read Heat for (Ethereum or Solana)"]:not([name])');
    await expect(heroField).toBeVisible({ timeout: 60_000 });
    await expect(heroField, 'an address typed minutes ago came back on a later visit').toHaveValue('');
  });

  test('the frame is shut and absent off the venue home', async ({ page }) => {
    await page.route('**/assets/index-*.js', (route) => route.abort());
    await page.goto('/farm');
    await page.waitForLoadState('domcontentloaded');
    expect(await page.locator('#first-frame').count(), 'the venue hero is left in the DOM on /farm').toBe(0);
  });
});
