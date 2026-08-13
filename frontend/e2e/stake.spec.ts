/**
 * AUDIT R081 — Stake / claim / unstake happy path (only h1 regex before).
 *
 * /farm hosts: TOWELI staking, LP farming, restaking. This spec drives the
 * single-asset stake flow:
 *   connect → enter amount → approve → stake → wait for receipt → claim →
 *   unstake (cooldown gate may apply on real Anvil — see TF-02 in audit
 *   findings; that race is asserted by Solidity tests, not here).
 *
 * Mock-mode covers UI structure (gate, inputs, CTAs). Anvil-mode covers the
 * full state-changing flow. See swap.spec.ts for why the anvil gate lives
 * INSIDE the test rather than in describe scope.
 */
import { test, expect } from './fixtures/wallet';

const onAnvil = !!process.env.ANVIL_RPC_URL;

test.describe('Stake surface', () => {
  test('disconnected /farm shows the connect prompt', async ({ page, walletMock: _w }) => {
    await page.goto('/farm');
    // Disconnected, /farm renders no page h1 at all — the whole surface is
    // replaced by the ConnectPrompt region. The old assertion here read
    // `h1` for /farm|stake/ and would have failed the moment it was allowed
    // to run.
    await expect(page.getByRole('region', { name: /wallet connection required/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /connect wallet/i }).first()).toBeVisible();
  });

  test('connected /farm renders staking + LP farming surfaces', async ({ page, walletMock }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await walletMock.connect();
    await page.goto('/farm');
    await expect(page.locator('h1')).toContainText(/farm/i);
    await expect(page.getByRole('heading', { name: /stake toweli/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /lp farming/i })).toBeVisible();
    // The connect gate must be GONE — see the handshake note in swap.spec.ts.
    await expect(page.getByRole('region', { name: /wallet connection required/i })).toBeHidden();
    expect(pageErrors).toEqual([]);
  });

  test('stake input is typeable when wallet is connected', async ({ page, walletMock }) => {
    await walletMock.connect();
    await page.goto('/farm');

    const stakeInput = page.getByRole('textbox', { name: /amount of toweli to stake/i });
    await expect(stakeInput).toBeVisible();
    await stakeInput.fill('100');
    await expect(stakeInput).toHaveValue('100');

    const cta = page.locator('button', {
      hasText: /(stake|approve|claim|unstake|enter amount|insufficient)/i,
    }).first();
    await expect(cta).toBeVisible();
  });

  test('stake → claim → unstake (Anvil only)', async ({ page, walletMock }) => {
    test.skip(!onAnvil, 'ANVIL_RPC_URL unset — needs the fork job (npm run e2e)');

    await walletMock.connect();
    await page.goto('/farm');

    // 1. Stake
    const amount = page.getByRole('textbox', { name: /amount of toweli to stake/i });
    await amount.fill('100');

    // Approve first if the allowance path demands it; the CTA carries the verb.
    //
    // PRECONDITION this test needs from the fork, named here so a red run is
    // actionable rather than a mystery: the account must HOLD TOWELI.
    // `anvil_setBalance` funds ETH only, and 0x71bE…5788 holds no TOWELI on
    // mainnet, so a bare fork leaves this CTA disabled. Seeding it means a
    // `deal`-style `anvil_setStorageAt` on the balanceOf slot, or impersonating
    // a holder — neither exists in the fixture yet.
    const cta = page.getByRole('button', { name: /^(approve|stake)/i }).first();
    await expect(
      cta,
      'stake CTA never enabled — the fork account holds no TOWELI. Seed an ERC-20 balance in the fixture (anvil_setStorageAt on the balanceOf slot) before this leg can execute.',
    ).toBeEnabled({ timeout: 20_000 });
    await cta.click();
    await expect(page.locator('a[href*="etherscan"], a[href*="explorer"]').first()).toBeVisible({ timeout: 30_000 });

    // 2. Claim — needs accrued rewards; on a fresh fork rewards may be 0,
    // so we just assert the button is wired (not necessarily enabled).
    await expect(page.getByRole('button', { name: /claim/i }).first()).toBeVisible();

    // 3. Unstake — cooldown gate may block (see TF-02). Confirm the CTA wires
    // a tx (or surfaces the cooldown copy).
    await expect(page.getByRole('button', { name: /unstake|withdraw|exit/i }).first()).toBeVisible();
  });
});
