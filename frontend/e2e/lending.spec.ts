/**
 * AUDIT R081 — NFT lending borrow / repay happy path.
 *
 * Since 2026-10-27 NFT lending runs on Gondi's own v3.2 loan contract
 * (contracts/vendor/gondi-v3.2; src/lib/gondi). A lender's offer is a signature kept in
 * the offer book, not an on-chain deposit, and the tab stays gated ("isn't live yet")
 * until GONDI_LOAN_ADDRESS holds the deployed address. So:
 *
 *   - before the deploy, these specs assert the gated tab, honestly;
 *   - after it, they drive the real flow, and the Anvil leg runs a whole borrow → repay
 *     cycle on the fork against the deployed contract, with the REAL offer-book handler
 *     served through page.route (fixtures/loanBook.ts).
 *
 * Mock-mode: confirms the surface mounts and its tabs wire correctly.
 * Anvil-mode: drives a borrow → repay cycle against the fork. See swap.spec.ts for why
 * the anvil gate lives INSIDE the test that needs it.
 */
import { test, expect, seededGondiOffer, anvilRpc } from './fixtures/wallet';
import { installLoanBook } from './fixtures/loanBook';
import { GONDI_LOAN_ADDRESS, ZERO_ADDRESS } from '../src/lib/gondi/loanOffer.js';

const onAnvil = !!process.env.ANVIL_RPC_URL;
const lendingLive = GONDI_LOAN_ADDRESS.toLowerCase() !== ZERO_ADDRESS;
const NOT_LIVE = 'GONDI_LOAN_ADDRESS is still zero: NFT lending is gated until the Gondi deploy (src/lib/gondi/loanOffer.js).';
const NAKAMIGOS = '0xd774557b647330C91Bf44cfEAB205095f7E6c367';

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
    if (lendingLive) {
      await expect(page.getByRole('heading', { name: /^NFT Lending$/i })).toBeVisible();
    } else {
      // Before the deploy the tab must say so, not render a lending form that cannot send.
      await page.getByRole('tab', { name: /NFT Lending/i }).first().click();
      await expect(page.getByText(/NFT lending isn.t live yet/i)).toBeVisible();
    }
    expect(pageErrors).toEqual([]);
  });

  test('lend / borrow / my-loans sub-tabs switch', async ({ page, walletMock }) => {
    test.skip(!lendingLive, NOT_LIVE);
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
   * ⚠ THIS LEG ASSERTS ON-CHAIN STATE, NOT A RECEIPT LINK — deliberately. The surface
   * confirms with toasts; what it draws straight from the chain is the loan itself, and
   * the NFT's owner. Both are strictly harder to fake than a link.
   *
   * The fixture plants the precondition mainnet does not have (a Nakamigos in this
   * account, and a lender with approved WETH who has signed a whole-collection offer),
   * and the spec posts that offer through the book's own create action, which checks
   * the signature and the lender's WETH against the fork.
   */
  test('borrow → repay full cycle (Anvil only)', async ({ page, walletMock }) => {
    test.skip(!onAnvil, 'ANVIL_RPC_URL unset — needs the fork job (npm run e2e)');
    test.skip(!lendingLive, NOT_LIVE);
    // Five on-chain transactions on a live fork: approve the NFT, take the loan, wrap the
    // interest, approve the WETH, repay. Each assertion keeps its own named budget.
    test.setTimeout(240_000);

    // ISOLATED WALLET — see the note in stake.spec.ts.
    const account = await walletMock.useIsolatedForkAccount({ nftCollateral: true });
    const seed = seededGondiOffer(account);
    if (!seed) throw new Error('the fixture planted no Gondi offer for this account');
    const book = await installLoanBook(page, process.env.ANVIL_RPC_URL!);
    const created = await book.create(seed.offer, seed.signature);
    expect(created.status, `the offer book refused the seeded offer: ${JSON.stringify(created.json)}`).toBe(201);

    await walletMock.connect(account);
    await page.goto('/nft-finance');
    await page.getByRole('tab', { name: /NFT Lending/i }).first().click();
    await page.getByRole('tab', { name: /^Borrow$/i }).click();

    // A whole-collection offer: the card names the collection, and the borrower picks
    // which of their NFTs to lock.
    const offerCard = page.getByText('NAKA · any NFT').first();
    await expect(offerCard, 'the seeded offer did not render as a live offer in the Borrow tab.').toBeVisible({ timeout: 30_000 });
    await offerCard.click();
    await page.getByRole('spinbutton', { name: /Your NAKA to lock/ }).fill(seed.tokenId.toString());
    await expect(page.getByText(`You own NAKA #${seed.tokenId}.`)).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: /^Approve NFT$/ }).click();
    // Latches to "Approved" only on a confirmed receipt.
    await expect(
      page.getByRole('button', { name: /^Approved$/ }),
      'the NFT approval never confirmed on the fork, so the borrow below could only revert.',
    ).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: /^Take Loan$/ }).click();

    // THE BORROW LANDED: the NFT is in the loan contract (read from the fork), and the
    // loan shows under My Loans, recorded from the borrow's own receipt and matched
    // against getLoanHash before it shows a repay button.
    await expect
      .poll(
        async () => {
          const owner = (await anvilRpc('eth_call', [
            { to: NAKAMIGOS, data: `0x6352211e${seed.tokenId.toString(16).padStart(64, '0')}` },
            'latest',
          ])) as string;
          return `0x${owner.slice(-40)}`.toLowerCase();
        },
        { message: 'the borrow did not lock the NFT in the loan contract', timeout: 60_000 },
      )
      .toBe(GONDI_LOAN_ADDRESS.toLowerCase());
    await page.getByRole('tab', { name: /^My Loans$/i }).click();
    await expect(page.getByText('To repay now'), 'the loan never appeared under My Loans.').toBeVisible({ timeout: 60_000 });

    // ── REPAY: wrap the interest, approve, repay ─────────────────────────────────
    const step = page.getByRole('button', { name: /^(Wrap .* ETH to WETH|Approve WETH to repay|Repay Loan)$/ });
    for (let i = 0; i < 3; i++) {
      await expect(step).toBeEnabled({ timeout: 60_000 });
      const label = (await step.textContent()) ?? '';
      await step.click();
      if (label === 'Repay Loan') break;
      await expect(step, `the "${label}" step never confirmed`).not.toHaveText(label, { timeout: 60_000 });
    }

    // Not the button's disappearance (its name changes the instant it is clicked): the
    // chain. The badge reads "Repaid" only from the repay's own LoanRepaid event, and the
    // NFT is back in the borrower's wallet.
    await expect(
      page.getByText('Repaid', { exact: true }),
      'the repay was submitted but the loan never read back as repaid.',
    ).toBeVisible({ timeout: 60_000 });
    const back = (await anvilRpc('eth_call', [
      { to: NAKAMIGOS, data: `0x6352211e${seed.tokenId.toString(16).padStart(64, '0')}` },
      'latest',
    ])) as string;
    expect(`0x${back.slice(-40)}`.toLowerCase(), 'the repay confirmed but the NFT did not come back').toBe(account.toLowerCase());
  });
});
