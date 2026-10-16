import { test, expect, type Page } from '@playwright/test';

// The bar's Lock word always leads back to the list of every pool (owner, 2026-09-30: from
// inside a pool the word "stays on the same page"). /earn is the list and /earn/<id> one pool;
// the word was Earn until the bar became Heat · Rooms · Lock · Launch · Swap (2026-10-15).

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('tegridy-onboarding-seen', '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
    } catch { /* private mode */ }
  });
});

/** The Lock word in whichever bar this viewport shows. */
function earnWord(page: Page) {
  return page.locator('nav[aria-label="Main navigation"]:visible a', { hasText: /^Lock$/ }).first();
}

test('the Lock word, clicked from inside a pool, goes to the list', async ({ page }) => {
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
