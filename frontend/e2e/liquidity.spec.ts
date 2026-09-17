/**
 * AUDIT R081 — Liquidity add/remove happy path (zero coverage before).
 *
 * /liquidity IS A PAGE as of 2026-09-05 — the landing tab of the Pools section
 * (PoolsHostPage), beside the venue's Solana AMM and Zap. It was a path alias
 * that rendered the SWAP host, which then opened TradePage's own inner
 * `?tab=liquidity`; providing liquidity was the second of six tabs on the
 * trading page. The FORM is unchanged — the same LiquidityTab, the same router,
 * the same cascade — so every assertion below still holds; only the tab name and
 * the panel it lives in moved.
 *
 * This spec covers:
 *   - Mock-mode: tab activation, deposit/withdraw inputs render, CTAs are
 *     coherent.
 *   - Anvil-mode (ANVIL_RPC_URL set): full add → remove cycle against the fork.
 *
 * Wallet fixture: e2e/fixtures/wallet.ts. See swap.spec.ts for why the anvil
 * gate lives INSIDE the test that needs it rather than in describe scope.
 */
import {
  test, expect, expectTxReceipt, advancePastApproval, expectMinedSuccessfully, forkTxCount, forkTxHash,
  anvilRpc, blindReceiptReads, expectUnconfirmedToast, expectRevertToast, recordToasts, starveNextSend,
  type WalletMock,
} from './fixtures/wallet';
import type { Locator, Page } from '@playwright/test';
import { ROUTE_MOUNT_TIMEOUT } from './fixtures/routes';

const onAnvil = !!process.env.ANVIL_RPC_URL;

// The swap page's two lazy chunks — the Swap section host and TradePage itself.
// Vite names a lazy chunk after its module: `assets/TradePage-<hash>.js`.
const SWAP_PAGE_CHUNKS = /\/assets\/Trade(?:Host)?Page-[\w-]+\.js$/;

test.describe('Liquidity surface', () => {
  test('disconnected /liquidity renders the page with title and gate', async ({ page, walletMock: _w }) => {
    await page.goto('/liquidity');
    // The page's own <h1>, not a tab-derived title.
    await expect(page.locator('h1')).toContainText(/liquidity/i);
    // The Pools strip's landing tab. Named "Add / Remove" rather than
    // "Liquidity", because on a page already headed "Liquidity" a tab repeating
    // the word says nothing about what distinguishes it from its siblings.
    await expect(page.getByRole('tab', { name: 'Add / Remove', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: /connect wallet/i }).first()).toBeVisible();
  });

  test('the swap page no longer carries its own Liquidity tab', async ({ page, walletMock: _w }) => {
    // It carried one until 2026-09-06, rendering the SAME <LiquidityTab /> this
    // page renders — the identical form on two routes. Owner call: remove it
    // from /swap, where it was one of six order-type tabs and had nothing to do
    // with the other five, and leave it here where the section is Pools.
    await page.goto('/swap');
    await expect(page.getByRole('tab', { name: 'Swap', exact: true })).toBeVisible();
    await expect(
      page.getByRole('tab', { name: 'Liquidity', exact: true }),
      'the swap page is showing a Liquidity tab again — the form lives on /liquidity',
    ).toHaveCount(0);
  });

  test('an old ?tab=liquidity link lands on the page the form moved to', async ({ page, walletMock: _w }) => {
    // Links shared while the tab lived on /swap still exist. An unknown tab
    // resolves to 'swap', so without this they would silently land on the wrong
    // surface — which looks like the feature was deleted rather than moved.
    //
    // ⚠ AND WITHOUT THE SWAP PAGE. The redirect used to run in an effect inside
    // TradePage, so following the link meant fetching the swap host, then
    // TradePage's own chunk, rendering the whole swap page, and only then
    // fetching this one — four serial chunk loads inside the heading's 5s where a
    // direct /liquidity visit has two. That is what flaked under load
    // (2026-09-10). App.tsx answers the link now, and holding the swap chunks
    // open is what pins it: if the redirect ever needs them again it cannot
    // happen at all, so this fails on every run rather than on a slow one.
    const swapChunks: string[] = [];
    await page.route(SWAP_PAGE_CHUNKS, (route) => {
      swapChunks.push(route.request().url()); // …and never answered
    });

    await page.goto('/swap?tab=liquidity');
    // The PATH. This was `toHaveURL(/liquidity$/)`, which the starting url
    // `…/swap?tab=liquidity` satisfies too: it passed before any redirect ran in
    // 48 of 50 measured runs, so the line asserted nothing.
    await expect(page, 'the old link never left /swap — the redirect is waiting on the swap page').toHaveURL(
      (url) => url.pathname === '/liquidity',
    );
    await expect(page.locator('h1')).toContainText(/liquidity/i);
    expect(swapChunks, 'the old link fetched the swap page on its way to /liquidity').toEqual([]);

    // CONTROL: the pattern really does name the swap page. Were a rename or a
    // chunk-naming change to stop it matching, the hold above would be a no-op
    // and this test would pass whether or not the redirect waits.
    await page.goto('/swap', { waitUntil: 'commit' });
    await expect
      .poll(() => swapChunks.length, {
        message: `${SWAP_PAGE_CHUNKS} matched no request on /swap — it no longer names the swap page's chunks`,
        timeout: ROUTE_MOUNT_TIMEOUT,
      })
      .toBeGreaterThan(0);
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
    // Four on-chain transactions on a live fork — approve TOWELI, addLiquidity,
    // approve LP, removeLiquidity — plus the allowance refetch between each pair.
    // The per-assertion budgets below stay tight and named, so a genuine hang still
    // fails at the step that hung; this only stops the TEST budget from cutting the
    // cycle off before the assertions get to speak.
    test.setTimeout(180_000);

    // ISOLATED WALLET — see the note in stake.spec.ts. This leg mints and burns LP and
    // leaves a router allowance behind; neither may land on the wallet the render specs
    // read.
    const account = await walletMock.useIsolatedForkAccount();
    await walletMock.connect(account);
    await page.goto('/liquidity');

    const panel = page.getByRole('tabpanel', { name: 'Add / Remove' });

    // ⚠ THE SUBMIT CTA CANNOT BE FOUND BY NAME ON THIS SURFACE, and that is what broke
    // this test — not the fork. LiquidityTab gives the mode toggles the SAME accessible
    // names as the submit buttons they switch to ("Grow the Crop" / "Pull Crop Out",
    // LiquidityTab.tsx:250 and :255 vs :453 and :543).
    //
    // This used to be `panel.locator('button:not([aria-pressed])').last()`, which
    // resolved correctly but POSITIONALLY: appending any button to the panel would have
    // silently retargeted the submit and this spec would have gone on passing against
    // the wrong control. All five cascade actions now carry `data-testid`, so the
    // locator names what it means. Exactly one is mounted at a time.
    const cta = panel.getByTestId('liquidity-submit');

    // ── ADD ──────────────────────────────────────────────────────────────────────
    // WAIT FOR THE POOL READ BEFORE TYPING, and this is load-bearing. Token B is
    // auto-paired from the reserves inside the input's own onChange
    // (LiquidityTab.tsx:143-146) — it is computed ONCE, at the keystroke, and never
    // recomputed. Type before the fork read lands and B stays permanently empty, which
    // reads on the page exactly like an add that the app refused. This block renders
    // only once `pairExists && !isEmptyPool` (LiquidityTab.tsx:365), so it IS the
    // "reserves are known" signal.
    await expect(
      page.getByText('Your share of the pool'),
      'the pair never read back from the fork — without reserves the app cannot quote the paired side, and nothing below would be testing an add.',
    ).toBeVisible({ timeout: 20_000 });

    // Token A is native ETH, so it needs no approval; the paired TOWELI does.
    // 0.001 ETH is deliberately small: the live pair holds ~0.08 WETH against ~2.8M
    // TOWELI, so an 0.05 ETH add would demand ~1.7M TOWELI and the fixture seeds
    // 1,000,000 — the CTA would honestly read "Not enough TOWELI" and this leg would
    // fail on a funding gap rather than on the flow it exists to cover.
    const inputs = page.getByRole('spinbutton', { name: '0.0' });
    await inputs.first().fill('0.001');
    await expect(
      inputs.nth(1),
      'the pool did not auto-pair Token B from its reserves — the add cannot be quoted, so nothing below is testing an add.',
    ).not.toHaveValue('', { timeout: 20_000 });

    // ⚠ THE ADD USED TO BE AN APPROVE. The old locator was
    //     /(supply|add liquidity|deposit|approve)/i
    // and this app labels its add submit "Grow the Crop" — a phrase that regex cannot
    // match. So on a COLD fork the only match was "Approve TOWELI": the spec clicked
    // the approval, `expectTxReceipt` was satisfied by the APPROVAL's receipt, no
    // liquidity was ever added, and the remove side below correctly rendered nothing
    // (it gates on `hasLP`). That is the 6.5s first attempt in CI run 32598383834. On a
    // WARM fork the allowance is already set, the CTA reads "Grow the Crop", the regex
    // matches NOTHING at all, and the 20s `toBeEnabled` guard fires — that is the 22.4s
    // and 21.9s retries. One cause, all three durations.
    await advancePastApproval(cta, /^Grow the Crop$/, 'add liquidity');
    // ASK THE CHAIN, THEN THE PAGE. `expectMinedSuccessfully` reads this click's own
    // transaction off the node, so a revert fails HERE, under a message that says so,
    // instead of surfacing later as a missing or stale link. The receipt check then demands
    // the link for THAT hash: this card also renders a receipt for the TOWELI approval just
    // sent, and that link must not stand in for the add.
    const addSent = forkTxCount(page);
    await cta.click();
    const addHash = await expectMinedSuccessfully(page, 'add liquidity', addSent);
    await expectTxReceipt(page, 'add liquidity', { hash: addHash });

    // THE ADD MUST HAVE MINTED LP. A receipt alone does not prove that — an approval
    // has one too. This banner renders only when `hasLP` is true, i.e. the on-chain LP
    // balance is above zero (LiquidityTab.tsx:268), so it is the state assertion the
    // old spec was missing entirely.
    await expect(
      page.getByText('Your liquidity is safe'),
      'a transaction confirmed but the account still holds no LP — whatever was sent, it was not an add.',
    ).toBeVisible({ timeout: 30_000 });

    // ── REMOVE ───────────────────────────────────────────────────────────────────
    // The mode toggle, not the submit: in add mode "Pull Crop Out" is unambiguous.
    await page.getByRole('button', { name: 'Pull Crop Out', exact: true }).click();
    // The burn is gated on the percentage slider — at 0% the CTA reads "Move the
    // slider" and stays disabled (LiquidityTab.tsx:538-542). Take the whole position.
    await panel.getByRole('button', { name: '100%' }).click();

    await advancePastApproval(cta, /^Pull Crop Out$/, 'remove liquidity');
    const removeSent = forkTxCount(page);
    await cta.click();
    // ⚠ THIS IS THE LEG THAT FLAKED. It failed in CI in three shapes — the empty-state
    // assertion below timing out, `expectTxReceipt` finding no link, and a 3.0m test
    // timeout inside `expectTxReceipt` — and all three are what a burn that REVERTED looks
    // like from the DOM. The revert mechanism is gas; see `bufferGas` in the fixture.
    //
    // This line used to pass `addHash` as `notHash`, and that could not guard it: it bars
    // the ADD's link, while the link on the card at the moment of this click is the LP
    // APPROVAL's — a third hash. So a burn that never landed passed here on the approval's
    // receipt and failed thirty seconds later below, as "the burn did not land". The exact
    // hash the click sent is what closes that.
    const removeHash = await expectMinedSuccessfully(page, 'remove liquidity', removeSent);
    await expectTxReceipt(page, 'remove liquidity', { hash: removeHash });

    // And the position is genuinely gone — the empty-state copy the app renders when
    // `hasLP` goes false (LiquidityTab.tsx:526).
    await expect(
      page.getByText("You don't hold any LP for this pair."),
      'the remove confirmed but the account still holds LP — the burn did not land.',
    ).toBeVisible({ timeout: 30_000 });
  });

  // ── A RECEIPT THE APP CANNOT READ vs A TRANSACTION THAT REVERTED ──────────────────
  // wagmi reports BOTH on `useWaitForTransactionReceipt().isError`: it THROWS on a
  // reverted receipt, and it errors when the receipt read fails. They need opposite
  // advice, so these two legs pin each one against the real app on the fork. Pre-fix
  // trunk toasted "Transaction failed" for both; the first port of the unreadable fix
  // told the revert it "may well have succeeded". Each leg fails on one of those.

  /** Connect a fresh fork account on /liquidity with an add quoted and its approval done. */
  async function readyAnAdd(page: Page, walletMock: WalletMock): Promise<Locator> {
    const account = await walletMock.useIsolatedForkAccount();
    await walletMock.connect(account);
    await page.goto('/liquidity');
    const panel = page.getByRole('tabpanel', { name: 'Add / Remove' });
    const cta = panel.getByTestId('liquidity-submit');
    await expect(
      page.getByText('Your share of the pool'),
      'the pair never read back from the fork — see the add → remove leg above.',
    ).toBeVisible({ timeout: 20_000 });
    const inputs = page.getByRole('spinbutton', { name: '0.0' });
    await inputs.first().fill('0.001');
    await expect(
      inputs.nth(1),
      'the pool did not auto-pair Token B from its reserves — see the add → remove leg above.',
    ).not.toHaveValue('', { timeout: 20_000 });
    // The approval confirms while receipts still work: these legs are about the ADD.
    await advancePastApproval(cta, /^Grow the Crop$/, 'add liquidity');
    return cta;
  }

  test('an add whose receipt cannot be read is not reported as a failure (Anvil only)', async ({ page, walletMock }) => {
    test.skip(!onAnvil, 'ANVIL_RPC_URL unset — needs the fork job (npm run e2e)');
    // Measured 2026-09-10: an addLiquidityETH that was MINED AND SUCCESSFUL reported a
    // bare "Transaction failed" after viem exhausted its retries against a node
    // answering `{result: null}`. "Failed" is an instruction to resend, and a resent
    // add deposits the pair a second time. `blindReceiptReads` reproduces that; see its
    // comment in fixtures/wallet.ts for why the transaction still lands.
    test.setTimeout(240_000);
    const cta = await readyAnAdd(page, walletMock);

    const blind = await blindReceiptReads(page);
    // Start the transcript BEFORE the click — the pre-fix toast lives ~4s and a
    // locator sampled afterwards cannot see it. See recordToasts.
    const toasts = await recordToasts(page);
    const sent = forkTxCount(page);
    await cta.click();

    // FIRST, WHAT HAPPENED ON CHAIN: the add succeeded. Without this the leg would pass
    // just as happily against a genuinely broken add.
    const addHash = await expectMinedSuccessfully(page, 'add liquidity', sent);
    await expect
      .poll(() => blind.receiptsAskedFor().map((h) => h.toLowerCase()).includes(addHash), {
        timeout: 30_000,
        message: 'the app never asked for THIS add\'s receipt, so nothing was blinded and this leg proves nothing.',
      })
      .toBe(true);

    // THEN, WHAT THE USER WAS TOLD: not silence, not a verdict — that we cannot tell.
    await expectUnconfirmedToast(page, toasts, 'add liquidity with an unreadable receipt');

    // And the LP really is there, reached through reads that were never blinded.
    await expect(
      page.getByText('Your liquidity is safe'),
      'the add was mined successfully but the account holds no LP — then the transaction ' +
        'under test was not an add, and the toast assertion above was about the wrong thing.',
    ).toBeVisible({ timeout: 60_000 });
  });

  test('an add that genuinely reverts says it reverted, not that it is unconfirmed (Anvil only)', async ({ page, walletMock }) => {
    test.skip(!onAnvil, 'ANVIL_RPC_URL unset — needs the fork job (npm run e2e)');
    test.setTimeout(180_000);
    const cta = await readyAnAdd(page, walletMock);

    const toasts = await recordToasts(page);
    // ~60k gas clears addLiquidityETH's intrinsic cost and runs out mid-execution: a
    // real mined revert, and one wagmi's replay reproduces (it reuses the tx's gas).
    starveNextSend(page, 60_000n);
    const sent = forkTxCount(page);
    await cta.click();

    // FIRST, WHAT HAPPENED ON CHAIN: it reverted. Read off the node, never inferred.
    let hash = '';
    await expect
      .poll(async () => {
        const tx = forkTxHash(page, sent);
        if (!tx) return 'NOT SENT';
        hash = tx;
        const r = (await anvilRpc('eth_getTransactionReceipt', [tx])) as { status: string } | null;
        return r ? r.status : 'NOT MINED';
      }, {
        timeout: 30_000,
        message: 'the starved add never mined as a revert — without a real revert this leg measures nothing.',
      })
      .toBe('0x0');
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/i);

    // THEN, WHAT THE USER WAS TOLD.
    await expectRevertToast(page, toasts, 'add liquidity that reverted on-chain');
  });
});
