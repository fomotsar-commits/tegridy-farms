// Build 2 of the outside review, "Solana first, and the five-word bar" (2026-11-01): a stranger
// with no room reads Island · Swap · Add · Lock · Launch, Add third, and Swap opens the Solana
// swap. Where Launch opens is not walked here: launching on Solana is off in a production build
// (curveWriteFlag.ts), and navConfig.test.ts holds the word to the curve's switch both ways.
// Walked from the home page on the production build, at a phone.
import { test, expect, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'a phone walk: the chromium project sets its own size');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    try {
      localStorage.setItem('tegridy-onboarding-seen', '1');
    } catch {
      /* private mode */
    }
  });
});

/** The one bar this width shows: the phone's, at 390px. */
const bar = (page: Page) => page.locator('nav[aria-label="Main navigation"]:visible');

test('a stranger with no room: the bar reads five words, Add third, and Swap opens the Solana swap', async ({ page }) => {
  await page.goto('/');
  await bar(page).locator('a').first().waitFor({ timeout: 30_000 });
  const words = await bar(page).locator('a').evaluateAll((as) => as.map((a) => (a as HTMLElement).innerText.trim()));
  expect(words, 'the bar on the home').toEqual(['Island', 'Swap', 'Add', 'Lock', 'Launch']);

  await bar(page).getByRole('link', { name: 'Swap', exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname, 'Swap did not open the Solana swap').toBe('/solana');
  await expect(bar(page).getByRole('link', { name: 'Swap', exact: true })).toHaveAttribute('aria-current', 'page');
});
