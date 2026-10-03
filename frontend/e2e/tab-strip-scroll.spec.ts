/**
 * A section strip too wide for a phone scrolls sideways, and the tab for the page
 * you are on is whole and in view when you land on it. Measured from rendered
 * boxes against the strip's visible (client) box.
 */
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/wallet';
import { gotoRoute } from './fixtures/routes';

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const PHONE_WIDTHS = [360, 375, 390, 430];

/** Sub-pixel rounding between a tab and its strip is not a cut. */
const TOLERANCE_PX = 0.5;

// The later tabs of the three strips that scroll on a phone. Each of these pages
// landed with its selected tab partly or wholly past the strip's right edge.
const LANDINGS = [
  { path: '/eth-curve', strip: 'Launch sections' },
  { path: '/launch-simulator', strip: 'Launch sections' },
  { path: '/copy-trading', strip: 'Earn sections' },
  { path: '/competitions', strip: 'Earn sections' },
  { path: '/checkout', strip: 'Earn sections' },
  { path: '/terminal', strip: 'Token-checking tools' },
  { path: '/chart', strip: 'Token-checking tools' },
  { path: '/alerts', strip: 'Token-checking tools' },
];

/** The strip's scroll state, and where its selected tab sits against the visible box. */
function readStrip(list: Element) {
  const box = list.getBoundingClientRect();
  const visL = box.left + list.clientLeft;
  const tab = list.querySelector('[role="tab"][aria-selected="true"]');
  const sel = tab?.getBoundingClientRect();
  return {
    scrollLeft: list.scrollLeft,
    maxScroll: list.scrollWidth - list.clientWidth,
    visL,
    visR: visL + list.clientWidth,
    selected: tab?.id ?? null,
    selL: sel?.left ?? NaN,
    selR: sel?.right ?? NaN,
  };
}
type Strip = ReturnType<typeof readStrip>;

const round = (n: number) => Math.round(n * 10) / 10;

const frames = (page: Page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** Re-reads the strip for up to ~1s until `check` finds nothing, and returns what it last found. */
async function settle(page: Page, list: Locator, check: (s: Strip) => string[]) {
  let found: string[] = [];
  for (let i = 0; i < 30; i++) {
    found = check(await list.evaluate(readStrip));
    if (!found.length) break;
    await frames(page);
  }
  return found;
}

async function land(page: Page, path: string, strip: string, width: number) {
  await page.setViewportSize({ width, height: PHONE.viewport.height });
  await gotoRoute(page, path);
  const list = page.getByRole('tablist', { name: strip });
  await expect(list.getByRole('tab', { selected: true })).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready);
  await frames(page);
  return list;
}

const selectedCut = (s: Strip) => {
  const cut = Math.max(s.visL - s.selL, s.selR - s.visR);
  return cut > TOLERANCE_PX ? [`${s.selected} is cut ${round(cut)}px by the strip's edge (scrollLeft ${round(s.scrollLeft)})`] : [];
};

test.describe('a phone lands with the selected tab in view', () => {
  test.use(PHONE);
  for (const { path, strip } of LANDINGS) {
    test(`${path}: the selected ${strip} tab is whole inside its strip at 360 to 430`, async ({
      page,
      walletMock: _w,
    }) => {
      const problems: string[] = [];
      for (const width of PHONE_WIDTHS) {
        const list = await land(page, path, strip, width);
        for (const p of await settle(page, list, selectedCut)) problems.push(`${width}px: ${p}`);
      }
      expect(problems, 'selected tabs out of view on landing').toEqual([]);
    });
  }
});
