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
import { test, expect, expectTxReceipt, advancePastApproval } from './fixtures/wallet';

const onAnvil = !!process.env.ANVIL_RPC_URL;

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
    await cta.click();
    const addHash = await expectTxReceipt(page, 'add liquidity');

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
    await cta.click();
    // `notHash` matters here: this surface overwrites ONE receipt line, so without it
    // the add's link satisfies the remove's assertion and the burn need never happen.
    await expectTxReceipt(page, 'remove liquidity', addHash);

    // And the position is genuinely gone — the empty-state copy the app renders when
    // `hasLP` goes false (LiquidityTab.tsx:526).
    await expect(
      page.getByText("You don't hold any LP for this pair."),
      'the remove confirmed but the account still holds LP — the burn did not land.',
    ).toBeVisible({ timeout: 30_000 });
  });
});
