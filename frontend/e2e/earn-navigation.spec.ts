import { test, expect, type Page } from '@playwright/test';

// EARN ALWAYS LEADS BACK TO THE LIST (owner, 2026-09-30): "when you are in
// Staking of an asset there is no way to go back to the main Earn page to choose
// another asset. When I click on Earn on the top bar it stays on the same page.
// Also earn link is Farm on URL." The word pointed at /farm, which drew whatever
// pool the stored room named. Now /earn is the list and /earn/<id> one pool.

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('tegridy-onboarding-seen', '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
    } catch { /* private mode */ }
  });
});

/** The Earn word in whichever nav this viewport shows. */
function earnWord(page: Page) {
  return page.locator('nav[aria-label="Main navigation"]:visible a', { hasText: /^Earn$/ }).first();
}

test('the Earn word, clicked from inside a pool, goes to the list', async ({ page }) => {
  await page.goto('/earn/bayla');
  await expect(page.getByRole('heading', { level: 1, name: 'Stake BAYLA.' })).toBeVisible({ timeout: 30_000 });
  await expect(earnWord(page)).toHaveAttribute('href', '/earn');
  await earnWord(page).click();
  await expect(page).toHaveURL(/\/earn$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Earn' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Open BAYLA' })).toBeVisible();
});

test("the lit Staking tab, clicked from inside a pool, goes to the list", async ({ page }) => {
  await page.goto('/earn/bayla');
  const staking = page.getByRole('tab', { name: 'Staking' });
  await expect(staking).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
  await staking.click();
  await expect(page).toHaveURL(/\/earn$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Earn' })).toBeVisible({ timeout: 30_000 });
});

test('a stored room does not turn the list into that pool', async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('tegridy-bungalow', 'bayla'); } catch { /* private mode */ }
  });
  await page.goto('/earn');
  await expect(page.getByRole('heading', { level: 1, name: 'Earn' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'Stake BAYLA.' })).toHaveCount(0);
});

test.describe('an old /farm link keeps its meaning', () => {
  test('/farm?bungalow=<id> opens that pool', async ({ page }) => {
    await page.goto('/farm?bungalow=bayla');
    await expect(page).toHaveURL(/\/earn\/bayla$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Stake BAYLA.' })).toBeVisible({ timeout: 30_000 });
  });

  test('/farm with no room opens the list', async ({ page }) => {
    await page.goto('/farm');
    await expect(page).toHaveURL(/\/earn$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Earn' })).toBeVisible({ timeout: 30_000 });
  });

  test('an unknown pool id goes to the list', async ({ page }) => {
    await page.goto('/earn/not-a-resident');
    await expect(page).toHaveURL(/\/earn$/);
  });
});
