/**
 * THE PAGE COLUMN STEPS UP WITH THE SCREEN (owner, 2026-10-19). One rule, page-column in
 * index.css: 1200px, 1360px from 1536px, 1600px from 1920px, 1800px from 2560px, read by the
 * bar, the page and the footer alike, so they stay on one edge. A room with a market lays its
 * cards on a grid from 1536px: the market across two thirds, the burn, the held time and the
 * holders stacked beside it, the lore across the whole; under 1536px they stack as they always
 * did. The rail docks in the gutter at every step and never reaches the hero. Chromium only:
 * the test sets the width, so one desktop engine is the measurement.
 */
import { test, expect, type Page } from '@playwright/test';
import { gotoRoute } from './fixtures/routes';
import { expectNoSidewaysScroll } from './fixtures/pageWidth';

/** The column at a window width: its step, or the window where that is narrower. */
const column = (width: number) =>
  width >= 2560 ? 1800 : width >= 1920 ? 1600 : width >= 1536 ? 1360 : Math.min(1200, width);

// Each step's first and last pixel, the rail's two, and the owner's own desktop.
const WIDTHS = [1280, 1440, 1535, 1536, 1700, 1919, 1920, 2559, 2560, 3400];
const HEIGHT = 1200;

test.use({ serviceWorkers: 'block' });

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'chromium', 'the test sets the width; one desktop engine is enough');
});

async function seed(page: Page) {
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem('tf_loaded', '1');
      localStorage.setItem('tegridy-onboarding-seen', '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
      // `/` reloads once to clear a stored skin; the venue sentinel leaves it nothing to clear.
      localStorage.setItem('tegridy-bungalow', 'venue');
    } catch { /* ignore */ }
  });
  // No /api behind a preview: a quick 503 is the outage the cards already say so about, not a hang.
  await page.route(
    (url) => url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/_lib/'),
    (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
  );
}

async function box(page: Page, selector: string) {
  const b = await page.locator(selector).first().boundingBox();
  expect(b, `${selector} has a box`).not.toBeNull();
  return b!;
}

const round = (n: number) => Math.round(n);

test('the bar, the page and the footer share the column, at each of its steps', async ({ page }) => {
  await seed(page);
  await page.setViewportSize({ width: 1280, height: HEIGHT });
  await gotoRoute(page, '/bayla');
  for (const width of WIDTHS) {
    await test.step(`${width}px`, async () => {
      await page.setViewportSize({ width, height: HEIGHT });
      const want = column(width);
      const main = await box(page, 'main .page-column');
      const bar = await box(page, 'header .page-column');
      const footer = await box(page, '[role="contentinfo"] .page-column');
      expect(round(main.width), 'the page').toBe(want);
      expect(round(bar.width), 'the bar').toBe(want);
      expect(round(footer.width), 'the footer').toBe(want);
      expect(round(main.x), 'centred').toBe(round((width - want) / 2));
      // The heading sits 24px inside the column's edge, where the first frame draws it (index.html).
      const h1 = await box(page, 'main h1');
      expect(round(h1.x), 'the hero on the column’s edge').toBe(round(main.x) + 24);
      await expectNoSidewaysScroll(page);
    });
  }
});

test("the venue's own door keeps its hero on the column's edge too", async ({ page }) => {
  await seed(page);
  await page.setViewportSize({ width: 1280, height: HEIGHT });
  await gotoRoute(page, '/');
  for (const width of [1280, 1920, 2560]) {
    await test.step(`${width}px`, async () => {
      await page.setViewportSize({ width, height: HEIGHT });
      const h1 = await box(page, 'main h1');
      expect(round(h1.x)).toBe(round((width - column(width)) / 2) + 24);
      await expectNoSidewaysScroll(page);
    });
  }
});

test("a room's cards stack under 1536px and sit on the grid from it", async ({ page }) => {
  await seed(page);
  await page.setViewportSize({ width: 1280, height: HEIGHT });
  await gotoRoute(page, '/bayla');
  await expect(page.locator('#room-market')).toBeVisible();
  for (const width of WIDTHS) {
    await test.step(`${width}px`, async () => {
      await page.setViewportSize({ width, height: HEIGHT });
      const market = await box(page, '#room-market');
      const burn = await box(page, '#room-burn');
      const held = await box(page, '#room-held-time');
      const holders = await box(page, '#room-holders');
      const lore = await box(page, '#room-lore');
      if (width < 1536) {
        // One under the other, each as wide as the market.
        for (const [name, b] of [['the burn', burn], ['the held time', held], ['the holders', holders], ['the lore', lore]] as const) {
          expect(round(b.x), `${name} starts where the market does`).toBe(round(market.x));
          expect(round(b.width), `${name} is as wide as the market`).toBe(round(market.width));
        }
        expect(burn.y, 'the burn is under the market').toBeGreaterThanOrEqual(market.y + market.height - 1);
      } else {
        // The market across eight columns, the three readings stacked in the other four, the lore across all.
        expect(round(burn.y), 'the burn tops the row with the market').toBe(round(market.y));
        expect(burn.x, 'the burn is beside the market, past the gap').toBeGreaterThanOrEqual(market.x + market.width + 24);
        expect(round(held.x), 'the held time is in the stack').toBe(round(burn.x));
        expect(round(holders.x), 'the holders are in the stack').toBe(round(burn.x));
        expect(held.y).toBeGreaterThanOrEqual(burn.y + burn.height - 1);
        expect(holders.y).toBeGreaterThanOrEqual(held.y + held.height - 1);
        expect(market.width / burn.width, 'eight columns to four').toBeGreaterThan(1.9);
        expect(market.width / burn.width, 'eight columns to four').toBeLessThan(2.2);
        expect(round(lore.x), 'the lore starts with the market').toBe(round(market.x));
        expect(round(lore.x + lore.width), 'the lore ends with the stack').toBe(round(burn.x + burn.width));
        expect(lore.y, 'the lore is under both').toBeGreaterThanOrEqual(Math.max(market.y + market.height, holders.y + holders.height) - 1);
      }
      // The market's six tiles: one row in the full column and from 1920px, two rows in the eight-column slot before that.
      const rows = new Set(await page.locator('#room-market section > div.grid > div').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top))));
      expect(rows.size, 'rows of market tiles').toBe(width >= 1536 && width < 1920 ? 2 : 1);
      await expectNoSidewaysScroll(page);
    });
  }
});

test('the rail docks in the gutter at every step and never reaches the hero', async ({ page }) => {
  await seed(page);
  await page.setViewportSize({ width: 1280, height: HEIGHT });
  await gotoRoute(page, '/bayla');
  const rail = page.getByRole('navigation', { name: 'On this page' });
  await expect(rail).toBeVisible();
  for (const width of WIDTHS) {
    await test.step(`${width}px`, async () => {
      await page.setViewportSize({ width, height: HEIGHT });
      const r = (await rail.boundingBox())!;
      const h1 = await box(page, 'main h1');
      const word = (await page.getByRole('link', { name: 'Held time' }).boundingBox())!;
      if (width < 1440) {
        // A strip in the column, above the hero.
        expect(r.y + r.height, 'the strip is above the heading').toBeLessThanOrEqual(h1.y);
        expect(r.x, 'the strip is in the column').toBeGreaterThanOrEqual(h1.x - 8);
      } else {
        // Docked at the left edge, clear of the heading by at least 8px.
        expect(r.x, 'at the left edge').toBeLessThan(40);
        expect(r.x + r.width + 8, 'clear of the hero').toBeLessThanOrEqual(h1.x);
        // Its words from 1700px: a number alone is under 50px wide, "04 HELD TIME" over 90.
        if (width >= 1700) expect(word.width, 'the word shows').toBeGreaterThan(90);
        else expect(word.width, 'the number alone').toBeLessThan(50);
      }
    });
  }
});
