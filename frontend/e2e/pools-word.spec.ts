// The word Pools opens /pools, the Venue AMM page (owner, 2026-10-03: "pools land on solana lp";
// 2026-10-24: "remove solana lp keep venue amm", the same LP section), whose tab is named
// Add / Remove since 2026-11-11. It is a drawer row at every width; walked from the home page.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/wallet';
import { gotoRoute } from './fixtures/routes';

/** The press opened /pools, with its own tab, Add / Remove, selected in the Pools strip. */
async function expectAddRemoveTab(page: Page): Promise<void> {
  // The path, not the whole address: a pattern on the address also matches a query.
  await expect.poll(() => new URL(page.url()).pathname, 'Pools did not open /pools').toBe('/pools');
  // One Add / Remove: Solana's. The strip shows Solana's tabs, so the Ethereum form's Add / Remove
  // and Zap are one pick away under Ethereum, not tabs here (owner, 2026-10-15).
  const addRemove = page.getByRole('tab', { name: 'Add / Remove', exact: true });
  await expect(addRemove).toHaveCount(1);
  await expect(addRemove, 'Add / Remove is not the selected tab').toHaveAttribute('aria-selected', 'true');
  for (const gone of ['Venue AMM', 'Solana LP', 'Zap']) {
    await expect(page.getByRole('tab', { name: gone, exact: true }), `no ${gone} tab here`).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: 'Pools network: Solana' })).toBeVisible();
}

test('Pools is not a bar word at any width', async ({ page, walletMock: _w }) => {
  await gotoRoute(page, '/');
  const bar = page.locator('nav[aria-label="Main navigation"]:visible');
  await expect(bar.getByRole('link', { name: 'Yield', exact: true })).toBeVisible();
  await expect(bar.getByRole('link', { name: 'Pools', exact: true })).toHaveCount(0);
});

test('Pools, pressed in the menu from the home page, opens its Add / Remove tab', async ({ page, walletMock: _w }) => {
  await gotoRoute(page, '/');
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  const menu = page.getByRole('dialog', { name: 'Navigation menu' });
  await menu.getByRole('link', { name: 'Pools', exact: true }).click();
  await expectAddRemoveTab(page);
});

// A room door, a bookmark or a wallet card from before 2026-10-24 still says /solana-lp.
test('an old /solana-lp link opens the Add / Remove tab on /pools, its token kept', async ({ page, walletMock: _w }) => {
  const mint = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
  await gotoRoute(page, `/solana-lp?mint=${mint}&task=add`);
  await expectAddRemoveTab(page);
  expect(new URL(page.url()).search).toBe(`?mint=${mint}&task=add`);
});
