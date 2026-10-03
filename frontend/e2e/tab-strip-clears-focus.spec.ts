/**
 * Whatever the browser scrolls to on a tabbed page stops below the sticky section tab
 * strip, never behind it (WCAG 2.4.11 Focus Not Obscured). Measured from rendered boxes
 * on a phone-sized screen, for every control in the content of one page per tabbed host.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/wallet';
import { gotoRoute, waitForQuiescence } from './fixtures/routes';
import { playLiveVenue } from './fixtures/playedVenue';

// What Safari leaves a page on an iPhone 14.
const PHONE = { width: 390, height: 664 };

// /tokenomics is a TOWELI room page: its band stands between the top bar and the strip
// until it scrolls away, and the two links in the band are above the strip, not behind it.
const PAGES = ['/solana-lp', '/liquidity', '/trust', '/tokenomics', '/faq'];

/** The page on a phone, settled. /solana-lp is the played live venue, so its finder is up. */
async function settle(page: Page, path: string): Promise<void> {
  await page.setViewportSize(PHONE);
  if (path === '/solana-lp') await playLiveVenue(page, { gateOpen: true });
  await gotoRoute(page, path);
  if (path === '/solana-lp') {
    await expect(page.getByTestId('lp-finder'), 'the LP section did not mount on the played venue').toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="fee-tier"][data-state="live"]'), 'both played fee tiers read').toHaveCount(2);
  }
  await page.evaluate(() => document.fonts.ready);
  await waitForQuiescence(page, { quietMs: 600, timeout: 12_000 });
}

type Landing = { what: string; how: 'focus' | 'scroll'; top: number; strip: [number, number]; behind: boolean; onTop: boolean };

/**
 * Runs in the page. Each control in the content is put where the browser puts it, twice:
 * focus moves to it while it sits under the strip, and a scroll brings it to the top of
 * the screen. `null` when the page has no pinned tab strip.
 */
async function landings(): Promise<Landing[] | null> {
  // Inside the strip's bar, which runs from 68 to 122px once the page has scrolled.
  const UNDER_THE_STRIP = 72;
  const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
  // WebKit can scroll after focus() has returned, so wait until the page holds still.
  const still = async () => {
    for (let i = 0, last = NaN, same = 0; i < 40 && same < 2; i++) {
      await frame();
      same = window.scrollY === last ? same + 1 : 0;
      last = window.scrollY;
    }
  };
  const pinned = (el: Element | null): boolean =>
    !!el && (getComputedStyle(el).position === 'fixed' || pinned(el.parentElement));
  const main = document.querySelector('main#main-content');
  const strip = [...document.querySelectorAll('[role="tablist"]')].find(pinned);
  if (!main || !strip) return null;

  const middleIsOwn = (el: Element) => {
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !!hit && el.contains(hit);
  };
  const read = (el: Element, how: Landing['how']): Landing => {
    const b = el.getBoundingClientRect();
    const s = strip.getBoundingClientRect();
    return {
      what: `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.id || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`,
      how,
      top: Math.round(b.top),
      strip: [Math.round(s.top), Math.round(s.bottom)],
      // Any part of the control inside the strip's own box, half a pixel of rounding aside.
      behind: b.top < s.bottom - 0.5 && b.bottom > s.top + 0.5 && b.left < s.right && b.right > s.left,
      onTop: middleIsOwn(el),
    };
  };

  const controls = [...main.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, summary, [tabindex="0"]')].filter((el) => {
    if (strip.contains(el) || pinned(el) || (el as HTMLButtonElement).disabled || (el as HTMLInputElement).type === 'hidden') return false;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  });

  const out: Landing[] = [];
  for (const el of controls) {
    // In mid-screen first: a control that is not on top of its own middle there is
    // covered by its own page, by design, and says nothing about the strip.
    el.scrollIntoView({ block: 'center' });
    await still();
    if (!middleIsOwn(el)) continue;

    window.scrollBy(0, el.getBoundingClientRect().top - UNDER_THE_STRIP);
    await still();
    // A control too near the top or the foot of the page cannot be put under the strip.
    if (Math.abs(el.getBoundingClientRect().top - UNDER_THE_STRIP) <= 1) {
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
  test(`${path}: a control that is focused or scrolled to lands below the tab strip at ${PHONE.width}x${PHONE.height}`, async ({ page, walletMock: _w }) => {
    test.setTimeout(120_000);
    await settle(page, path);

    const found = await page.evaluate(landings);
    expect(found, 'no pinned tab strip: the page changed shape').not.toBeNull();
    for (const how of ['focus', 'scroll'] as const) {
      expect(found!.filter((l) => l.how === how).length, `controls measured by ${how}`).toBeGreaterThanOrEqual(3);
    }

    const behind = found!
      .filter((l) => l.behind || !l.onTop)
      .map((l) => `${l.what} by ${l.how}: starts ${l.top}px down, the strip is at ${l.strip[0]} to ${l.strip[1]}px${l.onTop ? '' : ', its middle is covered'}`);
    expect(behind, 'controls left behind the tab strip').toEqual([]);
  });
}

/**
 * A section with a scroll margin of its own (a status card, a form, a notice section)
 * still lands just under the strip: the margin is air, the scrollport clears the strip.
 */
const MOST_AIR_PX = 80;
const SCROLL_TARGETS: Record<string, number> = { '/solana-lp': 2, '/liquidity': 1, '/privacy': 1 };

for (const [path, atLeast] of Object.entries(SCROLL_TARGETS)) {
  test(`${path}: a section that is scrolled to lands within ${MOST_AIR_PX}px under the tab strip`, async ({ page, walletMock: _w }) => {
    await settle(page, path);

    const gaps = await page.evaluate(async () => {
      const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const pinned = (el: Element | null): boolean =>
        !!el && (getComputedStyle(el).position === 'fixed' || pinned(el.parentElement));
      const strip = [...document.querySelectorAll('[role="tablist"]')].find(pinned)!;
      const targets = [...document.querySelectorAll('main#main-content *')].filter(
        (el) => parseFloat(getComputedStyle(el).scrollMarginTop) > 0,
      );
      const out: { what: string; gap: number }[] = [];
      for (const el of targets) {
        el.scrollIntoView({ block: 'start' });
        await frames();
        // At the foot of the page the scroll stops early and the gap says nothing.
        if (window.scrollY >= document.documentElement.scrollHeight - window.innerHeight - 1) continue;
        out.push({
          what: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${el.className.toString().split(' ').find((c) => c.startsWith('scroll-mt')) ?? ''}`,
          gap: Math.round(el.getBoundingClientRect().top - strip.getBoundingClientRect().bottom),
        });
      }
      return out;
    });

    expect(gaps.length, 'sections with a scroll margin of their own').toBeGreaterThanOrEqual(atLeast);
    const off = gaps.filter((g) => g.gap < 0 || g.gap > MOST_AIR_PX).map((g) => `${g.what} lands ${g.gap}px under the strip`);
    expect(off, `sections that land behind the strip or more than ${MOST_AIR_PX}px under it`).toEqual([]);
  });
}
