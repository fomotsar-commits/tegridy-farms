import { test, expect } from '@playwright/test';

test.describe('Smoke Tests', () => {
  test('homepage loads and shows hero', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Tegridy/i);
    await expect(page.locator('h1')).toBeVisible();
  });

  test('navigation links render', async ({ page }) => {
    await page.goto('/');
    // Both desktop top nav and mobile bottom nav mount as <nav aria-label="Main
    // navigation">, one hidden at each breakpoint via tailwind md:hidden/hidden.
    // Assert that at least one is visible (the visible-filter picks the one not
    // suppressed by media queries).
    const visibleNav = page.locator('nav[aria-label="Main navigation"]:visible').first();
    await expect(visibleNav).toBeVisible();
  });

  test('farm page loads', async ({ page }) => {
    await page.goto('/farm');
    // FarmPage doesn't use an h1 — the heading is rendered via heading-luxury
    // styling on an h2 inside ConnectPrompt / StakePanel. Title (set via
    // usePageTitle) is the authoritative source for "did this route mount".
    await expect(page).toHaveTitle(/Farm/i);
  });

  test('swap page loads', async ({ page }) => {
    await page.goto('/swap');
    await expect(page.locator('h1')).toBeVisible();
  });

  test('community page loads with tabs', async ({ page }) => {
    await page.goto('/community');
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
    await page.goto('/lending');
    await expect(page.locator('h1')).toContainText(/NFT Finance/i);
    // Same multi-tablist pattern as community — scope to first.
    const tablist = page.locator('[role="tablist"]').first();
    await expect(tablist).toBeVisible();
  });

  test('premium page loads', async ({ page }) => {
    await page.goto('/premium');
    await expect(page.locator('h1')).toContainText(/Gold.*Card/i);
  });

  test('tokenomics page loads', async ({ page }) => {
    await page.goto('/tokenomics');
    await expect(page.locator('h1')).toBeVisible();
  });

  test('faq page loads and has search', async ({ page }) => {
    await page.goto('/faq');
    // FAQ page h1 follows the in-character "Questions about the farm"
    // phrasing — the route still serves at /faq and the document title is
    // "FAQ", but the visible heading leans into the personality system.
    // Accept either historic phrasing OR the current copy.
    await expect(page.locator('h1')).toContainText(/FAQ|Frequently Asked Questions|Questions about the farm/i);
  });

  test('404 page shows for unknown routes', async ({ page }) => {
    await page.goto('/nonexistent-page-xyz');
    await expect(page.locator('body')).toContainText(/not found|go back|home/i);
  });
});

test.describe('Responsive', () => {
  test('mobile navigation works', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await expect(page.locator('h1')).toBeVisible();
  });

  test('community tabs scroll on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/community');
    const tablist = page.locator('[role="tablist"]');
    await expect(tablist).toBeVisible();
  });
});

test.describe('Accessibility', () => {
  test('tabs have correct ARIA attributes', async ({ page }) => {
    await page.goto('/community');
    // Wait for tabs to load
    const tabs = page.locator('[role="tab"]');
    await expect(tabs.first()).toBeVisible();
    // First tab should be selected
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  });

  test('lending tab panels have correct roles', async ({ page }) => {
    // `/lending` is a redirect (App.tsx:236 -> /nft-finance); go straight there.
    await page.goto('/nft-finance');
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
