import { test, expect, type Page } from '@playwright/test';
import { gotoRoute } from './fixtures/routes';

// A PHONE BROWSER THAT DRAWS THE PAGE UNDER THE STATUS BAR reports a safe-area inset at
// the top and the bottom (seen on a Galaxy S25 inside the Phantom app: about 36px and
// 100px). No phone in the matrix reports one, so chrome that forgets the inset looks
// right in every other spec. This emulates it over CDP: phone Chromium only.
const INSETS = { top: 36, bottom: 100 };
// RouteTabs' own pt-3 sits between its anchor and the tab row; 1px for rounding.
const TAB_ROW_GAP_MAX = 13;

test.use({ viewport: { width: 360, height: 780 } });

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'mobile-chrome', 'safe-area insets are emulated over CDP, on the phone Chromium class');
});

async function openWithInsets(page: Page, path: string) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: INSETS });
  await gotoRoute(page, path);
  // The premise: with no inset reported, every assertion below passes on any code.
  const reported = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;left:0;height:env(safe-area-inset-top,0px);width:env(safe-area-inset-bottom,0px)';
    document.body.appendChild(probe);
    const r = probe.getBoundingClientRect();
    probe.remove();
    return { top: r.height, bottom: r.width };
  });
  expect(reported, 'the browser is not reporting the emulated insets').toEqual(INSETS);
}

/** The header, the room band, the tab row and the bottom bar, read in one moment. */
const readChrome = (page: Page) => page.evaluate(() => {
  const edges = (el: Element | null | undefined) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height };
  };
  const list = document.querySelector('[role="tablist"]');
  const listBox = list?.getBoundingClientRect();
  // A tab whose middle is on screen must be the thing a finger hits there.
  const covered = list && listBox
    ? Array.from(list.querySelectorAll('[role="tab"]')).filter((tab) => {
      const r = tab.getBoundingClientRect();
      const x = r.left + r.width / 2;
      if (x <= listBox.left || x >= listBox.right) return false;
      const hit = document.elementFromPoint(x, r.top + r.height / 2);
      return !hit || !tab.contains(hit);
    }).map((tab) => (tab.textContent ?? '').trim())
    : ['no tab row'];
  const bar = Array.from(document.querySelectorAll('nav[aria-label="Main navigation"]')).find((n) => n.getBoundingClientRect().height > 0);
  return {
    header: edges(document.querySelector('header')),
    band: edges(document.querySelector('[data-room="toweli"]')),
    tabs: edges(list),
    covered,
    bar: edges(bar),
    links: bar ? Array.from(bar.querySelectorAll('a')).map((a) => ({ label: a.getAttribute('aria-label') ?? '', ...edges(a)! })) : [],
  };
});

/** Where the tab row sits against the edge it hangs from, in words a red run can print. */
const placed = (tabsTop: number, anchorBottom: number, anchor: string) => {
  const gap = Math.round((tabsTop - anchorBottom) * 10) / 10;
  return gap >= 0 && gap <= TAB_ROW_GAP_MAX ? 'directly below' : `${gap}px from the lower edge of ${anchor}`;
};

test('with the insets, the tab row sits below the header and every tab can be pressed', async ({ page }) => {
  await openWithInsets(page, '/liquidity');
  await expect(page.getByRole('tablist').first()).toBeVisible();
  await expect.poll(async () => {
    const c = await readChrome(page);
    return c.header && c.tabs ? placed(c.tabs.top, c.header.bottom, 'the header') : 'no header or no tab row';
  }, { message: 'the tab row against the header' }).toBe('directly below');
  const c = await readChrome(page);
  expect(c.header!.bottom, 'the header is not taller by the top inset').toBeGreaterThanOrEqual(56 + INSETS.top);
  expect(c.covered, 'tabs with something else over their middle').toEqual([]);
});

test('with the insets, a TOWELI room page keeps its tab row directly below the band', async ({ page }) => {
  // /zap carries the room's band above the same tab row; the band's height is measured
  // against the header, so the inset must be counted once between the two.
  await openWithInsets(page, '/zap');
  await expect(page.locator('[data-room="toweli"]')).toBeVisible();
  await expect(page.getByRole('tablist').first()).toBeVisible();
  await expect.poll(async () => {
    const c = await readChrome(page);
    return c.band && c.tabs ? placed(c.tabs.top, c.band.bottom, 'the band') : 'no band or no tab row';
  }, { message: 'the tab row against the room band' }).toBe('directly below');
  expect((await readChrome(page)).covered, 'tabs with something else over their middle').toEqual([]);
});

test("with the insets, the bottom bar's icons stay inside the bar and above the inset", async ({ page }) => {
  await openWithInsets(page, '/');
  const c = await readChrome(page);
  expect(c.bar, 'no bottom bar on a phone').not.toBeNull();
  expect(c.links.length, 'the bar lists its sections').toBeGreaterThanOrEqual(4);
  for (const link of c.links) {
    expect.soft(link.top, `${link.label}: starts above the bar, over the page`).toBeGreaterThanOrEqual(c.bar!.top - 0.5);
    expect.soft(link.bottom, `${link.label}: reaches into the bottom inset`).toBeLessThanOrEqual(c.bar!.bottom - INSETS.bottom + 0.5);
    expect.soft(link.height, `${link.label}: press target`).toBeGreaterThanOrEqual(44);
  }
});
