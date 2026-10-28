/**
 * Nothing on a tabbed page lies over its own controls. The section tab strip sits in the
 * page's flow and scrolls away with it, so a visitor's scroll never slides a field, a
 * button or a link under it (it did on 19 pages, 2026-10-14), and whatever the browser
 * scrolls to stops below the top bar with nothing over it (WCAG 2.4.11). Measured from
 * rendered boxes.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/wallet';
import { gotoRoute, waitForQuiescence } from './fixtures/routes';
import { playLiveVenue } from './fixtures/playedVenue';

// What Safari leaves a page on an iPhone 14.
const PHONE = { width: 390, height: 664 };

// /tokenomics is a TOWELI room page: its band stands between the top bar and the strip.
const PAGES = ['/pools', '/liquidity', '/trust', '/tokenomics', '/faq'];

/** The page settled at `size`. /pools is the played live venue, so its finder is up. */
async function settle(page: Page, path: string, size = PHONE): Promise<void> {
  await page.setViewportSize(size);
  if (path === '/pools') await playLiveVenue(page, { gateOpen: true });
  await gotoRoute(page, path);
  if (path === '/pools') {
    await expect(page.getByTestId('lp-finder'), 'the LP section did not mount on the played venue').toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="fee-tier"][data-state="live"]'), 'both played fee tiers read').toHaveCount(2);
  }
  await page.evaluate(() => document.fonts.ready);
  await waitForQuiescence(page, { quietMs: 600, timeout: 12_000 });
}

// One page per tabbed host, the TOWELI room's band included, on a phone and a laptop.
const SCROLLED_PAGES = ['/liquidity', '/zap', '/premium', '/launch', '/nft-finance', '/scan', '/faq'];
const SCREENS = [{ width: 390, height: 844 }, { width: 1280, height: 800 }];
// Since the eight-link footer (#838), /scan fits a 1280x800 screen with 44px to scroll,
// too little to measure; a shorter laptop window gives it room to scroll under the strip.
const SHORTER: Record<string, { width: number; height: number }> = { '/scan': { width: 1280, height: 600 } };

for (const screen of SCREENS) {
  for (const path of SCROLLED_PAGES) {
    const size = screen.width === 1280 && SHORTER[path] ? SHORTER[path] : screen;
    test(`${path} at ${size.width}x${size.height}: as the page scrolls, the tab strip covers no field, button or link`, async ({ page, walletMock: _w }) => {
      test.setTimeout(120_000);
      await settle(page, path, size);
      const scan = await page.evaluate(async () => {
        const frames = async (n: number) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(() => r(null))); };
        const main = document.querySelector('main#main-content')!;
        const list = main.querySelector('[role="tablist"]');
        if (!list) return null;
        // The strip's own box: the tab row and the gap above it.
        const strip = list.parentElement!;
        const top = document.querySelector('header')!.getBoundingClientRect().bottom;
        // At the top of the page every tab is the thing a press on its middle reaches.
        window.scrollTo(0, 0);
        await frames(3);
        const hiddenTabs = [...list.querySelectorAll('[role="tab"]')].filter((tab) => {
          const b = tab.getBoundingClientRect();
          const x = b.left + b.width / 2;
          if (x <= 0 || x >= innerWidth) return false;
          const hit = document.elementFromPoint(x, b.top + b.height / 2);
          return !hit || !tab.contains(hit);
        }).map((tab) => `"${(tab.textContent ?? '').trim()}" at ${Math.round(tab.getBoundingClientRect().top)}px`);
        const covered = new Map<string, number>();
        let looked = 0;
        const max = document.documentElement.scrollHeight - innerHeight;
        for (let y = 0; y <= max; y += 60) {
          window.scrollTo(0, y);
          await frames(3);
          for (const el of main.querySelectorAll<HTMLElement>('input:not([type="hidden"]), select, textarea, button, a[href], [role="button"]')) {
            if (strip.contains(el)) continue;
            const b = el.getBoundingClientRect();
            if (b.width === 0 || b.height === 0) continue;
            const x = b.left + b.width / 2, mid = b.top + b.height / 2;
            if (mid <= top || mid >= innerHeight || x <= 0 || x >= innerWidth) continue;
            looked += 1;
            const hit = document.elementFromPoint(x, mid);
            if (hit && strip.contains(hit)) {
              const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
              if (!covered.has(name)) covered.set(name, y);
            }
          }
        }
        window.scrollTo(0, 0);
        return { hiddenTabs, looked, scrolled: max, covered: [...covered].map(([name, y]) => `"${name}" at ${y}px scrolled`) };
      });
      expect(scan, 'no section tab strip: the page changed shape').not.toBeNull();
      expect(scan!.hiddenTabs, 'tabs something else covers at the top of the page').toEqual([]);
      expect(scan!.scrolled, 'the page does not scroll: nothing to measure').toBeGreaterThan(200);
      expect(scan!.looked, 'controls seen on screen').toBeGreaterThan(5);
      expect(scan!.covered, 'controls with the tab strip over their middle').toEqual([]);
    });
  }
}

type Landing = { what: string; how: 'focus' | 'scroll'; top: number; bar: number; behind: boolean; onTop: boolean };

/**
 * Runs in the page. Each control in the content is put where the browser puts it, twice:
 * focus moves to it while it sits under the top bar, and a scroll brings it to the top of
 * the screen. `null` when the page has no section tab strip.
 */
async function landings(): Promise<Landing[] | null> {
  // Inside the 56px top bar.
  const UNDER_THE_BAR = 20;
  const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
  // WebKit can scroll after focus() has returned, so wait until the page holds still.
  const still = async () => {
    for (let i = 0, last = NaN, same = 0; i < 40 && same < 2; i++) {
      await frame();
      same = window.scrollY === last ? same + 1 : 0;
      last = window.scrollY;
    }
  };
  const main = document.querySelector('main#main-content');
  const strip = main?.querySelector('[role="tablist"]');
  const header = document.querySelector('header');
  if (!main || !strip || !header) return null;

  const middleIsOwn = (el: Element) => {
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !!hit && el.contains(hit);
  };
  const read = (el: Element, how: Landing['how']): Landing => {
    const b = el.getBoundingClientRect();
    const bar = header.getBoundingClientRect().bottom;
    return {
      what: `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.id || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`,
      how,
      top: Math.round(b.top),
      bar: Math.round(bar),
      // Any part of the control under the bar, half a pixel of rounding aside.
      behind: b.top < bar - 0.5,
      onTop: middleIsOwn(el),
    };
  };

  const controls = [...main.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, summary, [tabindex="0"]')].filter((el) => {
    if (strip.contains(el) || (el as HTMLButtonElement).disabled || (el as HTMLInputElement).type === 'hidden') return false;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  });

  const out: Landing[] = [];
  for (const el of controls) {
    // In mid-screen first: a control that is not on top of its own middle there is
    // covered by its own page, by design, and says nothing about the chrome.
    el.scrollIntoView({ block: 'center' });
    await still();
    if (!middleIsOwn(el)) continue;

    window.scrollBy(0, el.getBoundingClientRect().top - UNDER_THE_BAR);
    await still();
    // A control too near the top or the foot of the page cannot be put under the bar.
    if (Math.abs(el.getBoundingClientRect().top - UNDER_THE_BAR) <= 1) {
      el.focus();
      await still();
      if (document.activeElement === el) out.push(read(el, 'focus'));
      el.blur();
    }

    el.scrollIntoView({ block: 'start' });
    await still();
    out.push(read(el, 'scroll'));
  }
  return out;
}

for (const path of PAGES) {
  test(`${path}: a control that is focused or scrolled to lands below the top bar with nothing over it at ${PHONE.width}x${PHONE.height}`, async ({ page, walletMock: _w }) => {
    test.setTimeout(120_000);
    await settle(page, path);

    const found = await page.evaluate(landings);
    expect(found, 'no section tab strip: the page changed shape').not.toBeNull();
    for (const how of ['focus', 'scroll'] as const) {
      expect(found!.filter((l) => l.how === how).length, `controls measured by ${how}`).toBeGreaterThanOrEqual(3);
    }

    const behind = found!
      .filter((l) => l.behind || !l.onTop)
      .map((l) => `${l.what} by ${l.how}: starts ${l.top}px down, the bar ends at ${l.bar}px${l.onTop ? '' : ', its middle is covered'}`);
    expect(behind, 'controls left under the top bar or the tab strip').toEqual([]);
  });
}

/**
 * A section with a scroll margin of its own (a status card, a form, a notice section)
 * still lands just under the top bar: the margin is air, the scrollport clears the bar.
 */
const MOST_AIR_PX = 80;
// /pools: the status card. The LP section's own scroll targets carry no margin
// (src/components/solana/lp/scrollTargets.test.ts), so they land 18px under the bar.
const SCROLL_TARGETS: Record<string, number> = { '/pools': 1, '/liquidity': 1, '/privacy': 1 };

for (const [path, atLeast] of Object.entries(SCROLL_TARGETS)) {
  test(`${path}: a section that is scrolled to lands within ${MOST_AIR_PX}px under the top bar`, async ({ page, walletMock: _w }) => {
    await settle(page, path);

    const gaps = await page.evaluate(async () => {
      const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const header = document.querySelector('header')!;
      const targets = [...document.querySelectorAll('main#main-content *')].filter(
        (el) => parseFloat(getComputedStyle(el).scrollMarginTop) > 0,
      );
      const out: { what: string; gap: number; covered: boolean }[] = [];
      for (const el of targets) {
        el.scrollIntoView({ block: 'start' });
        await frames();
        // At the foot of the page the scroll stops early and the gap says nothing.
        if (window.scrollY >= document.documentElement.scrollHeight - window.innerHeight - 1) continue;
        const b = el.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + Math.min(b.width / 2, 40), b.top + 2);
        out.push({
          what: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${el.className.toString().split(' ').find((c) => c.startsWith('scroll-mt')) ?? ''}`,
          gap: Math.round(b.top - header.getBoundingClientRect().bottom),
          covered: !!hit && !el.contains(hit) && !!hit.closest('[role="tablist"], header'),
        });
      }
      return out;
    });

    expect(gaps.length, 'sections with a scroll margin of their own').toBeGreaterThanOrEqual(atLeast);
    const off = gaps
      .filter((g) => g.gap < 0 || g.gap > MOST_AIR_PX || g.covered)
      .map((g) => `${g.what} lands ${g.gap}px under the top bar${g.covered ? ', under the tab strip' : ''}`);
    expect(off, `sections that land under the bar or the strip, or more than ${MOST_AIR_PX}px under the bar`).toEqual([]);
  });
}
