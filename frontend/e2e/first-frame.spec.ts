import { test, expect, type Page } from '@playwright/test';

// THE FIRST FRAME IS THE HERO - answer ten, ruling 2, walked on a production build.
//
// The island's measurement, on a production build with a phone throttle (150 ms
// round trip, 1.6 Mbps, CPU 4x): `/` painted NOTHING until 6.7 s, then "Loading..."
// for a second, then the H1 at 7.8 s. A holder reported the same, unprompted:
// "Loading... for a couple of seconds. Impatient degens leave."
//
// Three promises, each asserted the way it can actually fail:
//
//   1. H1 VISIBLE UNDER 1,500 MS ON THE THROTTLE. Read from the Element Timing API
//      on the static H1 (elementtiming="first-frame-h1"): that is the moment the
//      browser PAINTED those words, not the moment a node existed. A DOM read would
//      pass on markup hidden behind a stylesheet that had not arrived.
//   2. "LOADING" NEVER ENTERS THE PAGE. A MutationObserver armed before any script
//      records every text node inserted, so a skeleton that appeared and left again
//      still fails. Absent from the DOM means absent from every frame.
//   3. AN ADDRESS SUBMITTED BEFORE ANY JAVASCRIPT RUNS STILL READS. The entry chunk
//      is blocked outright, the visitor pastes and submits the static field, and
//      the browser's own GET must land on /?heat=<address>; then the app loads and
//      reads that wallet.
//
// Chromium only: the throttle is CDP, and the numbers are a promise about Chromium's
// paint, the engine the island measured with.

const ADDRESS = '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a';

async function phoneThrottle(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
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

  test('the frame is shut and absent off the venue home', async ({ page }) => {
    await page.route('**/assets/index-*.js', (route) => route.abort());
    await page.goto('/farm');
    await page.waitForLoadState('domcontentloaded');
    expect(await page.locator('#first-frame').count(), 'the venue hero is left in the DOM on /farm').toBe(0);
  });
});
