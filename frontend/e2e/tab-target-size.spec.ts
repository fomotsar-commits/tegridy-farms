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
for (const path of ['/community', '/nft-finance', '/trust', '/launch']) {
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
