import { test, expect, type Page } from '@playwright/test';

// /earn is the list of every pool and /earn/<id> one pool. The bar's Lock word and the Staking
// tab open the room's own pool (owner, 2026-10-15: "only show the bungalow selected"), the list
// with no room; each pool's "Back to Earn" leads to the list (owner, 2026-09-30). The word was
// Earn until the bar became Heat · Rooms · Lock · Launch · Swap (2026-10-15).

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

test("the Lock word, in BAYLA's room, opens BAYLA's pool and only that one", async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('tegridy-bungalow', 'bayla'); } catch { /* private mode */ }
  });
  await page.goto('/island');
  await expect(earnWord(page)).toHaveAttribute('href', '/earn/bayla', { timeout: 30_000 });
  await earnWord(page).click();
  await expect(page).toHaveURL(/\/earn\/bayla$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Stake BAYLA.' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Open PEPE' })).toHaveCount(0);
});

test('with no room chosen, the Lock word opens the list of every pool', async ({ page }) => {
  await page.goto('/island');
  await expect(earnWord(page)).toHaveAttribute('href', '/earn', { timeout: 30_000 });
  await earnWord(page).click();
  await expect(page).toHaveURL(/\/earn$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Earn' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Open BAYLA' })).toBeVisible();
});

test("the Staking tab, in a room, opens that room's pool; Back to Earn opens the list", async ({ page }) => {
  await page.goto('/earn/bayla');
  await expect(page.getByRole('heading', { level: 1, name: 'Stake BAYLA.' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'NFT Loans' }).click();
  await expect(page).toHaveURL(/\/nft-finance$/);
  await page.getByRole('tab', { name: 'Staking' }).click();
  await expect(page).toHaveURL(/\/earn\/bayla$/);
  await page.getByRole('link', { name: 'Back to Earn' }).click();
  await expect(page).toHaveURL(/\/earn$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Earn' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Open PEPE' })).toBeVisible();
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
