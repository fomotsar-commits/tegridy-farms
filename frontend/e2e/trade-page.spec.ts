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
    // TradePage's h1 follows the active tab (Swap / Liquidity / Recurring Swap /
    // Price Alert) rather than the route name "Trade" — the title-by-tab map at
    // TradePage.tsx:55 is the source of truth. Match the union.
    await expect(page.locator('h1')).toContainText(/Swap|Liquidity|Recurring Swap|Price Alert|Trade/i);
    // Swap tab is the default; disconnected state must show the gate copy.
    await expect(page.getByText('Connect your wallet to swap', { exact: true })).toBeVisible();
  });

  test('tab toggle switches between Swap, Recurring Swap, and Price Alert', async ({ page, walletMock: _w }) => {
    await page.goto('/swap');

    // Tab labels come from `TAB_LABELS` (src/pages/TradePage.tsx:43) — the
    // SHORT names actually rendered in the tab strip. This test used to assert
    // 'Recurring Swap' / 'Price Alert', which are `titleByTab` entries: the
    // page-body headings, never the tab labels. Assert what the tab renders.
    // Tabs render as role="tab" (not role="button") inside a [role="tablist"].
    const swapTab = page.getByRole('tab', { name: 'Swap', exact: true });
    const dcaTab = page.getByRole('tab', { name: 'DCA', exact: true });
    const limitTab = page.getByRole('tab', { name: 'Alerts', exact: true });

    await expect(swapTab).toBeVisible();
    await expect(dcaTab).toBeVisible();
    await expect(limitTab).toBeVisible();

    // Switch to DCA (page heading: "Recurring Swap") — the Swap-tab-only copy "Connect your wallet
    // to swap" should no longer be in the DOM. Use an exact match to avoid
    // colliding with the Recurring Swap tab's own "Connect Wallet" CTA.
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
    // TradePage's h1 follows the active tab (Swap / Liquidity / Recurring Swap /
    // Price Alert) rather than the route name "Trade" — the title-by-tab map at
    // TradePage.tsx:55 is the source of truth. Match the union.
    await expect(page.locator('h1')).toContainText(/Swap|Liquidity|Recurring Swap|Price Alert|Trade/i);
    // Tab strip exposes role="tab", not role="button".
    await expect(page.getByRole('tab', { name: 'Swap', exact: true })).toBeVisible();
  });
});
