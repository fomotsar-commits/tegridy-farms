/**
 * HEADER REACHABILITY — the invariant that the 640-790px dead band violated.
 *
 * WHAT WENT WRONG (2026-09-03, found by a field review, mechanism found by
 * measurement). The TopNav row needs ~790px of content: left group 264 + primary
 * nav 427 + wallet cluster 102, plus padding. R038 had switched the desktop nav
 * on at `sm:` (640px), which is also where `sm:hidden` switched OFF both the
 * hamburger and the BottomNav. So from 640px to 790px the row overflowed to
 * 809px, the Connect button sat at x=707..809 — off the right edge — and there
 * was no hamburger and no bottom bar to fall back to.
 *
 * The part that made it unrecoverable rather than merely ugly: <header> is
 * `position: fixed`, so its overflow never extends the document.
 * `documentElement.scrollWidth === viewport` at every width in the band, which
 * means the user could not scroll to the button either. For a 150px-wide band of
 * viewports — small laptops, half-screen windows, landscape tablets — the app
 * had no reachable way to connect a wallet.
 *
 * WHY NOTHING CAUGHT IT: playwright.config.ts's projects are 1280 / 393 / 393 /
 * 810. iPad gen 7 at 810px sits 20px above the failure threshold, so the entire
 * 640-790 band had zero coverage. That gap is the reason this file exists.
 *
 * WHAT THIS PINS, and what it deliberately does NOT pin. It asserts the
 * INVARIANT — the header row does not overflow, and the wallet control is inside
 * the viewport — swept across widths that straddle every breakpoint the header
 * uses. It does NOT assert the literal `min-[800px]`, because the breakpoint is
 * an implementation detail that should be free to move; what must never move is
 * "you can always reach Connect". If someone adds a nav item and the row needs
 * 850px, this fails at 800 and 810 and tells them the budget is blown — which a
 * test pinned to the class name could not do.
 *
 * MUTATION CHECK — run this before trusting the file; a test that has never
 * failed on the pre-fix code has proven nothing. Revert any ONE of the seven
 * coupled sites to `sm:` — TopNav's nav / hamburger / drawer overlay / drawer,
 * BottomNav.tsx, AppLayout.tsx's content pb, or index.css's two max-width:799px
 * blocks — and both tests below must go red.
 *
 * MEASURED 2026-09-03 with TopNav's <nav> reverted to `sm:flex`, everything else
 * left fixed:
 *
 *    640 | reachable=false right=809 | topNav=true bottomNav=true
 *    694 | reachable=false right=809 | topNav=true bottomNav=true
 *    789 | reachable=false right=790 | topNav=true bottomNav=true
 *    790 | reachable=false right=790 | topNav=true bottomNav=true
 *    375 / 639 / 810 / 1024 all still pass
 *
 * Note both tests fire on that single mutation, and they fail for different
 * reasons: the first because Connect leaves the viewport, the second because
 * TopNav and BottomNav are momentarily both visible. That is the signature of
 * these seven sites having drifted apart, which is the actual failure mode —
 * the band opened when one of them moved without the others.
 */

import { test, expect } from './fixtures/wallet';

/**
 * Straddles every boundary the header cares about: below `sm`, the old broken
 * band (640-790), the new boundary (799/800), the iPad-gen-7 project width that
 * constrains how high the breakpoint may go (810), and true desktop.
 */
const WIDTHS = [375, 414, 639, 640, 694, 767, 768, 799, 800, 810, 1024, 1440];

test.describe('header stays reachable at every width', () => {
  // Own-viewport sweep: the device projects pin their own viewport and DPR, so
  // running this there would re-test one width four times and tell us nothing.
  test.skip(({}, testInfo) => testInfo.project.name !== 'chromium',
    'viewport sweep — chromium project only');

  test('the wallet control is inside the viewport and the header never overflows', async ({ page, walletMock: _w }) => {
    const failures: string[] = [];

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      // The connect control mounts asynchronously (RainbowKit's `mounted`), so
      // wait for it rather than sampling a pre-mount frame — reading too early
      // is precisely how the original review mis-diagnosed this as the button
      // being absent from the accessibility tree.
      const connect = page.locator('header').getByRole('button', { name: /connect/i }).first();
      await expect(connect).toBeVisible();

      const box = await connect.boundingBox();
      if (!box) {
        failures.push(`${width}px: Connect has no layout box`);
        continue;
      }
      if (box.x < 0 || box.x + box.width > width) {
        failures.push(
          `${width}px: Connect is off-canvas at x=${Math.round(box.x)}..${Math.round(box.x + box.width)} ` +
          `(viewport is 0..${width}) — and the header is position:fixed, so it cannot be scrolled to`,
        );
      }

      const row = await page.locator('header').evaluate((el) => {
        const r = el.querySelector('div.flex.items-center.justify-between') ?? el.firstElementChild;
        return r ? { scroll: r.scrollWidth, client: r.clientWidth } : null;
      });
      if (row && row.scroll > row.client) {
        failures.push(`${width}px: header row overflows — scrollWidth ${row.scroll} > clientWidth ${row.client}`);
      }
    }

    expect(failures, `header reachability failures:\n  ${failures.join('\n  ')}`).toEqual([]);
  });

  test('exactly one primary navigation is rendered at every width', async ({ page, walletMock: _w }) => {
    // The dead band existed because TopNav's nav and BottomNav were driven by
    // the SAME breakpoint from opposite directions, and drifting them apart left
    // widths with neither. Both-at-once is a lesser bug but the same root cause,
    // so pin the count at exactly one rather than at least one.
    const failures: string[] = [];

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      await expect(page.locator('header').getByRole('button', { name: /connect/i }).first()).toBeVisible();

      const visible = await page.locator('nav[aria-label="Main navigation"]').evaluateAll((els) =>
        els.filter((el) => {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') return false;
          const b = el.getBoundingClientRect();
          return b.width > 0 && b.height > 0;
        }).length,
      );

      if (visible !== 1) {
        failures.push(
          `${width}px: ${visible} primary navs visible (expected exactly 1) — ` +
          `${visible === 0 ? 'no way to navigate' : 'TopNav and BottomNav are both showing'}`,
        );
      }
    }

    expect(failures, `navigation availability failures:\n  ${failures.join('\n  ')}`).toEqual([]);
  });
});
