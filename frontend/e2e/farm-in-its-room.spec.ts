import { test, expect, type Page } from '@playwright/test';
import { gotoRoute, waitForQuiescence } from './fixtures/routes';

// THE FARM SPEAKS ONLY IN ITS ROOM (docs/FACE_LAWS.md, law 21; the island's venue
// review, item 13).
//
// One visit to /toweli stores that room, and the stored room used to speak on every
// route after it: the farm's footer and contract card, Towelie in the corner, and
// "stake TOWELI on Ethereum" in step one of /start. A venue route reads the venue's
// words whatever door was opened last. The room's art and trade route still follow it.
//
// Fixture-free, like arrival-voice.spec.ts: the wallet fixture stores the room itself.

test.use({ viewport: { width: 390, height: 844 } });

const VENUE_ROUTES = ['/start', '/leaderboard', '/nb1', '/launch'];
const VENUE_SENTENCE = 'Memetic Finance on Jungle Bay Island.';
const FARM_SENTENCE = 'Stake TOWELI & LP tokens to earn rewards';
const towelie = (page: Page) => page.getByRole('button', { name: 'Towelie says hi' });
const stored = (page: Page) => page.evaluate(() => localStorage.getItem('tegridy-bungalow'));

async function seedOverlays(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('tegridy-onboarding-seen', '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
    } catch { /* ignore */ }
  });
}

/** Walk through the farm's door and prove the room was stored and is speaking there. */
async function visitTheFarm(page: Page) {
  await seedOverlays(page);
  await page.goto('/toweli');
  await expect(page.locator('h1.heading-luxury:has-text("Farm TOWELI.")')).toHaveCount(1, { timeout: 20_000 });
  expect(await stored(page)).toBe('toweli');
  await expect(towelie(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('footer')).toContainText(FARM_SENTENCE);
}

test.describe('after one visit to /toweli', () => {
  for (const route of VENUE_ROUTES) {
    test(`${route} keeps the venue's footer`, async ({ page }) => {
      await visitTheFarm(page);
      await gotoRoute(page, route);

      const footer = page.locator('footer');
      await expect(footer).toContainText(VENUE_SENTENCE);
      await expect(footer).not.toContainText(FARM_SENTENCE);
      await expect(footer).not.toContainText('TOWELI contract');
      await expect(footer).not.toContainText('Trade on Uniswap');
      // The room is still stored: its art and its trade route follow it. Only its voice stays home.
      expect(await stored(page)).toBe('toweli');
    });

    // /nb1 is a control here: an open lot's door never showed him. The other three did.
    test(`${route} shows no Towelie`, async ({ page }) => {
      await visitTheFarm(page);
      await gotoRoute(page, route);
      // An absence has no event to wait for, so wait until the page has stopped changing:
      // Towelie arrives in a chunk of his own, after the page.
      await waitForQuiescence(page);
      await expect(towelie(page)).toHaveCount(0);
    });
  }

  test('/start reads the venue’s words in step one', async ({ page }) => {
    await visitTheFarm(page);
    await gotoRoute(page, '/start');
    const main = page.locator('main#main-content');
    await expect(main).toContainText('stake a resident community’s token');
    await expect(main).not.toContainText('stake TOWELI on Ethereum');
  });

  test('a tap from the room to a venue page changes the voice with the page', async ({ page }) => {
    // No reload: the footer and the corner must follow a client-side move too.
    await visitTheFarm(page);
    await page.locator('footer').getByRole('link', { name: 'FAQ', exact: true }).click();
    await expect(page).toHaveURL(/\/faq$/);
    const footer = page.locator('footer');
    await expect(footer).toContainText(VENUE_SENTENCE);
    await expect(footer).not.toContainText('TOWELI contract');
    await waitForQuiescence(page);
    await expect(towelie(page)).toHaveCount(0);
  });
});

test.describe('the farm still speaks in its own room', () => {
  // The counter-test: a fix that silenced the farm everywhere would pass every case above.
  for (const route of ['/tokenomics', '/lore']) {
    test(`${route} keeps the farm's footer and Towelie for a visitor who came through its door`, async ({ page }) => {
      await visitTheFarm(page);
      await gotoRoute(page, route);
      const footer = page.locator('footer');
      await expect(footer).toContainText(FARM_SENTENCE);
      await expect(footer).toContainText('TOWELI contract');
      await expect(towelie(page)).toBeVisible({ timeout: 30_000 });
    });
  }
});
