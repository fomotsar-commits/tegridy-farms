// SCRATCH, UNCOMMITTED: the old helper and the new one, side by side, on a page known to be too wide.
import type { Page } from '@playwright/test';
import { test, expect } from '../e2e/fixtures/wallet';
import { gotoRoute } from '../e2e/fixtures/routes';
import { expectNoSidewaysScroll, readPageWidth } from '../e2e/fixtures/pageWidth';

// Trunk bcafb7b3's helper, verbatim.
async function oldExpectNoSidewaysScroll(page: Page): Promise<void> {
  const moved = await page.evaluate(() => {
    const before = window.scrollX;
    window.scrollTo(500, 0);
    const after = window.scrollX;
    window.scrollTo(0, 0);
    return { before, after, scrollW: document.documentElement.scrollWidth };
  });
  expect(moved.after, `the page slid sideways to x=${moved.after} (scrollWidth ${moved.scrollW}).`).toBe(moved.before);
}

for (const width of (process.env.REDFIRST_WIDTHS ?? '820').split(',').map(Number)) {
  test(`OLD helper: /nft-finance at ${width}px`, async ({ page, walletMock: _w }) => {
    await page.setViewportSize({ width, height: 900 });
    await gotoRoute(page, '/nft-finance');
    await page.evaluate(() => document.fonts.ready);
    await oldExpectNoSidewaysScroll(page);
  });

  test(`NEW helper: /nft-finance at ${width}px`, async ({ page, walletMock: _w }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await gotoRoute(page, '/nft-finance');
    await page.evaluate(() => document.fonts.ready);
    const read = await readPageWidth(page);
    const inner = await page.evaluate(() => window.innerWidth);
    console.log(`READ ${info.project.name} asked=${width} innerWidth=${inner} ${JSON.stringify(read)}`);
    await expectNoSidewaysScroll(page);
  });
}
