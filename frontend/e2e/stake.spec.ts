/**
 * AUDIT R081 — Stake / claim / unstake happy path (only h1 regex before).
 *
 * /farm hosts: TOWELI staking and LP farming. TOWELI staking v1 is closing (owner,
 * 2026-10-30): the site takes no new stakes into it, so the Anvil legs open their
 * position on the fork (openToweliStakeOnFork) and drive what the site still does
 * with one: show it, claim, and exit (an early exit here, the lock still running).
 *
 * Mock-mode covers UI structure (gate, inputs, CTAs). Anvil-mode covers the
 * full state-changing flow. See swap.spec.ts for why the anvil gate lives
 * INSIDE the test rather than in describe scope.
 */
import {
  test, expect, expectTxReceipt, anvilRpc, openToweliStakeOnFork,
  blindReceiptReads, expectMinedSuccessfully, expectUnconfirmedToast, forkTxCount, recordToasts,
} from './fixtures/wallet';
import { PENALTY_COPY } from '../src/lib/copy';

const onAnvil = !!process.env.ANVIL_RPC_URL;

/** 100 TOWELI for 90 days: a running lock, so the exit the card offers is the early one. */
const STAKE_WEI = 100n * 10n ** 18n;
const LOCK_90D = 90 * 86_400;

/** The early exit, opened and confirmed. Its confirm auto-dismisses after 5 s. */
async function earlyExit(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${PENALTY_COPY.earlyExitLabel} \\(25%\\)$`, 'i') }).click();
  await page.getByRole('button', { name: new RegExp(`^pay the ${PENALTY_COPY.earlyExitLabel}$`, 'i') }).click();
}

test.describe('Stake surface', () => {
  test('disconnected /farm shows the connect prompt', async ({ page, walletMock: _w }) => {
    await page.goto('/earn/toweli');
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
    await page.goto('/earn/toweli');
    await expect(page.locator('h1')).toContainText(/farm/i);
    await expect(page.getByRole('heading', { name: /toweli staking v1/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /lp farming/i })).toBeVisible();
    // The connect gate must be GONE — see the handshake note in swap.spec.ts.
    await expect(page.getByRole('region', { name: /wallet connection required/i })).toBeHidden();
    expect(pageErrors).toEqual([]);
  });

  test('v1 takes no new stakes: the card says why and has no amount field', async ({ page, walletMock }) => {
    await walletMock.connect();
    await page.goto('/earn/toweli');

    await expect(page.getByRole('heading', { name: /^beta is over$/i })).toBeVisible();
    await expect(page.getByTestId('staking-v1-closed')).toContainText(/takes no new stakes/i);
    await expect(page.getByRole('textbox', { name: /amount of toweli to stake/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(stake & lock|approve toweli)/i })).toHaveCount(0);
  });

  test('a v1 position shows Claim and its exit, and no way to add to it (Anvil only)', async ({ page, walletMock }) => {
    test.skip(!onAnvil, 'ANVIL_RPC_URL unset — needs the fork job (npm run e2e)');
    test.setTimeout(120_000);

    // ISOLATED WALLET. A position is exactly what breaks the /farm render specs (the
    // card swaps its closed line for "Your Position"), so this spends from an account
    // only this test uses.
    const account = await walletMock.useIsolatedForkAccount();
    await openToweliStakeOnFork(account, STAKE_WEI, LOCK_90D);
    await walletMock.connect(account);
    await page.goto('/earn/toweli');

    // The card's heading flips to "Your Position" on `pos.hasPosition`, read from the chain.
    await expect(
      page.getByRole('heading', { name: /^Your Position$/i }),
      'a position was opened on the fork but the staking card does not show it.',
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: /^beta is over$/i })).toBeVisible();

    // Claim and the exit stay; nothing that adds to a v1 position does.
    await expect(page.getByRole('button', { name: /^claim rewards$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: new RegExp(PENALTY_COPY.earlyExitLabel, 'i') })).toBeVisible();
    await expect(page.getByRole('button', { name: /extend lock/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /enable auto-max lock/i })).toHaveCount(0);
  });

  test('an exit whose receipt cannot be read is not reported as a failure (Anvil only)', async ({ page, walletMock }) => {
    test.skip(!onAnvil, 'ANVIL_RPC_URL unset — needs the fork job (npm run e2e)');
    // `useFarmActions` once said "Transaction failed" with no description for an
    // unreadable receipt. Telling someone their exit failed when it landed invites a
    // second one. This was the stake leg; the site takes no v1 stakes now, so it rides
    // the exit, which shares the same receipt path.
    test.setTimeout(180_000);

    const account = await walletMock.useIsolatedForkAccount();
    await openToweliStakeOnFork(account, STAKE_WEI, LOCK_90D);
    await walletMock.connect(account);
    await page.goto('/earn/toweli');
    await expect(page.getByRole('heading', { name: /^Your Position$/i })).toBeVisible({ timeout: 30_000 });

    const blind = await blindReceiptReads(page);
    const toasts = await recordToasts(page);
    const sent = forkTxCount(page);
    await earlyExit(page);

    // FIRST, WHAT HAPPENED ON CHAIN: the exit succeeded. Read off the node, not the DOM.
    const hash = await expectMinedSuccessfully(page, 'early exit', sent);
    await expect
      .poll(() => blind.receiptsAskedFor().map((h) => h.toLowerCase()).includes(hash), {
        timeout: 30_000,
        message: 'the app never asked for THIS transaction\'s receipt, so nothing was blinded and this leg proves nothing.',
      })
      .toBe(true);

    await expectUnconfirmedToast(page, toasts, 'early exit with an unreadable receipt');

    // And the exit really did land: the position is gone, read through reads that were
    // never blinded, and the card is back to the closed line.
    await expect(
      page.getByRole('heading', { name: /toweli staking v1/i }),
      'the exit was mined successfully but the card still shows a position — ' +
        'then the transaction under test was not the exit.',
    ).toBeVisible({ timeout: 60_000 });
  });

  test('an exit receipt shares as the receipt, with its card image on the clipboard (Anvil only)', async ({ page, walletMock, context }) => {
    test.skip(!onAnvil, 'ANVIL_RPC_URL unset — needs the fork job (npm run e2e)');
    // The card image is drawn by html2canvas in a REAL browser, which no unit test can
    // run: jsdom has no canvas and computes no Tailwind CSS. html2canvas 1.4 threw on
    // the oklab()/lab() colors Tailwind v4 computes for the status badge, so the image
    // never rendered and Copy Image quietly fell back to text. This leg is the only
    // place that failure shows.
    test.setTimeout(150_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    // The X window is answered locally: this leg reads what was sent, not x.com.
    // Anchored to the exact intent the receipt opens (CodeQL js/regex/missing-regexp-anchor).
    const intents: string[] = [];
    await context.route(/^https:\/\/twitter\.com\/intent\/tweet\?/, (route) => {
      intents.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>x</title>' });
    });

    // This was the stake receipt; the site takes no v1 stakes now, so it is the exit's.
    const account = await walletMock.useIsolatedForkAccount();
    await openToweliStakeOnFork(account, STAKE_WEI, LOCK_90D);
    await walletMock.connect(account);
    await page.goto('/earn/toweli');
    await expect(page.getByRole('heading', { name: /^Your Position$/i })).toBeVisible({ timeout: 30_000 });
    await earlyExit(page);
    await expectTxReceipt(page, 'early exit');

    // The receipt waits for two confirmations; the fork mines only on a transaction.
    const receipt = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: /share to x/i }) });
    await anvilRpc('evm_mine');
    await anvilRpc('evm_mine');
    await expect(receipt.getByText('Confirmed', { exact: true })).toBeVisible({ timeout: 30_000 });

    await receipt.getByRole('button', { name: /share to x/i }).click();
    await expect.poll(() => intents.length, { timeout: 15_000, message: 'Share to X opened no X window' }).toBeGreaterThan(0);
    const text = new URL(intents[0] ?? '').searchParams.get('text') ?? '';
    expect(text).toContain('MEMETICS.FINANCE');
    // What came BACK, read off the EarlyWithdrawn log: 100 staked, 25 to the treasury.
    expect(text).toMatch(/^Withdrawn: 75\.0000 TOWELI$/m);
    expect(text).toMatch(/^Tx: https?:\/\/\S+\/tx\/0x[0-9a-f]{64}$/m);
    // The mention and the room's tag close the post; /earn/toweli is the TOWELI room.
    expect(text.split('\n').at(-1)).toBe('@JungleBayAC #TOWELI');

    await expect(
      receipt.getByTestId('receipt-share-hint'),
      'the card image did not reach the clipboard: the render failed in a real browser',
    ).toContainText(/Receipt image copied/i, { timeout: 15_000 });
    const types = await page.evaluate(async () => (await navigator.clipboard.read()).flatMap((i) => i.types));
    expect(types).toContain('image/png');
  });
});
