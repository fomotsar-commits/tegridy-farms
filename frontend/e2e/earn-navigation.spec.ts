import { test, expect, type Page } from '@playwright/test';

// Lock shows the bungalow selected (owner, 2026-10-15): inside a room, /earn opens that room's
// pool at /earn/<id>. With no room chosen /earn is the list of every pool, and from inside any
// room the list is /earn?pools=all, one press away on every pool (owner, 2026-09-30: from inside
// a pool there was no way back to the list). The word was Earn until the bar became
// Heat · Rooms · Lock · Launch · Swap (2026-10-15).

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

test('Lock inside a room opens that room\'s pool, and only that one', async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('tegridy-bungalow', 'bayla'); } catch { /* private mode */ }
  });
  await page.goto('/earn');
  await expect(page).toHaveURL(/\/earn\/bayla$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Stake BAYLA.' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Open PEPE' })).toHaveCount(0);
  // The word and the lit Staking tab keep the visitor on the room's pool.
  await expect(earnWord(page)).toHaveAttribute('href', '/earn');
  await earnWord(page).click();
  await expect(page).toHaveURL(/\/earn\/bayla$/);
  const staking = page.getByRole('tab', { name: 'Staking' });
  await expect(staking).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
  await staking.click();
  await expect(page).toHaveURL(/\/earn\/bayla$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Stake BAYLA.' })).toBeVisible();
});

test('with no room chosen, /earn is the list of every pool', async ({ page }) => {
  await page.goto('/earn');
  await expect(page).toHaveURL(/\/earn$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Earn' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Open BAYLA' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open PEPE' })).toBeVisible();
});

test('from inside a pool, Every pool opens the list, and the list stays put', async ({ page }) => {
  await page.goto('/earn/bayla');
  await expect(page.getByRole('heading', { level: 1, name: 'Stake BAYLA.' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('link', { name: 'Every pool' }).click();
  await expect(page).toHaveURL(/\/earn\?pools=all$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Earn' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Open PEPE' })).toBeVisible();
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
