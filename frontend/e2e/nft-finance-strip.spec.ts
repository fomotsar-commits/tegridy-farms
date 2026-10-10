/**
 * /nft-finance: the section tabs scroll inside their own strip and never move
 * the page, the selected tab is whole in view on landing and after a press, and
 * an arrow shows over each end of the strip that has tabs past it. Measured from
 * rendered boxes against the width the test asked for: a phone browser widens
 * its own window to fit a page that is too wide, so `innerWidth` cannot be the ruler.
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

/** The least of a tab's box that must show for a press to land on it. */
const PRESSABLE_PX = 12;

/** How much of a tab is left showing at an end of the strip before it is pressed: more than an arrow covers. */
const LEFT_SHOWING_PX = 80;

/** The strip's right edge fades. The selected tab keeps this much room from it (the least the reveal leaves, less rounding). */
const FADE_ROOM_PX = 23;

/** The least an arrow measures each way (WCAG 2.5.8). */
const ARROW_MIN_PX = 24;

type Side = 'left' | 'right';

/** The arrow over an end of the strip, by the name a screen reader gives it. */
const ARROW_NAMES: Record<Side, string> = { left: 'Earlier sections', right: 'More sections' };
const arrowAt = (page: Page, side: Side) => page.getByRole('button', { name: ARROW_NAMES[side], exact: true });

/** How wide the document is, and how far the page moves when it is pushed sideways. */
function readPage() {
  window.scrollTo(500, 0);
  const slid = window.scrollX;
  window.scrollTo(0, 0);
  return { slid, pageWidth: document.documentElement.scrollWidth };
}

/** The strip's box, how many px of tabs it holds out of view, whether its right edge fades, and which ends cut a tab. */
function readStrip(list: Element) {
  const box = list.getBoundingClientRect();
  const cs = getComputedStyle(list);
  const mask = cs.maskImage || cs.webkitMaskImage;
  const first = list.querySelector('[role="tab"]')!.getBoundingClientRect();
  return {
    left: box.left,
    right: box.right,
    hidden: list.scrollWidth - list.clientWidth,
    faded: !!mask && mask !== 'none',
    more: {
      left: first.left < box.left + list.clientLeft - 1,
      right: list.scrollLeft < list.scrollWidth - list.clientWidth - 1,
    },
  };
}

/** How many px of a tab lie outside what a visitor can see of its strip, in a window `width` wide. */
function cutPx(tab: Element, width: number) {
  const list = tab.closest('[role="tablist"]')!;
  const edge = list.getBoundingClientRect();
  let seenL = Math.max(edge.left + list.clientLeft, 0);
  let seenR = Math.min(edge.left + list.clientLeft + list.clientWidth, width);
  // An arrow over an end of the strip hides the tabs under it.
  for (const arrow of list.parentElement!.querySelectorAll('[data-strip-arrow]')) {
    const over = arrow.getBoundingClientRect();
    if (arrow.getAttribute('data-strip-arrow') === 'prev') seenL = Math.max(seenL, over.right);
    else seenR = Math.min(seenR, over.left);
  }
  const box = tab.getBoundingClientRect();
  return Math.max(seenL - box.left, box.right - seenR, 0);
}

/** How many px of its strip show to the right of a tab, in a window `width` wide. */
function roomPx(tab: Element, width: number) {
  const list = tab.closest('[role="tablist"]')!;
  const seenR = Math.min(list.getBoundingClientRect().left + list.clientLeft + list.clientWidth, width);
  return seenR - tab.getBoundingClientRect().right;
}

/** Scrolls the strip, and only the strip, until `shown` px of a tab are left inside its `side` end. */
function leaveShowing(tab: Element, { side, shown }: { side: Side; shown: number }) {
  const list = tab.closest('[role="tablist"]')!;
  const edge = list.getBoundingClientRect().left + list.clientLeft;
  const box = tab.getBoundingClientRect();
  list.scrollLeft += side === 'right' ? box.left - (edge + list.clientWidth - shown) : box.right - (edge + shown);
}

/** The part of a tab that shows in its strip, clear of the arrows: how wide it is, where to press it, and what is there. */
function pressPoint(tab: Element, width: number) {
  const list = tab.closest('[role="tablist"]')!;
  const edge = list.getBoundingClientRect();
  let seenL = Math.max(edge.left + list.clientLeft, 0);
  let seenR = Math.min(edge.left + list.clientLeft + list.clientWidth, width);
  for (const arrow of list.parentElement!.querySelectorAll('[data-strip-arrow]')) {
    const over = arrow.getBoundingClientRect();
    if (arrow.getAttribute('data-strip-arrow') === 'prev') seenL = Math.max(seenL, over.right);
    else seenR = Math.min(seenR, over.left);
  }
  const box = tab.getBoundingClientRect();
  const shownL = Math.max(box.left, seenL);
  const shownR = Math.min(box.right, seenR);
  const x = (shownL + shownR) / 2;
  const y = box.top + box.height / 2;
  return { shown: shownR - shownL, x, y, hit: document.elementFromPoint(x, y)?.closest('[role="tab"]')?.id ?? null };
}

/** Where to press an arrow, and everything that keeps a visitor from seeing it or pressing it in a window `width` wide. */
function readArrow(arrow: Element, { width, min }: { width: number; min: number }) {
  const box = arrow.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const problems: string[] = [];
  if (box.width < min || box.height < min) problems.push(`it is ${Math.round(box.width)}x${Math.round(box.height)}px`);
  if (box.left < 0 || box.right > width) {
    problems.push(`it spans ${Math.round(box.left)}px to ${Math.round(box.right)}px of a ${width}px window`);
  }
  const strip = arrow.parentElement?.querySelector('[role="tablist"]')?.getBoundingClientRect();
  if (!strip || box.left < strip.left || box.right > strip.right || box.top < strip.top || box.bottom > strip.bottom) {
    problems.push('it is not inside the strip');
  }
  const icon = arrow.querySelector('svg')?.getBoundingClientRect();
  if (!icon || icon.width < min / 2 || icon.height < min / 2) problems.push('it draws no icon');
  // The strip's fade is a mask: a mask, an opacity or a hidden box on the arrow or anything around it takes the arrow too.
  for (let el: Element | null = arrow; el; el = el.parentElement) {
    const cs = getComputedStyle(el);
    const mask = cs.maskImage || cs.webkitMaskImage;
    if ((mask && mask !== 'none') || Number(cs.opacity) < 1 || cs.visibility !== 'visible') {
      problems.push(`<${el.tagName.toLowerCase()} class="${el.getAttribute('class') ?? ''}"> fades or hides it`);
    }
  }
  const hit = document.elementFromPoint(x, y);
  if (!hit || !arrow.contains(hit)) problems.push('a press on its middle lands on something else');
  return { x, y, problems };
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

/** Gives the strip up to ~1s to stop moving, then where it stopped. */
async function settledScroll(page: Page, list: Locator) {
  let at = await list.evaluate((el) => el.scrollLeft);
  for (let i = 0; i < 30; i++) {
    await frames(page);
    const now = await list.evaluate((el) => el.scrollLeft);
    if (now === at) break;
    at = now;
  }
  return at;
}

/** Gives the arrows up to ~1s to catch up with the strip, then where the part of `tab` that shows can be pressed. */
async function settledPress(page: Page, tab: Locator, width: number) {
  let press = await tab.evaluate(pressPoint, width);
  for (let i = 0; i < 15; i++) {
    await frames(page);
    const now = await tab.evaluate(pressPoint, width);
    const still = now.x === press.x && now.shown === press.shown;
    press = now;
    if (still && i >= 2) break;
  }
  return press;
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
    // The scrollbar is hidden: the fade and the arrows are the only signs that there are more tabs.
    const scrolls = strip.hidden > TOLERANCE_PX;
    expect(
      strip.faded,
      scrolls
        ? `${Math.round(strip.hidden)}px of tabs are out of view and the strip's right edge does not fade`
        : 'the strip fits and its right edge still fades',
    ).toBe(scrolls);
    expect(strip.more.right, 'the strip landed with no tabs past its right end').toBe(scrolls);
    for (const side of ['left', 'right'] as const) {
      await expect(
        arrowAt(page, side),
        strip.more[side]
          ? `tabs are out of view past the strip's ${side} end and no arrow shows there`
          : `no tab is out of view past the strip's ${side} end and an arrow shows there`,
      ).toHaveCount(strip.more[side] ? 1 : 0);
    }

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
      // A new selection shows its tab once more on the next frame (its resize watcher
      // reports on starting). Moving the strip before that is undone; no visitor is that quick.
      await frames(page);
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
      if (cut > TOLERANCE_PX) {
        problems.push(`?section=${section}: its tab is cut ${Math.round(cut)}px by the strip's edge or an arrow`);
      }
      // The last tab too: at the end of the strip the fade must not sit on it.
      const room = await tab.evaluate(roomPx, width);
      if (room < FADE_ROOM_PX) problems.push(`?section=${section}: its tab ends ${Math.round(room)}px from the strip's faded edge`);
      // Only the strip scrolls to show it: the page stays where it landed.
      const at = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      if (at.x || at.y) problems.push(`?section=${section}: landing moved the page to ${at.x},${at.y}`);
    }
    expect(problems, 'selected tabs out of view on landing').toEqual([]);
  });

  // The scrollbar is hidden, so with a mouse the arrows are the way along the strip.
  test(`/nft-finance at ${width}px: an arrow shows over each end with tabs past it, and pressing the arrows walks the strip to its last tab and back`, async ({
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
    const landed = await list.getByRole('tab', { selected: true }).getAttribute('id');

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
        const arrow = arrowAt(page, side);
        await expect(arrow, `the ${name} tab is out of view and no arrow shows over the strip's ${side} end`).toBeVisible();
        // The strip fades in on landing: the arrow is read once that is over.
        let seen = await arrow.evaluate(readArrow, { width, min: ARROW_MIN_PX });
        await expect
          .poll(
            async () => (seen = await arrow.evaluate(readArrow, { width, min: ARROW_MIN_PX })).problems,
            `the arrow over the strip's ${side} end cannot be seen or pressed`,
          )
          .toEqual([]);
        const from = await list.evaluate((el) => el.scrollLeft);
        // A bare mouse press: `locator.click()` would scroll and wait by itself.
        await page.mouse.click(seen.x, seen.y);
        await expect
          .poll(() => list.evaluate((el) => el.scrollLeft), `the ${side} arrow was pressed and the strip did not move`)
          .not.toBe(from);
        const to = await settledScroll(page, list);
        expect(
          side === 'right' ? to - from : from - to,
          `the ${side} arrow was pressed and the strip went from ${from}px to ${to}px`,
        ).toBeGreaterThan(TOLERANCE_PX);
      }
      const cut = await settledCut(page, end, width);
      expect(
        cut,
        `pressing the ${side} arrow did not bring the ${name} tab into view: it is cut ${Math.round(cut)}px`,
      ).toBeLessThanOrEqual(TOLERANCE_PX);
      await expect(arrowAt(page, side), `the ${name} tab is in view and the ${side} arrow still shows`).toHaveCount(0);
    }

    // The arrows move the strip and nothing else.
    await expect(list.getByRole('tab', { selected: true }), 'pressing the arrows changed the section').toHaveAttribute(
      'id',
      landed!,
    );
    expect((await page.evaluate(readPage)).slid, 'pressing the arrows moved the page sideways').toBe(0);
  });

  test(`/nft-finance at ${width}px: a tab cut off at either end of the strip, pressed where it shows, comes whole into view`, async ({
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
    expect(count, 'too few tabs to cut one at each end').toBeGreaterThan(3);

    // The tab before the last and the tab after the first: the strip can scroll past each.
    const presses = [
      { side: 'right', tab: tabs.nth(count - 2) },
      { side: 'left', tab: tabs.nth(1) },
    ] as const;
    for (const { side, tab } of presses) {
      const id = await tab.getAttribute('id');
      await list.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
      await tab.evaluate(leaveShowing, { side, shown: LEFT_SHOWING_PX });
      const press = await settledPress(page, tab, width);
      expect(
        await tab.evaluate(cutPx, width),
        `${id} is whole in view at the strip's ${side} end: pressing it proves nothing`,
      ).toBeGreaterThan(TOLERANCE_PX);
      expect(press.shown, `${id} shows ${Math.round(press.shown)}px at the strip's ${side} end`).toBeGreaterThanOrEqual(
        PRESSABLE_PX,
      );
      expect(press.hit, `the part of ${id} that shows cannot be pressed`).toBe(id);
      // A bare mouse press: `locator.click()` would scroll the tab into view itself.
      await page.mouse.click(press.x, press.y);
      await expect(tab, `${id} was pressed and is not the selected tab`).toHaveAttribute('aria-selected', 'true');
      const cut = await settledCut(page, tab, width);
      expect(
        cut,
        `${id} was pressed and is still cut ${Math.round(cut)}px by the strip's edge or an arrow`,
      ).toBeLessThanOrEqual(TOLERANCE_PX);
    }
  });
}
