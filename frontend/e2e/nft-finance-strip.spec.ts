/**
 * /nft-finance: the section tabs scroll inside their own strip and never move
 * the page, and the selected tab is whole in view, clear of the strip's fade, on
 * landing and after a press. With a mouse, an arrow over each end that has tabs
 * past it moves the row; on a touch screen the row is swiped and has none. From
 * 768px up the row is about 1,095px wide, wider than an iPad held upright.
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

/** A narrow desktop window, and the one the owner's brief names: the arrows' widths. */
const ARROW_WIDTHS = [390, 900];

/** The least an arrow measures each way: a 44px press target. */
const ARROW_MIN_PX = 44;

/** How much of a tab is left showing at an end of the strip before it is pressed: more than an arrow covers. */
const LEFT_SHOWING_PX = 80;

type Side = 'left' | 'right';
const arrowAt = (page: Page, side: Side) => page.locator(`[data-strip-arrow="${side === 'left' ? 'prev' : 'next'}"]`);

/** A mouse: the arrows are for it. A finger swipes the row and gets none. */
const hasMouse = (page: Page) => page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches);

/** How many of the last sections the slower checks land on: the ones a strip must scroll to show. */
const FAR_SECTIONS = 3;

/**
 * The page settles in at 0.994 scale, and a strip that measured itself then
 * stayed short. Held at 0.9 a miss is 13px or more, past any rounding.
 */
const HELD_SCALE = 0.9;

/** Two forced tab fonts, one narrower and one wider than the site's own on any machine. */
const TAB_FONTS = {
  narrower: 'font-family: Arial, Helvetica, sans-serif !important; letter-spacing: -0.04em !important;',
  wider: 'font-family: "Courier New", Courier, monospace !important; letter-spacing: 0.04em !important;',
} as const;
type TabFont = keyof typeof TAB_FONTS;

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

/** How many px of a tab lie outside what a visitor can see of its strip, in a window `width` wide. An arrow hides what is under it. */
function cutPx(tab: Element, width: number) {
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
  return Math.max(seenL - box.left, box.right - seenR, 0);
}

/** Scrolls the strip, and only the strip, until `shown` px of a tab are left inside its `side` end. */
function leaveShowing(tab: Element, { side, shown }: { side: 'left' | 'right'; shown: number }) {
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

/** Where to press an arrow, and everything that keeps a visitor from seeing it, pressing it, or keeping the keyboard where it was. */
function readArrow(arrow: Element, { width, min }: { width: number; min: number }) {
  const box = arrow.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const problems: string[] = [];
  if (box.width < min || box.height < min) problems.push(`it is ${Math.round(box.width)}x${Math.round(box.height)}px`);
  if (box.left < 0 || box.right > width) problems.push(`it spans ${Math.round(box.left)}px to ${Math.round(box.right)}px of a ${width}px window`);
  const strip = arrow.parentElement?.querySelector('[role="tablist"]')?.getBoundingClientRect();
  if (!strip || box.left < strip.left || box.right > strip.right || box.top < strip.top || box.bottom > strip.bottom) problems.push('it is not inside the strip');
  const icon = arrow.querySelector('svg')?.getBoundingClientRect();
  if (!icon || icon.width < 12 || icon.height < 12) problems.push('it draws no icon');
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
  // For a mouse only: the keyboard walks the tabs, and a screen reader has the tablist.
  if ((arrow as HTMLElement).tabIndex >= 0) problems.push('it is a tab stop');
  if (arrow.getAttribute('aria-hidden') !== 'true') problems.push('a screen reader is given it beside the tabs');
  return { x, y, problems };
}

/**
 * How wide the fade at the right edge of a tab's strip is, and how many px of the
 * tab lie under it (0 or less: the tab is wholly in the part that does not fade).
 * Both are read off the page: the fade from the mask the browser applied, which
 * spans the strip's border box, the tab and the strip from their rendered boxes.
 * No number here depends on how wide a font draws the tabs.
 */
function readFade(tab: Element) {
  const list = tab.closest('[role="tablist"]')!;
  const cs = getComputedStyle(list);
  const mask = cs.maskImage || cs.webkitMaskImage || 'none';
  const stop = /calc\(100% - ([\d.]+)px\)/.exec(mask);
  const fade = stop ? Number(stop[1]) : NaN;
  const under = tab.getBoundingClientRect().right - (list.getBoundingClientRect().right - fade);
  return { mask, fade, under };
}

/** How the page is drawn against how it is laid out: 1 unless something scales it. */
function drawnScale(list: Element) {
  return list.getBoundingClientRect().width / (list as HTMLElement).offsetWidth;
}

/** From before the page mounts, draws its content at `scale`, as an entrance still in flight does. */
function holdPageScale(scale: number) {
  const add = () => {
    if (!document.head || document.getElementById('held-page-scale')) return !!document.head;
    const style = document.createElement('style');
    style.id = 'held-page-scale';
    style.textContent = `main#main-content { transform: scale(${scale}); }`;
    document.head.appendChild(style);
    return true;
  };
  if (add()) return;
  const waiting = new MutationObserver(() => add() && waiting.disconnect());
  waiting.observe(document, { childList: true, subtree: true });
}

/** From before the page mounts, draws the section tabs with the declarations in `css`. */
function forceTabFont(css: string) {
  const rule = (decl: string) =>
    `[role="tablist"][aria-label="NFT Finance sections"] [role="tab"], [role="tablist"][aria-label="NFT Finance sections"] [role="tab"] * { ${decl} }`;
  (window as unknown as { __setTabFont: (decl: string) => void }).__setTabFont = (decl) => {
    document.getElementById('forced-tab-font')!.textContent = rule(decl);
  };
  const add = () => {
    if (!document.head || document.getElementById('forced-tab-font')) return !!document.head;
    const style = document.createElement('style');
    style.id = 'forced-tab-font';
    style.textContent = rule(css);
    document.head.appendChild(style);
    return true;
  };
  if (add()) return;
  const waiting = new MutationObserver(() => add() && waiting.disconnect());
  waiting.observe(document, { childList: true, subtree: true });
}

/** The tab furthest toward `side` with enough showing, clear of the arrows, to press: where to press it, and what is there. */
function furthestShown(
  list: Element,
  { width, side, pressable }: { width: number; side: 'left' | 'right'; pressable: number },
) {
  const edge = list.getBoundingClientRect();
  let seenL = Math.max(edge.left + list.clientLeft, 0);
  let seenR = Math.min(edge.left + list.clientLeft + list.clientWidth, width);
  for (const arrow of list.parentElement!.querySelectorAll('[data-strip-arrow]')) {
    const over = arrow.getBoundingClientRect();
    if (arrow.getAttribute('data-strip-arrow') === 'prev') seenL = Math.max(seenL, over.right);
    else seenR = Math.min(seenR, over.left);
  }
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

/** Gives the arrows a few frames to catch up with the strip, then where the part of `tab` that shows can be pressed. */
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

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * What is wrong with where the selected tab sits, in words. Nothing when it is
 * whole inside its strip, wholly in the part that does not fade, and the page
 * has not been moved to show it.
 */
async function selectedTabProblems(page: Page, tab: Locator, width: number) {
  const problems: string[] = [];
  const cut = await settledCut(page, tab, width);
  if (cut > TOLERANCE_PX) problems.push(`its tab is cut ${Math.round(cut)}px by the strip's edge`);
  const { mask, fade, under } = await tab.evaluate(readFade);
  // The last tab too: at the end of the strip the fade must not sit on it.
  if (!(fade > 0)) problems.push(`the width of the strip's fade could not be read from its mask (${mask})`);
  else if (under > TOLERANCE_PX) problems.push(`its tab runs ${round1(under)}px under the strip's ${fade}px fade`);
  // Only the strip scrolls to show it: the page stays where it landed.
  const at = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  if (at.x || at.y) problems.push(`showing its tab moved the page to ${at.x},${at.y}`);
  return problems;
}

/** Opens `?section=` for a tab id and returns the tab once it is the selected one and fonts are in. */
async function landOn(page: Page, list: Locator, id: string) {
  const section = id.replace('nft-finance-tab-', '');
  await gotoRoute(page, `/nft-finance?section=${section}`);
  const tab = list.getByRole('tab', { selected: true });
  await expect(tab, `?section=${section} did not select its tab`).toHaveAttribute('id', id);
  await page.evaluate(() => document.fonts.ready);
  return { section, tab };
}

/** The tab ids of the strip, read from a first visit. */
async function sectionTabIds(page: Page, list: Locator) {
  await gotoRoute(page, '/nft-finance');
  await expect(list.getByRole('tab').first()).toBeVisible();
  const ids = await list.getByRole('tab').evaluateAll((els) => els.map((el) => el.id));
  expect(ids.length, 'no tab strip found: the page changed shape').toBeGreaterThan(FAR_SECTIONS);
  return ids;
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
    // With a mouse an arrow shows over each end that has tabs past it, and only there; a finger swipes and gets none.
    const mouse = await hasMouse(page);
    expect(strip.more.right, 'the strip landed with no tabs past its right end').toBe(scrolls);
    for (const side of ['left', 'right'] as const) {
      const shows = mouse && strip.more[side];
      await expect(
        arrowAt(page, side),
        shows ? `tabs are out of view past the strip's ${side} end and no arrow shows there` : `an arrow shows over the strip's ${side} end`,
      ).toHaveCount(shows ? 1 : 0);
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
      // The strip looks at its new selection once more on the next frame. Scrolling
      // it by hand sooner than a person could loses to that look: 1 run in 8 on Safari.
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
    const list = page.getByRole('tablist', { name: 'NFT Finance sections' });
    const ids = await sectionTabIds(page, list);

    const problems: string[] = [];
    for (const id of ids) {
      const { section, tab } = await landOn(page, list, id);
      for (const p of await selectedTabProblems(page, tab, width)) problems.push(`?section=${section}: ${p}`);
    }
    expect(problems, 'selected tabs out of view on landing').toEqual([]);
  });

  // A page that is still settling in is drawn smaller than it is laid out. The strip
  // must land right then too: nothing tells it when the settling ends.
  test(`/nft-finance at ${width}px: a section link lands with its tab clear of the fade while the page is still drawn smaller`, async ({
    page,
    walletMock: _w,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const list = page.getByRole('tablist', { name: 'NFT Finance sections' });
    const ids = await sectionTabIds(page, list);
    await page.addInitScript(holdPageScale, HELD_SCALE);

    const problems: string[] = [];
    for (const id of ids.slice(-FAR_SECTIONS)) {
      const { section, tab } = await landOn(page, list, id);
      await expect
        .poll(
          () => list.evaluate(drawnScale),
          `?section=${section}: the page was not drawn smaller while its strip landed, so this proves nothing`,
        )
        .toBeCloseTo(HELD_SCALE, 2);
      // The settling ends. Nothing resizes, so nothing asks the strip to look again.
      await page.evaluate(() => document.getElementById('held-page-scale')!.remove());
      await expect.poll(() => list.evaluate(drawnScale), 'the page did not come back to full size').toBeCloseTo(1, 2);
      for (const p of await selectedTabProblems(page, tab, width)) problems.push(`?section=${section}: ${p}`);
    }
    expect(problems, 'selected tabs out of place once the page settled').toEqual([]);
  });

  // The tabs are as wide as the font that draws them, and that differs by machine.
  // Each forced font is landed on, then swapped under the strip for the other.
  for (const [first, later] of [
    ['narrower', 'wider'],
    ['wider', 'narrower'],
  ] as [TabFont, TabFont][]) {
    test(`/nft-finance at ${width}px: its tab is clear of the fade in a ${first} font, and still is when the font turns ${later}`, async ({
      page,
      walletMock: _w,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const list = page.getByRole('tablist', { name: 'NFT Finance sections' });
      const ids = await sectionTabIds(page, list);
      const ownWidth = await list.evaluate((el) => el.scrollWidth);
      await page.addInitScript(forceTabFont, TAB_FONTS[first]);

      const problems: string[] = [];
      for (const id of ids.slice(-FAR_SECTIONS)) {
        const { section, tab } = await landOn(page, list, id);
        for (const p of await selectedTabProblems(page, tab, width)) problems.push(`?section=${section}, ${first} font: ${p}`);
        const landed = await list.evaluate((el) => el.scrollWidth);

        // A late web font does this: every tab changes width under a strip that has already landed.
        await page.evaluate((css) => (window as unknown as { __setTabFont: (decl: string) => void }).__setTabFont(css), TAB_FONTS[later]);
        await frames(page);
        for (const p of await selectedTabProblems(page, tab, width)) problems.push(`?section=${section}, turned ${later}: ${p}`);
        const turned = await list.evaluate((el) => el.scrollWidth);

        // The forced fonts must really redraw the row, or neither check above tried anything.
        const [narrow, wide] = first === 'narrower' ? [landed, turned] : [turned, landed];
        expect(narrow, `?section=${section}: the narrower font did not narrow the row (${narrow}px, ${ownWidth}px in the site's font)`).toBeLessThan(ownWidth - 20);
        expect(wide, `?section=${section}: the wider font did not widen the row (${wide}px, ${ownWidth}px in the site's font)`).toBeGreaterThan(ownWidth + 20);
      }
      expect(problems, 'selected tabs out of place under another font').toEqual([]);
    });
  }

  // Without arrows (a touch screen, which also swipes), pressing the furthest tab that shows walks the strip.
  // With a mouse the arrows are the way along, and a tab next to one may already be as far as a press reveals.
  test(`/nft-finance at ${width}px: pressing the furthest tab that shows walks the strip to its last tab and back`, async ({
    page,
    walletMock: _w,
  }) => {
    test.skip(await hasMouse(page), 'with a mouse the arrows walk the strip: the arrow tests below');
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

for (const width of ARROW_WIDTHS) {
  // The scrollbar is hidden: with a mouse, the arrows are the way along the strip.
  test(`/nft-finance at ${width}px with a mouse: an arrow over each end with tabs past it walks the strip to its last tab and back, and moves nothing else`, async ({
    page,
    walletMock: _w,
  }) => {
    test.skip(!(await hasMouse(page)), 'a touch screen swipes the row: it has no arrows');
    await page.setViewportSize({ width, height: 900 });
    await gotoRoute(page, '/nft-finance');
    const list = page.getByRole('tablist', { name: 'NFT Finance sections' });
    const tabs = list.getByRole('tab');
    await expect(tabs.first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const count = await tabs.count();
    const landed = await list.getByRole('tab', { selected: true }).getAttribute('id');
    // The keyboard sits on the selected tab: an arrow press must leave it there.
    await list.getByRole('tab', { selected: true }).focus();

    const walks = [
      { side: 'right', end: tabs.last(), name: 'last' },
      { side: 'left', end: tabs.first(), name: 'first' },
    ] as const;
    for (const { side, end, name } of walks) {
      expect(await end.evaluate(cutPx, width), `the ${name} tab is already in view: there is nothing to walk to`).toBeGreaterThan(TOLERANCE_PX);
      for (let presses = 0; presses < count && (await end.evaluate(cutPx, width)) > TOLERANCE_PX; presses++) {
        await list.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
        const arrow = arrowAt(page, side);
        await expect(arrow, `the ${name} tab is out of view and no arrow shows over the strip's ${side} end`).toHaveCount(1);
        // The strip fades in on landing: the arrow is read once that is over.
        let seen = await arrow.evaluate(readArrow, { width, min: ARROW_MIN_PX });
        await expect
          .poll(async () => (seen = await arrow.evaluate(readArrow, { width, min: ARROW_MIN_PX })).problems, `the arrow over the strip's ${side} end cannot be seen or pressed`)
          .toEqual([]);
        const from = await list.evaluate((el) => el.scrollLeft);
        // A bare mouse press: `locator.click()` would scroll and wait by itself.
        await page.mouse.click(seen.x, seen.y);
        await expect.poll(() => list.evaluate((el) => el.scrollLeft), `the ${side} arrow was pressed and the strip did not move`).not.toBe(from);
        const to = await settledScroll(page, list);
        expect(side === 'right' ? to - from : from - to, `the ${side} arrow was pressed and the strip went from ${from}px to ${to}px`).toBeGreaterThan(TOLERANCE_PX);
      }
      const cut = await settledCut(page, end, width);
      expect(cut, `pressing the ${side} arrow did not bring the ${name} tab into view: it is cut ${Math.round(cut)}px`).toBeLessThanOrEqual(TOLERANCE_PX);
      await expect(arrowAt(page, side), `the ${name} tab is in view and the ${side} arrow still shows`).toHaveCount(0);
    }

    // The arrows move the strip and nothing else: not the section, not the keyboard, not the page.
    await expect(list.getByRole('tab', { selected: true }), 'pressing the arrows changed the section').toHaveAttribute('id', landed!);
    expect(await page.evaluate(() => document.activeElement?.id), 'pressing an arrow took the keyboard off the selected tab').toBe(landed);
    expect((await page.evaluate(readPage)).slid, 'pressing the arrows moved the page sideways').toBe(0);
  });

  test(`/nft-finance at ${width}px: a tab cut off at either end of the strip, pressed where it shows, comes whole into view clear of any arrow`, async ({
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

    // The tab before the last and the tab after the first, where the strip can scroll past each;
    // else the end tab itself (at 900px, with no Soon chip on any tab, the strip overflows by less
    // than a tab). Each is left showing at its end before it is pressed.
    const presses = [
      { side: 'right', candidates: [tabs.nth(count - 2), tabs.nth(count - 1)] },
      { side: 'left', candidates: [tabs.nth(1), tabs.nth(0)] },
    ] as const;
    for (const { side, candidates } of presses) {
      let tab = candidates[1];
      for (const candidate of candidates) {
        await list.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
        await candidate.evaluate(leaveShowing, { side, shown: LEFT_SHOWING_PX });
        if ((await candidate.evaluate(cutPx, width)) > TOLERANCE_PX) {
          tab = candidate;
          break;
        }
      }
      const id = await tab.getAttribute('id');
      await list.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
      await tab.evaluate(leaveShowing, { side, shown: LEFT_SHOWING_PX });
      const press = await settledPress(page, tab, width);
      expect(await tab.evaluate(cutPx, width), `${id} is whole in view at the strip's ${side} end: pressing it proves nothing`).toBeGreaterThan(TOLERANCE_PX);
      expect(press.shown, `${id} shows ${Math.round(press.shown)}px at the strip's ${side} end`).toBeGreaterThanOrEqual(PRESSABLE_PX);
      expect(press.hit, `the part of ${id} that shows cannot be pressed`).toBe(id);
      // A bare mouse press: `locator.click()` would scroll the tab into view itself.
      await page.mouse.click(press.x, press.y);
      await expect(tab, `${id} was pressed and is not the selected tab`).toHaveAttribute('aria-selected', 'true');
      const cut = await settledCut(page, tab, width);
      expect(cut, `${id} was pressed and is still cut ${Math.round(cut)}px by the strip's edge or an arrow`).toBeLessThanOrEqual(TOLERANCE_PX);
    }
  });
}
