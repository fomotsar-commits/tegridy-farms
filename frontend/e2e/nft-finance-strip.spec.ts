/**
 * /nft-finance: the section tabs scroll inside their own strip and never move
 * the page, and the selected tab is whole in view on landing and after a press.
 * From 768px up the row is about 1,095px wide, wider than an iPad held upright.
 * Measured from rendered boxes against the width the test asked for: a phone
 * browser widens its own window to fit a page that is too wide, so `innerWidth`
 * cannot be the ruler.
 */
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/wallet';
import { gotoRoute } from './fixtures/routes';

// A phone, the `md` breakpoint, an iPad upright, an iPad Pro upright, an iPad on its side, a laptop.
const WIDTHS = [390, 768, 820, 1024, 1180, 1280];

// A phone and an iPad upright: the strip holds tabs out of view at both.
const SCROLLING_WIDTHS = [390, 820];

/** Sub-pixel rounding is not a cut. */
const TOLERANCE_PX = 1;

/** The least of a tab's box that must be inside the strip for a press to land on it. */
const PRESSABLE_PX = 12;

/** The strip's right edge fades. The selected tab keeps this much room from it (the reveal's 24px, less rounding). */
const FADE_ROOM_PX = 23;

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

/** How many px of its strip show to the right of a tab, in a window `width` wide. */
function roomPx(tab: Element, width: number) {
  const list = tab.closest('[role="tablist"]')!;
  const seenR = Math.min(list.getBoundingClientRect().left + list.clientLeft + list.clientWidth, width);
  return seenR - tab.getBoundingClientRect().right;
}

/** The tab furthest toward `side` with enough showing to press, where to press it, and what is there. */
function furthestShown(
  list: Element,
  { width, side, pressable }: { width: number; side: 'left' | 'right'; pressable: number },
) {
  const edge = list.getBoundingClientRect();
  const seenL = Math.max(edge.left + list.clientLeft, 0);
  const seenR = Math.min(edge.left + list.clientLeft + list.clientWidth, width);
  const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
  for (const tab of side === 'right' ? tabs.reverse() : tabs) {
    const box = tab.getBoundingClientRect();
    const shownL = Math.max(box.left, seenL);
    const shownR = Math.min(box.right, seenR);
    if (shownR - shownL < pressable) continue;
    const x = (shownL + shownR) / 2;
    const y = box.top + box.height / 2;
    return { id: tab.id, x, y, hit: document.elementFromPoint(x, y)?.closest('[role="tab"]')?.id ?? null };
  }
  return null;
}

const frames = (page: Page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** Gives `tab` up to ~1s to sit whole in its strip, then the most it is cut over the next ten frames. */
async function settledCut(page: Page, tab: Locator, width: number) {
  let cut = Infinity;
  for (let i = 0; i < 30 && cut > TOLERANCE_PX; i++) {
    if (i) await frames(page);
    cut = await tab.evaluate(cutPx, width);
  }
  for (let i = 0; i < 5; i++) {
    await frames(page);
    cut = Math.max(cut, await tab.evaluate(cutPx, width));
  }
  return cut;
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

for (const width of SCROLLING_WIDTHS) {
  test(`/nft-finance at ${width}px: landing on a section shows its tab whole inside the strip`, async ({
    page,
    walletMock: _w,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await gotoRoute(page, '/nft-finance');
    const list = page.getByRole('tablist', { name: 'NFT Finance sections' });
    await expect(list.getByRole('tab').first()).toBeVisible();
    const ids = await list.getByRole('tab').evaluateAll((els) => els.map((el) => el.id));
    expect(ids.length, 'no tab strip found: the page changed shape').toBeGreaterThan(1);

    const problems: string[] = [];
    for (const id of ids) {
      const section = id.replace('nft-finance-tab-', '');
      await gotoRoute(page, `/nft-finance?section=${section}`);
      const tab = list.getByRole('tab', { selected: true });
      await expect(tab, `?section=${section} did not select its tab`).toHaveAttribute('id', id);
      await page.evaluate(() => document.fonts.ready);
      const cut = await settledCut(page, tab, width);
      if (cut > TOLERANCE_PX) problems.push(`?section=${section}: its tab is cut ${Math.round(cut)}px by the strip's edge`);
      // The last tab too: at the end of the strip the fade must not sit on it.
      const room = await tab.evaluate(roomPx, width);
      if (room < FADE_ROOM_PX) problems.push(`?section=${section}: its tab ends ${Math.round(room)}px from the strip's faded edge`);
      // Only the strip scrolls to show it: the page stays where it landed.
      const at = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      if (at.x || at.y) problems.push(`?section=${section}: landing moved the page to ${at.x},${at.y}`);
    }
    expect(problems, 'selected tabs out of view on landing').toEqual([]);
  });

  // The scrollbar is hidden, so with a mouse the only way along the strip is to press the furthest tab that shows.
  test(`/nft-finance at ${width}px: pressing the furthest tab that shows walks the strip to its last tab and back`, async ({
    page,
    walletMock: _w,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await gotoRoute(page, '/nft-finance?section=lending');
    const list = page.getByRole('tablist', { name: 'NFT Finance sections' });
    const tabs = list.getByRole('tab');
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    await page.evaluate(() => document.fonts.ready);
    const count = await tabs.count();

    const walks = [
      { side: 'right', end: tabs.last(), name: 'last' },
      { side: 'left', end: tabs.first(), name: 'first' },
    ] as const;
    for (const { side, end, name } of walks) {
      expect(
        await end.evaluate(cutPx, width),
        `the ${name} tab is already in view: there is nothing to walk to`,
      ).toBeGreaterThan(TOLERANCE_PX);
      for (let presses = 0; presses < count && (await end.evaluate(cutPx, width)) > TOLERANCE_PX; presses++) {
        // Each section is a different height: the strip goes back to the middle of the
        // window, clear of the bars fixed to its top and bottom, before every press.
        await list.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
        const press = await list.evaluate(furthestShown, { width, side, pressable: PRESSABLE_PX });
        if (!press) throw new Error(`no tab shows ${PRESSABLE_PX}px of itself to press`);
        expect(press.hit, `the part of ${press.id} that shows cannot be pressed`).toBe(press.id);
        // A bare mouse press: `locator.click()` would scroll the tab into view itself.
        await page.mouse.click(press.x, press.y);
        const tab = page.locator(`#${press.id}`);
        await expect(tab, `${press.id} was pressed and is not the selected tab`).toHaveAttribute('aria-selected', 'true');
        const cut = await settledCut(page, tab, width);
        expect(
          cut,
          `${press.id} was pressed and is still cut ${Math.round(cut)}px by the strip's edge`,
        ).toBeLessThanOrEqual(TOLERANCE_PX);
      }
      const cut = await settledCut(page, end, width);
      expect(
        cut,
        `pressing the furthest tab that shows did not bring the ${name} tab into view: it is cut ${Math.round(cut)}px`,
      ).toBeLessThanOrEqual(TOLERANCE_PX);
    }
  });
}
