import { test, expect, type Locator, type Page } from '@playwright/test';

// On a phone, each pool row's own button sits on screen beside it. The page is
// scrolled DOWN only, never a table sideways, so a table that hides its last
// column past the edge fails here. Each project's own screen, plus 360px.

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('tegridy-onboarding-seen', '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
    } catch { /* private mode */ }
  });
});

/** Scroll the page (not the table) until the link is mid-screen; where is it, and does a tap there land on it? */
async function placeOf(link: Locator) {
  return link.evaluate((a) => {
    const before = a.getBoundingClientRect();
    window.scrollTo({ top: window.scrollY + before.top - window.innerHeight / 2, behavior: 'instant' });
    const r = a.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { left: Math.round(r.left), right: Math.round(r.right), screen: document.documentElement.clientWidth, onIt: !!hit && a.contains(hit), x, y };
  });
}

async function everyButtonOnScreen(page: Page, buttons: Locator) {
  await expect(buttons.first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  const n = await buttons.count();
  const places = [];
  for (let i = 0; i < n; i++) {
    const name = (await buttons.nth(i).textContent())?.trim();
    const at = await placeOf(buttons.nth(i));
    places.push(at);
    expect(at.left, `"${name}" starts left of the screen`).toBeGreaterThanOrEqual(0);
    expect(at.right, `"${name}" ends at ${at.right}px, past the ${at.screen}px screen`).toBeLessThanOrEqual(at.screen);
    expect(at.onIt, `a tap on "${name}" lands on something else`).toBe(true);
  }
  return places;
}

async function tapAt(page: Page, x: number, y: number) {
  if (test.info().project.use.hasTouch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

for (const width of [undefined, 360] as const) {
  test.describe(width ? `at ${width}px` : "at the project's own screen", () => {
    if (width) test.use({ viewport: { width, height: 740 } });

    test('/earn: every pool opens from a button on screen', async ({ page }) => {
      await page.goto('/earn');
      await expect(page.getByRole('heading', { level: 1, name: 'Earn' })).toBeVisible({ timeout: 30_000 });
      const opens = page.getByRole('link', { name: /^Open \S+$/ });
      const places = await everyButtonOnScreen(page, opens);
      await expect(page.locator('table tbody tr')).toHaveCount(places.length);

      // The visitor's own tap on the last row's button opens that pool.
      const last = opens.last();
      const href = await last.getAttribute('href');
      const at = await placeOf(last);
      await tapAt(page, at.x, at.y);
      await expect(page).toHaveURL((u) => u.pathname === href, { timeout: 20_000 });
    });

    test('/liquidity: every pool is provided to from a button on screen', async ({ page }) => {
      await page.goto('/liquidity');
      await everyButtonOnScreen(page, page.getByRole('link', { name: 'Provide', exact: true }));
    });
  });
}
