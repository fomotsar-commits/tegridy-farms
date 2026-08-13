/**
 * AUDIT R081 — Happy-path swap E2E (HIGH priority gap from agent 088).
 *
 * Coverage gap closed: prior swap surface only had a tab-toggle visibility
 * check (`trade-page.spec.ts`). This spec drives the full flow:
 *   connect wallet → swap tab → enter amount → quote refresh → approve gate →
 *   review → execute → tx receipt confirmation.
 *
 * Backend mode:
 *   - DEFAULT: mock wallet (e2e/fixtures/wallet.ts). The wallet handshake is
 *     REAL — the mock announces itself over EIP-6963, so wagmi genuinely
 *     connects — but chain reads still go to public mainnet, where the test
 *     account holds nothing. So the CTA sits disabled and we assert the
 *     structure of the surface, not a trade.
 *   - ANVIL: with ANVIL_RPC_URL set, the fixture ALSO redirects the app's own
 *     RPC transports at the fork (see routeAppReadsToAnvil), the account is
 *     funded with anvil_setBalance, and the state-changing leg below runs.
 *
 * ⚠ SKIP PLACEMENT. The `test.skip(!onAnvil, …)` that used to sit here sat in
 * DESCRIBE scope, where Playwright applies it to every test in the group — so
 * all four tests in this file, including the three that need no chain at all,
 * ran in no pipeline. Same bug in stake/liquidity/lending/claim-rewards: 20
 * tests x 2 projects = the 40 skips. Gate inside the test that needs the gate.
 */
import { test, expect } from './fixtures/wallet';

const onAnvil = !!process.env.ANVIL_RPC_URL;

test.describe('Swap happy path', () => {
  test('disconnected → connect wallet CTA visible on swap surface', async ({ page, walletMock: _w }) => {
    await page.goto('/swap');
    await expect(page.locator('h1')).toContainText(/swap/i);
    await expect(page.getByText('Connect your wallet to swap', { exact: true })).toBeVisible();
  });

  test('connect → the app actually authorizes the wallet and swaps the gate for a CTA', async ({ page, walletMock }) => {
    // This is the handshake regression guard. Before the EIP-6963 announcement
    // landed in the fixture the app never called the mock ONCE
    // (`__walletMock.getCalls()` came back empty), so "connected" assertions
    // were really disconnected-surface assertions and passed for the wrong
    // reason. Asserting that the connect GATE is gone is what pins that.
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await walletMock.connect();
    await page.goto('/swap');

    await expect(page.getByRole('tab', { name: 'Swap', exact: true })).toBeVisible();
    await expect(page.getByText('Connect your wallet to swap', { exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: /^swap$/i })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test('input amount is typeable and surfaces an output / approve / swap CTA', async ({ page, walletMock }) => {
    await walletMock.connect();
    await page.goto('/swap');

    const amountInput = page.getByRole('spinbutton', { name: /amount of .* to pay/i });
    await expect(amountInput).toBeVisible();
    await amountInput.fill('0.01');
    await expect(amountInput).toHaveValue('0.01');

    // The action CTA is one of: "Approve TOKEN", "Swap", "Wrong network", or
    // "Insufficient balance" depending on read state. All are valid renders of
    // the swap card; assert SOMETHING coherent is the CTA rather than pinning
    // one, which is what balance-dependent copy makes unstable.
    const cta = page.locator('button', {
      hasText: /(swap|approve|insufficient|wrong network|enter an amount)/i,
    }).first();
    await expect(cta).toBeVisible();
  });

  test('execute ETH → TOWELI swap and confirm receipt (Anvil only)', async ({ page, walletMock }) => {
    test.skip(!onAnvil, 'ANVIL_RPC_URL unset — needs the fork job (npm run e2e)');

    await walletMock.connect();
    await page.goto('/swap');

    const amountInput = page.getByRole('spinbutton', { name: /amount of .* to pay/i });
    await amountInput.fill('0.01');

    // PRECONDITION, and this is the one leg a BARE fork satisfies: the ETH→
    // TOWELI direction needs only ETH, which anvil_setBalance provides at
    // bridge-install time, and the app reads through the fork. The other four
    // anvil legs need seeded token / NFT / reward state the fixture does not
    // create yet — each says so at its own assertion.
    const swap = page.getByRole('button', { name: /^swap$/i });
    await expect(
      swap,
      'swap CTA never enabled on a funded fork account — check that the fixture RPC redirect is in effect (the app reads through its own transports, not the wallet).',
    ).toBeEnabled({ timeout: 20_000 });
    await swap.click();

    // Receipt: a confirmation surfaces a link to THIS transaction.
    //
    // ⚠ This assertion used to be
    //     page.locator('a[href*="etherscan"], a[href*="explorer"]').first()
    // which is a false green. Measured on /swap with no wallet and no transaction:
    // one such link is already present and visible — the static TOWELI token link
    // (`etherscan.io/token/0x420698…`, "Etherscan ↗"). So the receipt leg asserted
    // nothing, which is why the whole spec finished in 4s against a mainnet fork.
    //
    // A tx receipt link points at /tx/0x<64 hex>. Scoping to that shape means the
    // assertion can only pass on a link that did not exist before the click.
    const receiptLink = page.locator('a[href*="/tx/0x"]');
    await expect(
      receiptLink.first(),
      'no explorer link to a transaction hash appeared after the swap — a receipt link must point at /tx/0x…, not at the static token link that is on the page before any swap',
    ).toBeVisible({ timeout: 30_000 });
    // Pin the shape too: a 66-char 0x-prefixed hash, so a placeholder href cannot pass.
    await expect(receiptLink.first()).toHaveAttribute('href', /\/tx\/0x[0-9a-fA-F]{64}/);
  });
});
