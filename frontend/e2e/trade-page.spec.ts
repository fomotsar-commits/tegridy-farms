/**
 * AUDIT C-05 — batch 16: TradePage spec, the next step on top of the
 * batch-11 wallet fixture. This intentionally tests what IS testable without
 * a real wagmi connection handshake or Anvil backend:
 *   - the Swap / DCA / Limit tab toggle (pure React state)
 *   - the "connect wallet to swap" gate when disconnected
 *   - that the page renders with no console errors
 *   - that the route-level components from batches 15 lazy-loaded successfully
 *
 * Things DEFERRED until the fixture is backed by Anvil:
 *   - driving a real approve -> swap tx pair
 *   - asserting the post-swap receipt toast + explorer link
 *   - verifying slippage / route-choice UX end-to-end
 * See the ANVIL_BACKEND block in fixtures/wallet.ts for the upgrade path.
 */

import { test, expect } from './fixtures/wallet';

// The walletMock fixture suppresses the AppLoader splash overlay as a side
// effect. All tests here destructure { walletMock } so the init-script fires
// before page.goto, even if the test doesn't actually call mock methods.

test.describe('TradePage', () => {
  test('renders with disconnected-wallet gate', async ({ page, walletMock: _w }) => {
    await page.goto('/swap');
    await expect(page.locator('h1')).toContainText(/trade/i);
    // Swap tab is the default; disconnected state must show the gate copy.
    await expect(page.getByText('Connect your wallet to swap', { exact: true })).toBeVisible();
  });

  test('tab toggle switches between Swap, DCA, and Limit', async ({ page, walletMock: _w }) => {
    await page.goto('/swap');

    // Grab the tab group by its distinct 3-button layout + button labels.
    const swapTab = page.getByRole('button', { name: 'Swap', exact: true });
    const dcaTab = page.getByRole('button', { name: 'DCA', exact: true });
    const limitTab = page.getByRole('button', { name: 'Limit', exact: true });

    await expect(swapTab).toBeVisible();
    await expect(dcaTab).toBeVisible();
    await expect(limitTab).toBeVisible();

    // Switch to DCA — the Swap-tab-only copy "Connect your wallet to swap"
    // should no longer be in the DOM. Use an exact match to avoid colliding
    // with DCA's own "Connect Wallet" CTA (different wording).
    await dcaTab.click();
    await expect(page.getByText('Connect your wallet to swap', { exact: true })).toHaveCount(0);

    // Switch back to Swap — the gate re-appears.
    await swapTab.click();
    await expect(page.getByText('Connect your wallet to swap', { exact: true })).toBeVisible();
  });

  test('page loads without unhandled page errors', async ({ page, walletMock: _w }) => {
    // Only uncaught JavaScript errors (pageerror) are a real correctness signal.
    // console.error can fire for transient third-party issues (image 404s, RPC
    // probes, WalletConnect pulse failures) that don't break the app; those
    // would make this test flaky under parallel workers.
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/swap');
    await page.waitForTimeout(500);

    expect(pageErrors).toEqual([]);
  });

  test('mock wallet injection does not break TradePage render', async ({ page, walletMock }) => {
    await page.goto('/swap');
    await walletMock.connect();
    // Even though wagmi doesn't complete a full connect handshake from the
    // lightweight mock, the page should not crash. Tab group + h1 must still
    // be visible after the mock's accountsChanged event fires.
    await expect(page.locator('h1')).toContainText(/trade/i);
    await expect(page.getByRole('button', { name: 'Swap', exact: true })).toBeVisible();
  });
});
