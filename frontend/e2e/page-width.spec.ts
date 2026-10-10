/**
 * Every page a visitor can open fits an iPad: no wider than its window at 820px (an iPad
 * upright) and at 1024px (an iPad Pro upright, an older iPad on its side). The other specs
 * open most routes at a phone's width or a laptop's only. Each page is loaded at 820px and
 * then widened, the way a tablet is turned.
 */
import { test, expect } from './fixtures/wallet';
import { expectNoSidewaysScroll, readPageWidth } from './fixtures/pageWidth';
import { AUDITABLE_ROUTES, gotoNakamigos, gotoRoute, navigablePath, waitForQuiescence } from './fixtures/routes';

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

    await page.setViewportSize({ width: IPAD_WIDTHS[0], height: 1080 });
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
