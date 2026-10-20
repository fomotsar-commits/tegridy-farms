import { expect, type Page } from '@playwright/test';

/** What a page's width reads, in px. */
export interface PageWidth {
  /** `documentElement.scrollWidth`: how wide the page is. */
  page: number;
  /** `documentElement.clientWidth`: how wide its window is. */
  window: number;
  /** How far the page moved when it was pushed 500px sideways. */
  slid: number;
  /** How many px too wide the page is, by whichever of the two readings is larger. 0 when it fits. */
  over: number;
  /** What reaches furthest past the window's right edge, furthest first. Empty when the page fits. */
  widest: string[];
}

/**
 * Reads a page's width against its window's. The ruler is `documentElement.clientWidth`,
 * never `scrollX` or `innerWidth` alone: Chromium's phone emulation (`mobile-chrome`) widens
 * its window to fit a page that is too wide, so `innerWidth` grows to the page and `scrollX`
 * stays 0. `clientWidth` stays the width the test set, in all four projects.
 * `body` is `overflow-x: hidden` (index.css): a too-wide page still moves, and no reading changes.
 */
export async function readPageWidth(page: Page): Promise<PageWidth> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const y = window.scrollY;
    window.scrollTo(500, y);
    const slid = window.scrollX;
    window.scrollTo(0, y);

    // An element widens the page unless a box around it holds its overflow in: one that
    // scrolls or clips sideways and sits inside the window. A static box holds in nothing
    // that is position:absolute under it, and a fixed box never widens the page.
    const heldIn = (el: Element): boolean => {
      let absolute = false;
      for (let at: Element | null = el; at && at !== document.body; at = at.parentElement) {
        const style = getComputedStyle(at);
        if (style.position === 'fixed') return true;
        if (at !== el) {
          if (absolute && style.position === 'static') continue;
          if (style.overflowX !== 'visible' && at.getBoundingClientRect().right <= root.clientWidth + 1) return true;
        }
        absolute = style.position === 'absolute';
      }
      return false;
    };
    // The outermost boxes only: what is inside one of them is past the edge because it is.
    const past: { el: Element; right: number; what: string }[] = [];
    if (root.scrollWidth > root.clientWidth) {
      for (const el of document.querySelectorAll('body *')) {
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0 || box.right <= root.clientWidth + 1) continue;
        if (past.some((p) => p.el.contains(el)) || heldIn(el)) continue;
        const name = el.id ? `#${el.id}` : typeof el.className === 'string' ? `.${el.className.split(/\s+/).slice(0, 4).join('.')}` : '';
        past.push({ el, right: box.right, what: `<${el.tagName.toLowerCase()}${name}> ${Math.round(box.left)}..${Math.round(box.right)}px` });
      }
    }
    past.sort((a, b) => b.right - a.right);
    const over = Math.max(root.scrollWidth - root.clientWidth, slid);
    return { page: root.scrollWidth, window: root.clientWidth, slid, over, widest: past.slice(0, 3).map((p) => p.what) };
  });
}

/** The page is no wider than its window, and it does not move when pushed sideways. */
export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const width = await readPageWidth(page);
  expect(
    width.over,
    `the page is ${width.page}px wide in a ${width.window}px window, and slid ${width.slid}px sideways. ` +
      `Furthest past the right edge: ${width.widest.join('; ') || 'nothing found'}. A usual cause is a ` +
      'position:absolute child (sr-only) inside a static overflow-x-auto wrapper.',
  ).toBe(0);
}
