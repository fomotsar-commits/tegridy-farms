// The word Pools opens the Solana LP tab (owner, 2026-10-03). Walked from the home page,
// in every place a visitor can press the word: the top bar on a wide screen, the bottom
// bar and the menu on a narrow one.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/wallet';
import { gotoRoute } from './fixtures/routes';

/** Below this the top bar's words give way to the bottom bar and the menu (TopNav, BottomNav). */
const BAR_FROM_PX = 800;

/** The press opened the Solana LP page, with its own tab selected in the Pools strip. */
async function expectSolanaLpTab(page: Page): Promise<void> {
  // The path, not the whole address: a pattern on the address also matches a query.
  await expect.poll(() => new URL(page.url()).pathname, 'Pools did not open /solana-lp').toBe('/solana-lp');
  await expect(page.getByRole('tab', { name: 'Solana LP', exact: true }), 'Solana LP is not the selected tab').toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Add / Remove', exact: true }), 'the Ethereum form should be the tab beside it, not the selected one').toHaveAttribute('aria-selected', 'false');
}

test('Pools, pressed in the bar from the home page, opens the Solana LP tab', async ({ page, walletMock: _w }) => {
  await gotoRoute(page, '/');
  // Two bars carry the name "Main navigation" and one shows at any width.
  const word = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Pools', exact: true }).filter({ visible: true });
  await expect(word, 'one Pools word should be on screen').toHaveCount(1);
  await word.click();
  await expectSolanaLpTab(page);
});

test('Pools, pressed in the menu from the home page, opens the Solana LP tab', async ({ page, walletMock: _w }) => {
  // By the window's width, never by what has rendered so far: a skip decided before the
  // menu button mounts would skip on every run.
  test.skip((page.viewportSize()?.width ?? 0) >= BAR_FROM_PX, 'no menu at this width: the top bar carries the word');
  await gotoRoute(page, '/');
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  const menu = page.getByRole('dialog', { name: 'Navigation menu' });
  await menu.getByRole('link', { name: 'Pools', exact: true }).click();
  await expectSolanaLpTab(page);
});
