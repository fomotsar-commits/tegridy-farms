/**
 * /nft-finance: the section tabs scroll inside their own strip and never move
 * the page. From 768px up the row is about 1,095px wide, wider than an iPad held
 * upright, and it used to carry the whole page sideways with it. Measured from
 * rendered boxes against the width the test asked for: a phone browser widens
 * its own window to fit a page that is too wide, so `innerWidth` cannot be the
 * ruler.
 */
import { test, expect } from './fixtures/wallet';
import { gotoRoute } from './fixtures/routes';

// A phone, the `md` breakpoint, an iPad upright, an iPad Pro upright, an iPad on its side, a laptop.
const WIDTHS = [390, 768, 820, 1024, 1180, 1280];

/** Sub-pixel rounding is not a cut. */
const TOLERANCE_PX = 1;

/** How wide the document is, and how far the page moves when it is pushed sideways. */
function readPage() {
  window.scrollTo(500, 0);
  const slid = window.scrollX;
  window.scrollTo(0, 0);
  return { slid, pageWidth: document.documentElement.scrollWidth };
}

/** The strip's box, how many px of tabs it holds out of view, and whether its right edge fades. */
function readStrip(list: Element) {
  const box = list.getBoundingClientRect();
  const cs = getComputedStyle(list);
  const mask = cs.maskImage || cs.webkitMaskImage;
  return {
    left: box.left,
    right: box.right,
    hidden: list.scrollWidth - list.clientWidth,
    faded: !!mask && mask !== 'none',
  };
}

/** How many px of a tab lie outside what a visitor can see of its strip, in a window `width` wide. */
function cutPx(tab: Element, width: number) {
  const list = tab.closest('[role="tablist"]')!;
  const edge = list.getBoundingClientRect();
  const seenL = Math.max(edge.left + list.clientLeft, 0);
  const seenR = Math.min(edge.left + list.clientLeft + list.clientWidth, width);
  const box = tab.getBoundingClientRect();
  return Math.max(seenL - box.left, box.right - seenR, 0);
}

for (const width of WIDTHS) {
  test(`/nft-finance at ${width}px: the page does not move sideways and every section tab can be reached`, async ({
    page,
    walletMock: _w,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await gotoRoute(page, '/nft-finance');
    const list = page.getByRole('tablist', { name: 'NFT Finance sections' });
    const tabs = list.getByRole('tab');
    await expect(tabs.first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const count = await tabs.count();
    expect(count, 'no tab strip found: the page changed shape').toBeGreaterThan(1);

    const before = await page.evaluate(readPage);
    expect(before.pageWidth, `the page is ${before.pageWidth}px wide in a ${width}px window`).toBeLessThanOrEqual(
      width + TOLERANCE_PX,
    );
    expect(before.slid, 'the page moved sideways').toBe(0);

    const strip = await list.evaluate(readStrip);
    expect(strip.left, 'the strip starts left of the window').toBeGreaterThanOrEqual(-TOLERANCE_PX);
    expect(strip.right, `the strip ends at ${Math.round(strip.right)}px of a ${width}px window`).toBeLessThanOrEqual(
      width + TOLERANCE_PX,
    );
    // The scrollbar is hidden, so the fade is the only sign that there are more tabs.
    const scrolls = strip.hidden > TOLERANCE_PX;
    expect(
      strip.faded,
      scrolls
        ? `${Math.round(strip.hidden)}px of tabs are out of view and the strip's right edge does not fade`
        : 'the strip fits and its right edge still fades',
    ).toBe(scrolls);

    // Each tab can be brought whole into the strip, pressed, and becomes the selected one.
    for (let i = 0; i < count; i++) {
      const tab = tabs.nth(i);
      const label = (await tab.textContent())?.trim() ?? `tab ${i}`;
      await tab.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
      await expect
        .poll(() => tab.evaluate(cutPx, width), `"${label}" cannot be brought whole into its strip`)
        .toBeLessThanOrEqual(TOLERANCE_PX);
      await tab.click();
      await expect(tab, `"${label}" was pressed and is not the selected tab`).toHaveAttribute('aria-selected', 'true');
    }

    const after = await page.evaluate(readPage);
    expect(after.slid, 'reaching the last tab moved the page sideways').toBe(0);
  });
}
