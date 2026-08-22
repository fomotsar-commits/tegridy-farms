/**
 * AUDIT R081 — Claim-rewards surfaces (zero coverage before).
 *
 * Tegridy distributes claimable yield from three surfaces:
 *   1. LP farming — `/farm` (LPFarmingSection)
 *   2. Restaking — `/farm` (RestakingPanel; "Claim N TOWELI" CTA)
 *   3. Bribes / gauge incentives — `/community` (gauge tab)
 *
 * ⚠ A CLAIM CTA IS POSITION-DEPENDENT. The original first test asserted a
 * /claim/i button is visible on /farm "when connected" — it is not, from a
 * cold account, and never was: the claim CTAs mount only once there is a
 * stake or accrued rewards to claim. That assertion could only ever have gone
 * green while the whole file was being skipped. What IS assertable without a
 * position is that each claim-bearing surface mounts, so that is what these
 * check; the claim TRANSACTION is the Anvil leg's job.
 */
import { test, expect, expectTxReceipt } from './fixtures/wallet';

const onAnvil = !!process.env.ANVIL_RPC_URL;

test.describe('Claim rewards surfaces', () => {
  test('/farm mounts the reward-bearing sections when connected', async ({ page, walletMock }) => {
    await walletMock.connect();
    await page.goto('/farm');
    await expect(page.getByRole('heading', { name: /lp farming/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /stake toweli/i })).toBeVisible();
    // No position ⇒ no claim CTA. Pin that as the documented state rather than
    // asserting a button that cannot exist yet.
    await expect(page.getByRole('button', { name: /^claim\s+\d/i })).toHaveCount(0);
  });

  test('/community renders the gauge / governance surfaces under mock wallet', async ({ page, walletMock }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await walletMock.connect();
    await page.goto('/community');
    await expect(page.locator('h1')).toContainText(/community/i);
    for (const label of [/governance/i, /bounties/i, /vote incentives/i, /gauge voting/i]) {
      await expect(page.getByRole('tab', { name: label })).toBeVisible();
    }
    expect(pageErrors).toEqual([]);
  });

  test('gauge voting tab (bribe claims live here) opens without crash', async ({ page, walletMock }) => {
    await walletMock.connect();
    await page.goto('/community');
    const gauge = page.getByRole('tab', { name: /gauge voting/i });
    await gauge.click();
    await expect(gauge).toHaveAttribute('aria-selected', 'true');
  });

  test('claim from LP farming surface (Anvil only)', async ({ page, walletMock }) => {
    test.skip(!onAnvil, 'ANVIL_RPC_URL unset — needs the fork job (npm run e2e)');

    await walletMock.connect();
    await page.goto('/farm');
    const claim = page.getByRole('button', { name: /^claim\s+\d/i }).first();
    // On a fresh fork nothing has accrued. This is a REAL gap, not a pass:
    // fail loudly with the reason rather than skipping, so the fixture gets
    // the reward pre-funding it needs instead of the suite quietly shrinking.
    await expect(
      claim,
      'no accrued rewards on the fork — pre-fund reward storage in the fixture so this leg can execute',
    ).toBeVisible({ timeout: 20_000 });
    await claim.click();
    await expectTxReceipt(page, 'claim');
  });
});
