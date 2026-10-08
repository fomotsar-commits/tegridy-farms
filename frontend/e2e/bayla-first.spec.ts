import { test, expect, type Page } from '@playwright/test';
import { gotoRoute } from './fixtures/routes';

// $BAYLA FIRST (the owner, 2026-10-03; the island's venue review, item 8).
//
// The home page's chain pills led with Ethereum and /solana opened SOL to USDC. The
// pills lead with Solana now and /solana opens SOL to $BAYLA. $BAYLA keeps what an
// unverified coin gets here: the Unverified chip in the picker and the tick box.

test.use({ viewport: { width: 390, height: 844 } });

async function seedOverlays(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('tegridy-onboarding-seen', '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
    } catch { /* ignore */ }
  });
}

const chainPills = (page: Page) => page.locator('main a.badge').filter({ hasText: /^(SOLANA|ETHEREUM|BASE)$/ });
const aboutBuy = (page: Page) => page.getByRole('button', { name: /^About .+: age, holders, authorities$/ });

test('the home page’s chain pills lead with Solana, on one row at 390', async ({ page }) => {
  await seedOverlays(page);
  await gotoRoute(page, '/');
  await expect(chainPills(page)).toHaveText(['SOLANA', 'ETHEREUM', 'BASE']);
  const boxes = await chainPills(page).evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y) };
    }),
  );
  expect(boxes[0]!.x).toBeLessThan(boxes[1]!.x);
  expect(boxes[1]!.x).toBeLessThan(boxes[2]!.x);
  expect(new Set(boxes.map((b) => b.y)).size, 'the three pills share one row').toBe(1);
});

test('the Solana pill opens the swap on SOL to $BAYLA', async ({ page }) => {
  await seedOverlays(page);
  await gotoRoute(page, '/');
  await chainPills(page).first().click();
  await expect(page).toHaveURL(/\/solana$/);
  await expect(aboutBuy(page)).toHaveAccessibleName('About BAYLA: age, holders, authorities', { timeout: 20_000 });
  await expect(page.getByLabel('Amount of SOL to pay')).toBeVisible();
});

test('/solana keeps $BAYLA’s tick box, unticked, and its Unverified chip in the picker', async ({ page }) => {
  await seedOverlays(page);
  await gotoRoute(page, '/solana');
  await expect(aboutBuy(page)).toHaveAccessibleName('About BAYLA: age, holders, authorities', { timeout: 20_000 });

  const tick = page.locator('label', { hasText: 'an unverified token' }).locator('input[type="checkbox"]');
  await expect(tick).toBeVisible();
  await expect(tick).not.toBeChecked();

  await page.getByRole('button', { name: 'BAYLA', exact: true }).click();
  const row = page.getByRole('dialog').getByRole('button').filter({ hasText: 'BAYLA' }).first();
  await expect(row).toContainText('Unverified');
});

test('a link that names a coin still opens on that coin', async ({ page }) => {
  await seedOverlays(page);
  await gotoRoute(page, '/solana?out=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  await expect(aboutBuy(page)).toHaveAccessibleName('About USDC: age, holders, authorities', { timeout: 20_000 });
});
