/**
 * A11Y-R07 — the section tab strips are actually 44px on a phone.
 *
 * /community and /nft-finance both shipped `px-3 py-2 text-xs` with no `min-h`
 * — about 32px of tap target for the primary way to move between the sections
 * of each page — while the structurally identical tablist on /swap already
 * carried the repo's 44px floor.
 *
 * Measured, not asserted from a class name: target size is a rendered box, and
 * `min-h-[44px]` only pays off if nothing else collapses the row. The
 * /community half also has a class-level pin in
 * src/pages/CommunityPage.tabTargets.test.tsx; /nft-finance is pinned only here
 * (see that file's header for why it cannot be rendered in vitest).
 */
import { test, expect } from './fixtures/wallet';
import { gotoRoute } from './fixtures/routes';

const IPHONE_390 = { width: 390, height: 844 };
const FLOOR = 44;

/**
 * ⚠️ 799 IS THE ONE THAT WAS MISSING, AND IT IS WHERE THE BUG LIVED.
 *
 * This file swept 390px only, so it proved the floor on a phone and said nothing
 * about the widest TOUCH viewport the app serves. "Desktop" in this app means
 * >=800px — that is where BottomNav hides and the TopNav row appears — but the
 * tab class keyed its shrink to Tailwind's `md` (768). That opened a 32px window,
 * 768-799, where the app rendered its touch chrome while these tabs were 40px.
 *
 * Measured live on production 2026-09-05 across all nine hosts at 799px, before
 * the fix: every strip reported 40px. A single extra viewport in this loop is the
 * whole guard.
 */
const TOUCH_WIDTHS = [
  { name: '390px phone', size: IPHONE_390 },
  { name: '799px — the widest touch viewport, one px below the BottomNav breakpoint',
    size: { width: 799, height: 900 } },
];

// /trust and /launch are the 2026-09-04 SectionHost strips — seven tabs and four,
// the primary way to move around the two biggest collapsed sections. They are
// listed here because the markup they share (components/layout/RouteTabs.tsx) was
// extracted from three hosts that all shipped a flat 40px, i.e. under this floor;
// without a case here the new strips would have inherited that silently onto
// nineteen routes.
//
// /lore, /contracts and /leaderboard are those three hosts — LearnPage, InfoPage
// and ActivityPage. RouteTabs was extracted FROM them and then left them behind,
// so for one change-set the app shipped the 44px floor on the four new strips and
// the old flat 40px on the three originals: the same defect this file was written
// for, on the surfaces it was copied from. They now render RouteTabs too, and
// these three cases are what stops that from silently regressing. They fail on
// the pre-migration files — each host's own `min-h-[40px]` button class is about
// 4px under the floor at this viewport.
// 2026-09-05 — TWO ADDED, AND ONE DELIBERATELY NOT.
// /liquidity and /farm became RouteTabs hosts in the nav rewrite (the Pools
// section and the Earn section), so by this file's own rule — enumerate the
// tabbed hosts — they belong in the list.
//
// /island is NOT here and must not be added: it is a card lobby with no tablist
// at all (navConfig.ts explains why that section alone is not a SectionHost), so
// the `toBeGreaterThan(1)` guard below would fail on a count of 0 — reporting a
// page that is correct by design as a page that changed shape.
for (const path of ['/community', '/nft-finance', '/trust', '/launch', '/lore', '/contracts', '/leaderboard', '/liquidity', '/farm']) {
  for (const vp of TOUCH_WIDTHS) {
    test(`${path} section tabs clear the ${FLOOR}px touch floor at ${vp.name}`, async ({
      page,
      walletMock: _w,
    }) => {
      await page.setViewportSize(vp.size);
      await gotoRoute(page, path);

      const tabs = page.getByRole('tab');
      const count = await tabs.count();
      expect(count, 'no tablist found — the page changed shape').toBeGreaterThan(1);

      for (let i = 0; i < count; i++) {
        const tab = tabs.nth(i);
        const box = (await tab.boundingBox())!;
        const label = (await tab.textContent())?.trim() ?? `tab ${i}`;
        expect(Math.round(box.height), `"${label}" is ${box.height}px tall`).toBeGreaterThanOrEqual(
          FLOOR,
        );
      }
    });
  }
}

/**
 * THE PAGE MUST NOT SCROLL SIDEWAYS ON A PHONE.
 *
 * ⚠️ WRITTEN BECAUSE IT SHIPPED BROKEN. The 2026-09-05 nav rewrite added two
 * wide tables (/liquidity's pool table, /farm's island index), each correctly
 * wrapped in `overflow-x-auto`. The wrapper clipped the TABLE — and did not clip
 * the `sr-only` span in its last <th>, because Tailwind's `sr-only` is
 * `position:absolute` and an absolutely-positioned element is only clipped by an
 * ancestor that is its CONTAINING BLOCK, i.e. a positioned one. The static
 * wrapper was not, so the span painted at the 520px table's right edge and
 * dragged the document's scroll width to 521 on a 390px viewport.
 *
 * It looked completely fine: the table sat inside its rounded card, scrolling
 * its own overflow, while the whole page slid sideways under the user's thumb.
 *
 * The assertion is deliberately BEHAVIOURAL — it scrolls and checks the page
 * moved — rather than comparing scrollWidth to clientWidth. `body` carries
 * `overflow-x: hidden` in index.css, so the two can disagree, and the question
 * that matters to a person holding a phone is whether it moves.
 */
for (const path of ['/', '/liquidity', '/farm', '/island', '/swap', '/trust']) {
  test(`${path} does not scroll horizontally at 390px`, async ({ page, walletMock: _w }) => {
    await page.setViewportSize(IPHONE_390);
    await gotoRoute(page, path);

    const moved = await page.evaluate(() => {
      const before = window.scrollX;
      window.scrollTo(500, 0);
      const after = window.scrollX;
      window.scrollTo(0, 0);
      return { before, after, scrollW: document.documentElement.scrollWidth };
    });

    expect(
      moved.after,
      `the page slid sideways to x=${moved.after} (scrollWidth ${moved.scrollW}). Something is ` +
        'escaping its scroll container — check for a position:absolute child (sr-only!) inside ' +
        'a STATIC overflow-x-auto wrapper.',
    ).toBe(moved.before);
  });
}
