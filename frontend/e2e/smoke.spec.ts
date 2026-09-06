import { test, expect } from '@playwright/test';
import { gotoRoute } from './fixtures/routes';

/**
 * ⚠ ROUTES ARE ENTERED THROUGH `gotoRoute`, NOT `page.goto`.
 *
 * Every page is a `lazy()` chunk behind Suspense, so `goto` resolves while the
 * route is still a skeleton. Playwright's default 5s expect budget absorbs that
 * on Chromium and on WebKit at --workers=1 (the CI setting), and does not
 * absorb it on WebKit at the local default worker count — measured on this
 * machine: green at --workers=1, red at 9 with `element(s) not found`, same
 * build, pages fine. `gotoRoute` waits for the fallback to be gone before any
 * assertion runs, so the result stops depending on the host's core count.
 * See e2e/fixtures/routes.ts.
 */

test.describe('Smoke Tests', () => {
  test('homepage loads and shows hero', async ({ page }) => {
    await gotoRoute(page, '/');
    // ARRIVAL IDENTITY 2026-08-27: the default arrival is the venue's own
    // voice; the Tegridy title lives inside the TOWELI bungalow.
    await expect(page).toHaveTitle(/MEMETICS/i);
    await expect(page.locator('h1')).toBeVisible();
  });

  test('navigation links render', async ({ page }) => {
    await gotoRoute(page, '/');
    // Both desktop top nav and mobile bottom nav mount as <nav aria-label="Main
    // navigation">, one hidden at each breakpoint via tailwind md:hidden/hidden.
    // Assert that at least one is visible (the visible-filter picks the one not
    // suppressed by media queries).
    const visibleNav = page.locator('nav[aria-label="Main navigation"]:visible').first();
    await expect(visibleNav).toBeVisible();
  });

  test('earn page loads', async ({ page }) => {
    await gotoRoute(page, '/farm');
    // Title (set via usePageTitle) is the authoritative source for "did this
    // route mount": the classic FarmPage renders its heading as a heading-luxury
    // h2 inside ConnectPrompt / StakePanel rather than an h1.
    //
    // 2026-09-05 — WAS /Farm/i. This suite runs with NO bungalow chosen, which
    // is the venue's own voice, and /farm no longer answers that with one
    // resident's staking page: it is the island-wide pool index, titled "Earn"
    // like the nav word that opens it. The classic TOWELI farm still titles
    // itself "Farm" inside its own room, which src/pages/venueVoice.test.tsx and
    // FarmPage.boostAndBatch.test.tsx cover.
    await expect(page).toHaveTitle(/Earn/i);
  });

  test('swap page loads', async ({ page }) => {
    await gotoRoute(page, '/swap');
    await expect(page.locator('h1')).toBeVisible();
  });

  test('community page loads with tabs', async ({ page }) => {
    await gotoRoute(page, '/community');
    await expect(page.locator('h1')).toContainText(/community/i);
    // The page renders multiple role="tablist" elements (page-level Community
    // tabs + the gauge-voting subtabs). Scope to the first one — that's the
    // top-level navigation we care about for this smoke.
    const tablist = page.locator('[role="tablist"]').first();
    await expect(tablist).toBeVisible();
    const tabs = tablist.locator('[role="tab"]');
    await expect(tabs).toHaveCount(4);
  });

  test('lending page loads with tabs', async ({ page }) => {
    await gotoRoute(page, '/lending');
    await expect(page.locator('h1')).toContainText(/NFT Finance/i);
    // Same multi-tablist pattern as community — scope to first.
    const tablist = page.locator('[role="tablist"]').first();
    await expect(tablist).toBeVisible();
  });

  test('premium page loads', async ({ page }) => {
    await gotoRoute(page, '/premium');
    await expect(page.locator('h1')).toContainText(/Gold.*Card/i);
  });

  test('tokenomics page loads', async ({ page }) => {
    await gotoRoute(page, '/tokenomics');
    await expect(page.locator('h1')).toBeVisible();
  });

  test('faq page loads and has search', async ({ page }) => {
    await gotoRoute(page, '/faq');
    // FAQ page h1 follows the in-character "Questions about the farm"
    // phrasing — the route still serves at /faq and the document title is
    // "FAQ", but the visible heading leans into the personality system.
    // Accept either historic phrasing OR the current copy.
    await expect(page.locator('h1')).toContainText(/FAQ|Frequently Asked Questions|Questions about the farm/i);
  });

  test('404 page shows for unknown routes', async ({ page }) => {
    await gotoRoute(page, '/nonexistent-page-xyz');
    await expect(page.locator('body')).toContainText(/not found|go back|home/i);
  });
});

test.describe('Responsive', () => {
  test('mobile navigation works', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await gotoRoute(page, '/');
    await expect(page.locator('h1')).toBeVisible();
  });

  test('community tabs scroll on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await gotoRoute(page, '/community');
    const tablist = page.locator('[role="tablist"]');
    await expect(tablist).toBeVisible();
  });
});

test.describe('Accessibility', () => {
  test('tabs have correct ARIA attributes', async ({ page }) => {
    await gotoRoute(page, '/community');
    // Wait for tabs to load
    const tabs = page.locator('[role="tab"]');
    await expect(tabs.first()).toBeVisible();
    // First tab should be selected
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  });

  test('lending tab panels have correct roles', async ({ page }) => {
    // `/lending` is a redirect (App.tsx:236 -> /nft-finance); go straight there.
    await gotoRoute(page, '/nft-finance');
    // Should have wallet connect prompt or tab panel
    // _panel: panel may or may not be visible depending on wallet state.
    // Kept for documentation; not asserted because the wallet-connect prompt
    // can replace the tabpanel in unauthenticated runs.
    const _panel = page.locator('[role="tabpanel"]');
    // Multiple tablists exist on the page (section tabs + the OnboardingModal's
    // own, mounted by AppLayout.tsx:182), so an unscoped locator is a strict-mode
    // violation. Same `.first()` pattern as the community/farm assertions above.
    const tablist = page.locator('[role="tablist"]').first();
    await expect(tablist).toBeVisible();
  });
});
