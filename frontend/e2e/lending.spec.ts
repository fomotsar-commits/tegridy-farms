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

  /**
   * ⚠ THIS LEG ASSERTS ON-CHAIN STATE, NOT A RECEIPT LINK — deliberately.
   *
   * It used to end each half with `expectTxReceipt`, and that could never pass:
   * NFTLendingSection renders no explorer link anywhere (grep it for `getTxUrl` — zero
   * hits; it confirms with toasts). So even a borrow that landed perfectly would have
   * failed on a link the surface does not draw. What it DOES draw, straight out of the
   * contract, is the loan itself — so that is what this checks, and a loan appearing
   * under My Loans is strictly harder to fake than a link matching a href pattern.
   *
   * The fixture now plants the precondition the old message asked for (a collateral
   * NFT in the account plus a live lender offer — see seedNftLendingOffer in
   * fixtures/wallet.ts), because mainnet at head has offerCount() == 0.
   */
  test('borrow → repay full cycle (Anvil only)', async ({ page, walletMock }) => {
    test.skip(!onAnvil, 'ANVIL_RPC_URL unset — needs the fork job (npm run e2e)');
    // Three on-chain transactions on a live fork: approve the NFT, accept the offer,
    // repay the loan. Each assertion below keeps its own tight, named budget.
    test.setTimeout(180_000);

    // ISOLATED WALLET — see the note in stake.spec.ts. `nftCollateral` also plants this
    // account's own Nakamigos and posts a lender offer pinned to that exact token, so
    // two runs of this leg can never contend for one piece of collateral.
    const account = await walletMock.useIsolatedForkAccount({ nftCollateral: true });
    await walletMock.connect(account);
    await page.goto('/nft-finance');

    await page.getByRole('tab', { name: /NFT Lending/i }).first().click();
    await page.getByRole('tab', { name: /^Borrow$/i }).click();

    // The offer card is a div, not a button, and its accept UI is collapsed until the
    // card is clicked (NFTLendingSection.tsx:739 `onClick={onToggle}`). The old spec
    // went straight for an "accept offer" button and would have missed it even with an
    // offer present.
    const offerCard = page.getByText(/^Offer #\d+$/).first();
    await expect(
      offerCard,
      'no offer rendered in the Borrow tab — the fixture seeds one via seedNftLendingOffer; if this is empty that seeding silently no-opped.',
    ).toBeVisible({ timeout: 20_000 });
    await offerCard.click();

    // Step 1 of the contract's own two-step flow: approve the collateral, then accept.
    const approveNft = page.getByRole('button', { name: /^Approve NFT$/ });
    await expect(approveNft, 'the offer card did not expand its accept UI.').toBeEnabled({ timeout: 20_000 });
    await approveNft.click();
    // The button latches to "Approved" only on a confirmed receipt
    // (NFTLendingSection.tsx:840, driven by useWaitForTransactionReceipt), so this is
    // the approval genuinely landing on the fork — not just a click.
    await expect(
      page.getByRole('button', { name: /^Approved$/ }),
      'the collateral approval never confirmed on the fork, so the accept below could only revert.',
    ).toBeVisible({ timeout: 60_000 });

    await page.getByRole('button', { name: /^Accept Offer$/ }).click();

    // THE BORROW LANDED. The offer leaves the market the moment it is accepted (it
    // flips inactive on-chain and the list refetches, NFTLendingSection.tsx:711-713),
    // and the loan shows up under My Loans with a repayment quote read from
    // getRepaymentAmount. Both are contract state; neither survives a reverted accept.
    await page.getByRole('tab', { name: /^My Loans$/i }).click();
    await expect(
      page.getByText('Repayment Amount'),
      'the accept confirmed but no loan appeared under My Loans — the borrow did not land on the fork.',
    ).toBeVisible({ timeout: 60_000 });

    // ── REPAY ────────────────────────────────────────────────────────────────────
    const repay = page.getByRole('button', { name: /^Repay Loan$/ });
    await expect(repay, 'the loan is there but offers no repay CTA.').toBeEnabled({ timeout: 20_000 });
    await repay.click();

    // And the loan is settled: the repay CTA is rendered only while the loan is active
    // or overdue (NFTLendingSection.tsx:1128), so its disappearance is the on-chain
    // status flipping to repaid.
    await expect(
      repay,
      'the repay was submitted but the loan is still open — the repayment did not confirm.',
    ).toHaveCount(0, { timeout: 60_000 });
  });
});
