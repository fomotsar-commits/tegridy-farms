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
import { test, expect, expectTxReceipt, advancePastApproval } from './fixtures/wallet';

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
    // Two on-chain transactions on a live fork (approve TOWELI, then the stake), with
    // an allowance refetch between them. Every assertion below keeps its own tight,
    // named budget — this only stops the TEST budget from cutting the pair short.
    test.setTimeout(120_000);

    // ISOLATED WALLET. This leg opens a real staking position on the shared fork, and
    // a position is exactly what breaks the /farm render specs: StakingCard swaps its
    // amount input for a "Your Position" panel, so a later `fill()` has nothing to type
    // into. Measured — batching the money specs, this spend turned three previously
    // green tests red. Spending from an account only this test uses ends that.
    const account = await walletMock.useIsolatedForkAccount();
    await walletMock.connect(account);
    await page.goto('/farm');

    // 1. Stake
    const amount = page.getByRole('textbox', { name: /amount of toweli to stake/i });
    await amount.fill('100');

    // Approve first if the allowance path demands it; the CTA carries the verb.
    //
    // SCOPED TO THE CARD WE JUST FILLED, and that is load-bearing. /farm renders more
    // than one staking surface, and a bare `getByRole('button', {name: /^stake/i})
    // .first()` matched a DISABLED "Stake" on a different card while this card's real
    // CTA — "Stake & Lock for 90 Days" — sat enabled right next to the input. The test
    // then failed claiming the account held no TOWELI, when the card was showing
    // "Balance: 1000000" at the time.
    //
    // Deliberately NOT "pick whichever button is enabled": that would go green on any
    // future page where the right CTA is disabled and some other one is not. Walk up to
    // the card that owns this input and take its submit CTA — the last matching verb
    // inside it, after the lock-duration buttons.
    //
    // The fork precondition this used to fail on is now handled: the fixture seeds a
    // TOWELI balance via anvil_setStorageAt on the discovered balanceOf slot.
    const stakeCard = amount.locator('xpath=ancestor::div[contains(@class,"glass-card")][1]');
    const cta = stakeCard.getByRole('button', { name: /^(approve|stake)/i }).last();

    // ⚠ THIS TEST NEVER STAKED ON A COLD FORK, and the missing fixture was never the
    // reason — the card shows "Balance: 1000000", so seedErc20Balance works. What it
    // did was click ONCE. This is a single self-relabelling button (StakingCard.tsx:
    // 469-477): "Approve TOWELI" while the allowance is short, "Stake & Lock for …"
    // after. Cold, that one click was the APPROVAL — and FarmPage deliberately shows
    // no receipt for an approve (the F95 tag at FarmPage.tsx:183, so a stake receipt is
    // never fabricated). So `expectTxReceipt` waited out its full budget for a stake
    // that was never sent: the 30.0s in CI run 32598383834. Retry #1 then passed in
    // 3.6s because attempt 0's allowance survived on the fork and the CTA already read
    // "Stake & Lock" — the green retry was the accident, not the red first attempt.
    //
    // Walking the cascade is what makes the click below the STAKE, every time, cold or
    // warm. Do not collapse it back to one click.
    await advancePastApproval(cta, /^Stake & Lock for /, 'stake');
    await cta.click();
    await expectTxReceipt(page, 'stake');

    // AND THE STAKE LANDED. A receipt proves a transaction confirmed, not which one;
    // the position row is the on-chain state only a real stake can produce.
    // The card's own heading flips from "Stake TOWELI" to "Your Position" on
    // `pos.hasPosition` (StakingCard.tsx:103-104), which is read from the chain.
    await expect(
      page.getByRole('heading', { name: /^Your Position$/i }),
      'the stake confirmed but the staking card still offers to open a position — whatever was sent, it was not a stake.',
    ).toBeVisible({ timeout: 30_000 });

    // 2. Claim — needs accrued rewards; on a fresh fork rewards may be 0,
    // so we just assert the button is wired (not necessarily enabled).
    await expect(page.getByRole('button', { name: /claim/i }).first()).toBeVisible();

    // 3. Unstake — cooldown gate may block (see TF-02). Confirm the CTA wires
    // a tx (or surfaces the cooldown copy).
    await expect(page.getByRole('button', { name: /unstake|withdraw|exit/i }).first()).toBeVisible();
  });
});
