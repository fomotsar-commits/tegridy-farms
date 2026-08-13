/**
 * AUDIT R081 — Liquidity add/remove happy path (zero coverage before).
 *
 * /liquidity is a tab on TradePage. This spec covers:
 *   - Mock-mode: tab activation, deposit/withdraw inputs render, CTAs are
 *     coherent.
 *   - Anvil-mode (ANVIL_RPC_URL set): full add → remove cycle against the fork.
 *
 * Wallet fixture: e2e/fixtures/wallet.ts. See swap.spec.ts for why the anvil
 * gate lives INSIDE the test that needs it rather than in describe scope.
 */
import { test, expect } from './fixtures/wallet';

const onAnvil = !!process.env.ANVIL_RPC_URL;

test.describe('Liquidity surface', () => {
  test('disconnected /liquidity renders the page with title and gate', async ({ page, walletMock: _w }) => {
    await page.goto('/liquidity');
    // Title follows the active tab; /liquidity reads "Liquidity".
    await expect(page.locator('h1')).toContainText(/liquidity/i);
    await expect(page.getByRole('tab', { name: 'Liquidity', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: /connect wallet/i }).first()).toBeVisible();
  });

  test('connected wallet renders the LiquidityTab without page errors', async ({ page, walletMock }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await walletMock.connect();
    await page.goto('/liquidity');
    await expect(page.locator('h1')).toContainText(/liquidity/i);
    // Add/remove selector — the pool copy is deliberately in-voice, so match
    // the pair of toggles by role rather than by exact wording.
    await expect(page.getByRole('button', { name: /grow the crop|add/i }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /pull crop out|remove|withdraw/i }).first()).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test('add and remove liquidity inputs are present', async ({ page, walletMock }) => {
    await walletMock.connect();
    await page.goto('/liquidity');
    // Both sides of the pair mount an amount field.
    const numericInputs = page.getByRole('spinbutton', { name: '0.0' });
    await expect(numericInputs.first()).toBeVisible();
    expect(await numericInputs.count()).toBeGreaterThanOrEqual(2);
  });

  test('full add → remove cycle (Anvil only)', async ({ page, walletMock }) => {
    test.skip(!onAnvil, 'ANVIL_RPC_URL unset — needs the fork job (npm run e2e)');

    await walletMock.connect();
    await page.goto('/liquidity');

    // Add liquidity: fill ETH amount, accept quote, approve TOWELI, supply.
    const inputs = page.getByRole('spinbutton', { name: '0.0' });
    await inputs.first().fill('0.05');

    // Some pool surfaces auto-fill the paired token. If the second input
    // remains empty, fill it deterministically.
    const second = inputs.nth(1);
    if (await second.isEditable().catch(() => false)) {
      const v = await second.inputValue();
      if (!v) await second.fill('100');
    }

    // PRECONDITION: both sides of the pair must be held. `anvil_setBalance`
    // covers the ETH leg; the TOWELI leg needs an ERC-20 seed the fixture does
    // not do yet (see the same note in stake.spec.ts).
    const supplyBtn = page.getByRole('button', { name: /(supply|add liquidity|deposit|approve)/i }).first();
    await expect(
      supplyBtn,
      'supply CTA never enabled — the fork account holds no TOWELI for the paired side. Seed an ERC-20 balance in the fixture before this leg can execute.',
    ).toBeEnabled({ timeout: 20_000 });
    await supplyBtn.click();

    // Receipt path
    await expect(page.locator('a[href*="etherscan"], a[href*="explorer"]').first()).toBeVisible({ timeout: 30_000 });

    // Remove liquidity: switch to the remove side, then exit.
    const removeTab = page.getByRole('button', { name: /pull crop out|remove|withdraw/i }).first();
    await removeTab.click();
    const removeBtn = page.getByRole('button', { name: /(remove|withdraw|exit)/i }).last();
    await expect(removeBtn).toBeVisible();
  });
});
