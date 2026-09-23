/**
 * Every tab label paints inside its own tab, and on phones and iPads the Copy
 * Trading tab reads CT while its accessible name stays "Copy Trading".
 * Measured from rendered boxes: a label wider than its tab paints over the next
 * one, which is what a 430px iPhone showed on the Earn strip.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/wallet';
import { gotoRoute } from './fixtures/routes';

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const IPAD_PORTRAIT = { viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: false };
const IPAD_LANDSCAPE = { viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: false };
const DESKTOP = { viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false };

/** Sub-pixel rounding between a label and its tab is not paint-over. */
const TOLERANCE_PX = 0.5;

// One route per RouteTabs host; the Earn strip has its own cases below.
const OTHER_STRIPS = [
  { path: '/swap', strip: 'Swap destinations' },
  { path: '/liquidity', strip: 'Liquidity sections' },
  { path: '/launch', strip: 'Launch sections' },
  { path: '/trust', strip: 'Token-checking tools' },
  { path: '/tokenomics', strip: 'Treasury and numbers sections' },
  { path: '/leaderboard', strip: 'Activity sections' },
  { path: '/contracts', strip: 'Info sections' },
  { path: '/lore', strip: 'Learn sections' },
];

/**
 * Per tab: the text a sighted user sees, and how far anything visible in the tab
 * (label, pill) paints past the tab's own left or right edge. Visually hidden
 * text (display:none, or a 1px clipped sr-only box) is not seen, so not counted.
 */
function measureTabs(tabs: Element[]) {
  const seen = (from: Element | null, tab: Element) => {
    for (let el = from; el; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      const box = el.getBoundingClientRect();
      if (cs.overflow === 'hidden' && box.width <= 1 && box.height <= 1) return false;
      if (el === tab) break;
    }
    return true;
  };
  return tabs.map((tab) => {
    const edge = tab.getBoundingClientRect();
    let left = edge.left;
    let right = edge.right;
    const include = (r: DOMRect) => {
      if (r.width === 0 && r.height === 0) return;
      left = Math.min(left, r.left);
      right = Math.max(right, r.right);
    };
    for (const el of tab.querySelectorAll('*')) if (seen(el, tab)) include(el.getBoundingClientRect());
    const words: string[] = [];
    const walker = document.createTreeWalker(tab, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent?.trim();
      if (!text || !seen(n.parentElement, tab)) continue;
      words.push(text);
      const range = document.createRange();
      range.selectNodeContents(n);
      include(range.getBoundingClientRect());
    }
    return {
      id: tab.id,
      shown: words.join(' '),
      width: Math.round(edge.width * 100) / 100,
      overflowPx: Math.round(Math.max(edge.left - left, right - edge.right) * 100) / 100,
    };
  });
}

async function measureStrip(page: Page, path: string, strip: string) {
  await gotoRoute(page, path);
  const list = page.getByRole('tablist', { name: strip });
  await expect(list.getByRole('tab').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return { list, tabs: await list.getByRole('tab').evaluateAll(measureTabs) };
}

const overflowing = (tabs: ReturnType<typeof measureTabs>) =>
  tabs.filter((t) => t.overflowPx > TOLERANCE_PX).map((t) => `"${t.shown}" paints ${t.overflowPx}px past its ${t.width}px tab`);

for (const { name, use, reads } of [
  { name: '390px phone', use: PHONE, reads: 'CT' },
  { name: '820px iPad portrait', use: IPAD_PORTRAIT, reads: 'CT' },
  { name: '1180px iPad landscape', use: IPAD_LANDSCAPE, reads: 'CT' },
  { name: '1440px desktop', use: DESKTOP, reads: 'Copy Trading' },
]) {
  test.describe(`Earn strip at ${name}`, () => {
    test.use(use);
    for (const path of ['/copy-trading', '/farm']) {
      test(`${path}: the Copy Trading tab reads ${reads} and no Earn tab paints past its own edge`, async ({
        page,
        walletMock: _w,
      }) => {
        const { list, tabs } = await measureStrip(page, path, 'Earn sections');
        await expect(list.getByRole('tab', { name: 'Copy Trading', exact: true })).toHaveCount(1);
        const copy = tabs.find((t) => t.id === 'earn-tab--copy-trading');
        expect.soft(copy?.shown, 'what a sighted user reads on the Copy Trading tab').toBe(reads);
        expect(overflowing(tabs), 'tab labels painting over their neighbours').toEqual([]);
      });
    }
  });
}

test.describe('every other section strip at 390px phone', () => {
  test.use(PHONE);
  for (const { path, strip } of OTHER_STRIPS) {
    test(`${path}: no ${strip} tab paints past its own edge`, async ({ page, walletMock: _w }) => {
      const { tabs } = await measureStrip(page, path, strip);
      expect(tabs.length, 'no tab strip found: the page changed shape').toBeGreaterThan(1);
      expect(overflowing(tabs), 'tab labels painting over their neighbours').toEqual([]);
    });
  }
});
