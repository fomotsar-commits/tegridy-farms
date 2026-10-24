// The word Pools opens the Solana LP tab (owner, 2026-10-03). It is a drawer row at every
// width since the bar became Heat · Rooms · Lock · Launch · Swap; walked from the home page.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/wallet';
import { gotoRoute } from './fixtures/routes';

/** The press opened the Solana LP page, with its own tab selected in the Pools strip. */
async function expectSolanaLpTab(page: Page): Promise<void> {
  // The path, not the whole address: a pattern on the address also matches a query.
  await expect.poll(() => new URL(page.url()).pathname, 'Pools did not open /solana-lp').toBe('/solana-lp');
  await expect(page.getByRole('tab', { name: 'Solana LP', exact: true }), 'Solana LP is not the selected tab').toHaveAttribute('aria-selected', 'true');
  // The network drop-down names Solana, and the strip shows Solana's tabs: the Ethereum form
  // is one pick away under Ethereum, not a tab here (owner, 2026-10-15).
  await expect(page.getByRole('button', { name: 'Pools network: Solana' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Add / Remove', exact: true })).toHaveCount(0);
}

test('Pools is not a bar word at any width', async ({ page, walletMock: _w }) => {
  await gotoRoute(page, '/');
  const bar = page.locator('nav[aria-label="Main navigation"]:visible');
  await expect(bar.getByRole('link', { name: 'Lock', exact: true })).toBeVisible();
  await expect(bar.getByRole('link', { name: 'Pools', exact: true })).toHaveCount(0);
});

test('Pools, pressed in the menu from the home page, opens the Solana LP tab', async ({ page, walletMock: _w }) => {
  await gotoRoute(page, '/');
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  const menu = page.getByRole('dialog', { name: 'Navigation menu' });
  await menu.getByRole('link', { name: 'Pools', exact: true }).click();
  await expectSolanaLpTab(page);
});
