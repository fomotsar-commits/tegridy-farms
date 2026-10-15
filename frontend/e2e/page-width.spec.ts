/**
 * Every page a visitor can open fits an iPad: no wider than its window at 820px (an iPad
 * upright) and at 1024px (an iPad Pro upright, an older iPad on its side). The other specs
 * open most routes at a phone's width or a laptop's only. Each page is loaded at 820px and
 * then widened, the way a tablet is turned.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures/wallet';
import { expectNoSidewaysScroll, readPageWidth } from './fixtures/pageWidth';
import { AUDITABLE_ROUTES, GECKO_EDGE_GLOB, gotoNakamigos, gotoRoute, navigablePath, waitForQuiescence } from './fixtures/routes';

const IPAD_WIDTHS = [820, 1024];

// The ruler itself, in all four projects: a check that cannot fail in one of them proves nothing there.
test('a page made 1,100px wide in an 820px window reads as 280px too wide', async ({ page, walletMock: _w }) => {
  await page.setViewportSize({ width: 820, height: 1080 });
  await gotoRoute(page, '/island');
  await expectNoSidewaysScroll(page);
  await page.evaluate(() => {
    const wide = document.createElement('div');
    wide.id = 'too-wide';
    wide.style.cssText = 'width:1100px;height:10px';
    document.body.append(wide);
  });
  expect(await readPageWidth(page)).toMatchObject({ page: 1100, window: 820, over: 280, widest: ['<div#too-wide> 0..1100px'] });
  await expect(expectNoSidewaysScroll(page)).rejects.toThrow('1100px wide in a 820px window');
});

// The test sets the width, so two projects cover it: the desktop engine, and the iPad's own with touch.
const ENGINES = ['chromium', 'ipad-safari'];

for (const route of AUDITABLE_ROUTES) {
  test(`${route.path} is no wider than an iPad's window`, async ({ page, walletMock: _w }) => {
    test.skip(!ENGINES.includes(test.info().project.name), 'one pass per engine: the test sets the width, not the project');
    const isNakamigos = route.path === '/nakamigos';
    // Its splash alone can outlast the default budget on a loaded WebKit worker.
    if (isNakamigos) test.setTimeout(120_000);
    // `/` reloads once to clear a stored skin; the `venue` sentinel leaves it nothing to clear.
    if (route.path === '/') {
      await page.addInitScript(() => {
        try { localStorage.setItem('tegridy-bungalow', 'venue'); } catch { /* ignore */ }
      });
    }

    await page.setViewportSize({ width: IPAD_WIDTHS[0] ?? 820, height: 1080 });
    if (isNakamigos) await gotoNakamigos(page);
    else await gotoRoute(page, navigablePath(route));

    for (const width of IPAD_WIDTHS) {
      await test.step(`${width}px`, async () => {
        await page.setViewportSize({ width, height: 1080 });
        await waitForQuiescence(page, { quietMs: 500, timeout: 6_000 });
        await page.evaluate(() => document.fonts.ready);
        await expectNoSidewaysScroll(page);
      });
    }
  });
}

// /terminal draws its market table only when the GeckoTerminal feed answers, and `vite preview`
// has no /api/aggregator, so the loop above only ever measures it with no table. Live on
// 2026-10-14 the drawn table (min-width 840px) made the page 122px too wide at 768px and 70px
// at 820px. Here the feed gets the committed capture, so the table is on the page being measured.
const ETH_NEW_POOLS = readFileSync(
  fileURLToPath(new URL('../src/lib/geckoTerminal/fixtures/eth_new_pools.json', import.meta.url)),
  'utf8',
);

test("/terminal with its market table drawn is no wider than an iPad's window", async ({ page, walletMock: _w }) => {
  test.skip(!ENGINES.includes(test.info().project.name), 'one pass per engine: the test sets the width, not the project');
  await page.route(GECKO_EDGE_GLOB, (r) =>
    r.request().url().includes('new_pools')
      ? r.fulfill({ status: 200, contentType: 'application/json', body: ETH_NEW_POOLS })
      : r.abort(),
  );

  await page.setViewportSize({ width: 768, height: 1080 });
  await gotoRoute(page, '/terminal');
  await expect(page.locator('main table')).toBeVisible();

  for (const width of [768, ...IPAD_WIDTHS]) {
    await test.step(`${width}px`, async () => {
      await page.setViewportSize({ width, height: 1080 });
      await waitForQuiescence(page, { quietMs: 500, timeout: 6_000 });
      await page.evaluate(() => document.fonts.ready);
      await expectNoSidewaysScroll(page);
    });
  }
});
