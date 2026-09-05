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
  test(`${path} section tabs clear the 44px touch floor at 390px`, async ({
    page,
    walletMock: _w,
  }) => {
    await page.setViewportSize(IPHONE_390);
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
