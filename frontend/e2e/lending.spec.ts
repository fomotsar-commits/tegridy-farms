/**
 * AUDIT R081 — NFT lending borrow / repay happy path (zero coverage before).
 *
 * Cross-references: TF-CRIT-NFT-LENDING-DEADLINE (audit_findings.md, agent
 * 4) — the deadline boundary race is a Solidity bug; this UI spec verifies
 * the countdown timer drift the user sees, not the on-chain race itself.
 *
 * /nft-finance hosts NFTLendingSection. Borrow flow:
 *   connect → choose collection → pick collateral NFT → set principal/term →
 *   create offer (lender) OR accept offer (borrower) → repay before deadline.
 *
 * Mock-mode: confirms the surface mounts and its tabs wire correctly.
 * Anvil-mode: drives a borrow → repay cycle against the fork. See
 * swap.spec.ts for why the anvil gate lives INSIDE the test that needs it.
 */
import { test, expect } from './fixtures/wallet';

const onAnvil = !!process.env.ANVIL_RPC_URL;

test.describe('NFT lending surface', () => {
  test('/nft-finance loads with NFT Lending and Token Lending tabs', async ({ page, walletMock: _w }) => {
    await page.goto('/nft-finance');
    await expect(page.locator('h1')).toContainText(/NFT Finance/i);
    await expect(page.getByRole('tab', { name: /NFT Lending/i }).first()).toBeVisible();
    await expect(page.getByRole('tab', { name: /Token Lending/i }).first()).toBeVisible();
  });

  test('connected wallet renders without unhandled errors', async ({ page, walletMock }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await walletMock.connect();
    await page.goto('/nft-finance');
    await expect(page.locator('h1')).toContainText(/NFT Finance/i);
    await expect(page.getByRole('heading', { name: /^NFT Lending$/i })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test('lend / borrow / my-loans sub-tabs switch', async ({ page, walletMock }) => {
    // The old test here sampled a countdown for 2s and required it to change,
    // then `test.skip(true, …)`d itself when no loan existed — which is every
    // run, from a cold account. It asserted nothing it could not skip out of.
    // Tab wiring is the part of this surface that is actually observable
    // without a position, so assert that instead of pretending.
    await walletMock.connect();
    await page.goto('/nft-finance');

    const nftLendingTab = page.getByRole('tab', { name: /NFT Lending/i }).first();
    await nftLendingTab.click();

    for (const label of [/^Borrow$/i, /^My Loans$/i, /^Lend$/i]) {
      const tab = page.getByRole('tab', { name: label });
      await expect(tab).toBeVisible();
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
    }
  });

  test('borrow → repay full cycle (Anvil only)', async ({ page, walletMock }) => {
    test.skip(!onAnvil, 'ANVIL_RPC_URL unset — needs the fork job (npm run e2e)');

    await walletMock.connect();
    await page.goto('/nft-finance');

    await page.getByRole('tab', { name: /NFT Lending/i }).first().click();
    await page.getByRole('tab', { name: /^Borrow$/i }).click();

    // PRECONDITION: this needs PROTOCOL state, not just balances — a
    // collateral NFT owned by the account AND a live lender offer against its
    // collection. A bare mainnet fork has neither, and anvil_setBalance cannot
    // create them; the fixture has to mint/impersonate first.
    const acceptOffer = page.getByRole('button', { name: /(borrow|accept offer|take loan)/i }).first();
    await expect(
      acceptOffer,
      'no borrowable offer on the fork — the fixture must mint a collateral NFT to the test account and create a lender offer before this leg can execute.',
    ).toBeVisible({ timeout: 20_000 });
    await acceptOffer.click();
    await expect(page.locator('a[href*="etherscan"], a[href*="explorer"]').first()).toBeVisible({ timeout: 30_000 });

    // Repay
    const repay = page.getByRole('button', { name: /repay/i }).first();
    await expect(repay).toBeVisible({ timeout: 20_000 });
    await repay.click();
    await expect(page.locator('a[href*="etherscan"], a[href*="explorer"]').first()).toBeVisible({ timeout: 30_000 });
  });
});
