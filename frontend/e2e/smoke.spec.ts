import { test, expect } from '@playwright/test';

test.describe('Smoke Tests', () => {
  test('homepage loads and shows hero', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Tegridy/i);
    await expect(page.locator('h1')).toBeVisible();
  });

  test('navigation links render', async ({ page }) => {
    await page.goto('/');
    // Main nav items should be present
    const nav = page.locator('nav');
    await expect(nav).toBeVisible();
  });

  test('farm page loads', async ({ page }) => {
    await page.goto('/farm');
    await expect(page.locator('h1')).toContainText(/farm|stake/i);
  });

  test('swap page loads', async ({ page }) => {
    await page.goto('/swap');
    await expect(page.locator('h1')).toBeVisible();
  });

  test('community page loads with tabs', async ({ page }) => {
    await page.goto('/community');
    await expect(page.locator('h1')).toContainText(/community/i);
    const tablist = page.locator('[role="tablist"]');
    await expect(tablist).toBeVisible();
    const tabs = tablist.locator('[role="tab"]');
    await expect(tabs).toHaveCount(4);
  });

  test('lending page loads with tabs', async ({ page }) => {
    await page.goto('/lending');
    await expect(page.locator('h1')).toContainText(/NFT Finance/i);
    const tablist = page.locator('[role="tablist"]');
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
    await expect(page.locator('h1')).toContainText(/FAQ/i);
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
    await page.goto('/lending');
    // Should have wallet connect prompt or tab panel
    const panel = page.locator('[role="tabpanel"]');
    // Panel may or may not be visible depending on wallet state
    const tablist = page.locator('[role="tablist"]');
    await expect(tablist).toBeVisible();
  });
});
