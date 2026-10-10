/**
 * /nft-finance: the section tabs scroll inside their own strip and never move
 * the page, and the selected tab is whole in view, clear of the strip's fade, on
 * landing and after a press. From 768px up the row is about 1,095px wide, wider
 * than an iPad held upright. Measured from rendered boxes against the width the
 * test asked for: a phone browser widens its own window to fit a page that is
 * too wide, so `innerWidth` cannot be the ruler.
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
