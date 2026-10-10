import { test, expect, type Page, type Route } from '@playwright/test';

// A TAB LEFT OPEN ACROSS A DEPLOY runs a build the host no longer serves: the next file
// it loads on demand is answered with the app's HTML page and status 200, which the
// browser refuses as a script. lib/staleBuild.ts reloads the tab once when the host's
// own page names another build. The deploy is played with two stubs: the lazy file
// answers as a missing asset does, and /index.html names an entry this tab is not running.

test.use({ serviceWorkers: 'block' });

/** What the host answers for an asset name it no longer has (frontend/vercel.json's last rewrite). */
const MISSING_ASSET = {
  status: 200,
  contentType: 'text/html; charset=utf-8',
  body: '<!doctype html><html><head><title>memetics.finance</title></head><body><div id="root"></div></body></html>',
};
/** The host's page after a deploy: it names an entry script this tab is not running. */
const NEXT_BUILD_PAGE = {
  status: 200,
  contentType: 'text/html; charset=utf-8',
  body: '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-NEXTBUILD.js"></script></head><body><div id="root"></div></body></html>',
};

const SOLANA_LP_CHUNK = '**/assets/SolanaLpPage-*.js';
const HOST_PAGE = '**/index.html';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('tegridy-onboarding-seen', '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
    } catch { /* private mode */ }
  });
});

/** Counts document loads: 1 after goto, one more for every reload. A tab press is not one. */
function countLoads(page: Page) {
  const seen = { loads: 0 };
  page.on('load', () => {
    seen.loads += 1;
  });
  return seen;
}

async function openLiquidity(page: Page) {
  await page.goto('/liquidity');
  const tab = page.getByRole('tab', { name: 'Solana LP' });
  await expect(tab).toBeVisible({ timeout: 30_000 });
  return tab;
}

test('the tab reloads once to the address it was going to, and the page is there', async ({ page }) => {
  // Stale until the tab has read the host's page: the reload that follows gets the new build.
  let stale = true;
  await page.route(SOLANA_LP_CHUNK, (route: Route) => (stale ? route.fulfill(MISSING_ASSET) : route.continue()));
  await page.route(HOST_PAGE, (route: Route) => {
    if (!stale) return route.continue();
    stale = false;
    return route.fulfill(NEXT_BUILD_PAGE);
  });
  const seen = countLoads(page);
  const tab = await openLiquidity(page);
  expect(seen.loads).toBe(1);

  await tab.click();

  await expect(page.getByRole('heading', { level: 1, name: 'Solana liquidity.' })).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/solana-lp$/);
  expect(seen.loads).toBe(2);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});

test('a reload that lands on the same build is not tried again: a notice and a Refresh button', async ({ page }) => {
  await page.route(SOLANA_LP_CHUNK, (route: Route) => route.fulfill(MISSING_ASSET));
  await page.route(HOST_PAGE, (route: Route) => route.fulfill(NEXT_BUILD_PAGE));
  const seen = countLoads(page);
  const tab = await openLiquidity(page);

  await tab.click();

  const notice = page.getByRole('alert').filter({ hasText: 'The site was updated' });
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toContainText('Refresh the page to load the new version.');
  await expect(page).toHaveURL(/\/solana-lp$/);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  // One reload by itself, and no more however long the tab sits there.
  expect(seen.loads).toBe(2);
  await page.waitForTimeout(2_000);
  expect(seen.loads).toBe(2);

  // The button is the visitor's own reload. Still on the old build, it ends at the notice again.
  await notice.getByRole('button', { name: 'Refresh' }).click();
  await expect.poll(() => seen.loads, { timeout: 30_000 }).toBe(3);
  await expect(page.getByRole('alert').filter({ hasText: 'The site was updated' })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2_000);
  expect(seen.loads).toBe(3);
});

test('a lazy load that fails while the host still serves this build is not called an update', async ({ page }) => {
  // Only the file fails. /index.html is the real one and names the entry this tab runs.
  await page.route(SOLANA_LP_CHUNK, (route: Route) => route.fulfill(MISSING_ASSET));
  const seen = countLoads(page);
  const tab = await openLiquidity(page);

  await tab.click();

  await expect(page.getByText('Something went wrong')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('The site was updated')).toHaveCount(0);
  await page.waitForTimeout(2_000);
  expect(seen.loads).toBe(1);
});

test('a part outside the page area that fails to load gets the same notice', async ({ page }) => {
  // The route-change effect loads on the first tab press, outside AppLayout's boundary,
  // so App.tsx's own boundary catches it and replaces the whole app area.
  await page.route('**/assets/GlitchTransition-*.js', (route: Route) => route.fulfill(MISSING_ASSET));
  await page.route(HOST_PAGE, (route: Route) => route.fulfill(NEXT_BUILD_PAGE));
  const seen = countLoads(page);
  const tab = await openLiquidity(page);
  // This tab has already reloaded itself away from this build once.
  await page.evaluate(() => {
    const running = document.querySelector('script[type="module"][src^="/assets/"]')?.getAttribute('src');
    sessionStorage.setItem('tegridy-stale-build-reload', JSON.stringify({ from: running, at: Date.now() }));
  });

  await tab.click();

  const notice = page.getByRole('alert').filter({ hasText: 'The site was updated' });
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice.getByRole('button', { name: 'Refresh' })).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  expect(seen.loads).toBe(1);
});
