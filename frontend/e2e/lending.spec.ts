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
import { encodeFunctionData, keccak256, parseAbi, parseEther, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect, seededGondiOffer, anvilRpc } from './fixtures/wallet';
import { installLoanBook } from './fixtures/loanBook';
import { GONDI_LOAN_ADDRESS, ZERO_ADDRESS } from '../src/lib/gondi/loanOffer.js';
import { LOAN_REQUEST_TYPES, requestDomain, requestToMessage, type LoanRequestJson } from '../src/lib/gondi/loanRequest.js';

const onAnvil = !!process.env.ANVIL_RPC_URL;
const lendingLive = GONDI_LOAN_ADDRESS.toLowerCase() !== ZERO_ADDRESS;
const NOT_LIVE = 'GONDI_LOAN_ADDRESS is still zero: NFT lending is gated until the Gondi deploy (src/lib/gondi/loanOffer.js).';
const NAKAMIGOS = '0xd774557b647330C91Bf44cfEAB205095f7E6c367';

test.describe('NFT lending surface', () => {
  test('/nft-finance loads with NFT Lending and NFT AMM tabs', async ({ page, walletMock: _w }) => {
    await page.goto('/nft-finance');
    await expect(page.locator('h1')).toContainText(/NFT Finance/i);
    await expect(page.getByRole('tab', { name: /NFT Lending/i }).first()).toBeVisible();
    await expect(page.getByRole('tab', { name: /NFT AMM/i }).first()).toBeVisible();
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

  // Each stat tile's tooltip (the fee's says how the venue earns) must be drawn on top: an
  // overflow-hidden tile clipped its own bubble. Checked by elementFromPoint (jsdom has no
  // layout). Opened as each visitor opens it: a tap on touch, the pointer resting on it with a
  // mouse. Never a mouse click: once the hover has drawn the bubble, the click toggles it shut.
  test('each stat tile\'s explanation is drawn on top, not clipped by its tile', async ({ page, walletMock: _w, hasTouch }) => {
    test.skip(!lendingLive, NOT_LIVE);
    await page.goto('/nft-finance');
    const heading = page.getByRole('heading', { name: /^NFT Lending$/i });
    await expect(heading).toBeVisible();
    const more = page.getByRole('button', { name: 'More info' });
    for (let i = 0; i < 4; i++) {
      await more.nth(i).scrollIntoViewIfNeeded();
      if (hasTouch) await more.nth(i).tap();
      else await more.nth(i).hover();
      const tip = page.getByRole('tooltip');
      await expect(tip).toHaveCount(1);
      const onTop = await tip.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!hit && (hit === el || el.contains(hit));
      });
      expect(onTop, `tile ${i + 1}'s tooltip is drawn under something else, so it cannot be read`).toBe(true);
      // Closes it again: a second tap, or the pointer moving off it.
      if (hasTouch) await more.nth(i).tap();
      else await heading.hover();
      await expect(tip).toHaveCount(0);
    }
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
  // Another lender can take a loan over on Gondi's contract without the site (refinanceFull);
  // the book then holds the old id as "refinanced". My Loans must say it moved, not that it
  // closed, and offer no button on it. The screenshot is attached for the reviewer's read.
  test('a loan another lender took over reads "Moved" in My Loans', async ({ page, walletMock }) => {
    test.skip(!lendingLive, NOT_LIVE);
    const me = '0x71be63f3384f5fb98995898a86b02fb2426c5788';
    const now = Math.floor(Date.now() / 1000);
    const loan = {
      borrower: me,
      nftCollateralTokenId: '4103',
      nftCollateralAddress: '0xd37264c71e9af940e49795F0d3a8336afAaFDdA9',
      principalAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      principalAmount: '17400000000000000',
      startTime: String(now - 5 * 86_400),
      duration: String(30 * 86_400),
      tranche: [{ loanId: '1', floor: '0', principalAmount: '17400000000000000', lender: '0x4444444444444444444444444444444444444444', accruedInterest: '0', startTime: String(now - 5 * 86_400), aprBps: '1000' }],
      protocolFee: '500',
      lenderRefinanceDisabled: false,
    };
    await page.route('**/api/orderbook**', async (route) => {
      const action = new URL(route.request().url()).searchParams.get('action');
      if (action === 'loans') {
        return route.fulfill({
          json: { loans: [{ loanId: '1', loan, status: 'refinanced', emitTx: `0x${'1'.repeat(64)}`, closeTx: `0x${'2'.repeat(64)}` }], live: true },
        });
      }
      return route.fulfill({ json: { offers: [], count: 0, live: true } });
    });
    await walletMock.connect(me);
    await page.goto('/nft-finance');
    await page.getByRole('tab', { name: /^My Loans$/i }).click();
    const moved = page.getByTestId('loan-moved');
    await expect(moved).toBeVisible({ timeout: 20_000 });
    await expect(moved).toContainText('another lender took it over');
    await expect(page.getByText('Moved', { exact: true })).toBeVisible();
    await moved.scrollIntoViewIfNeeded();
    const shot = test.info().outputPath('my-loans-moved.png');
    await page.screenshot({ path: shot });
    await test.info().attach('my-loans-moved', { path: shot, contentType: 'image/png' });
  });

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
    // One button: it turns from "Approve NFT" into "Take Loan" only on a confirmed receipt
    // (or once getApproved reads back the loan contract), so Take Loan cannot be pressed early.
    const takeLoan = page.getByRole('button', { name: /^Take Loan$/ });
    await expect(takeLoan, 'the NFT approval never confirmed on the fork, so the borrow below could only revert.').toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: /^Approve NFT$/ })).toHaveCount(0);
    await takeLoan.click();

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

  test("a borrower's request reaches the Lend tab, and \"Offer this\" fills the offer (Anvil only)", async ({ page, walletMock }) => {
    test.skip(!onAnvil, 'ANVIL_RPC_URL unset — needs the fork job (npm run e2e)');
    test.skip(!lendingLive, NOT_LIVE);
    test.setTimeout(120_000);

    // A request is a signature, and the wallet mock cannot sign typed data for an impersonated
    // account, so the borrower is a key, and one Nakamigos is moved into its wallet on the fork.
    // The book then checks the signature and reads the holder on the fork, as it does on mainnet.
    // Ids 19,500 up: clear of the seeded offers' collateral (COLLATERAL_ID_BASE, wallet.ts).
    const borrower = privateKeyToAccount(keccak256(toBytes('tegridy e2e loan request borrower')));
    const tokenId = BigInt(19_500 + (process.pid % 400));
    const erc721 = parseAbi(['function ownerOf(uint256) view returns (address)', 'function transferFrom(address,address,uint256)']);
    const ownerOf = async () => {
      const raw = (await anvilRpc('eth_call', [
        { to: NAKAMIGOS, data: encodeFunctionData({ abi: erc721, functionName: 'ownerOf', args: [tokenId] }) },
        'latest',
      ])) as string;
      return `0x${raw.slice(-40)}`.toLowerCase();
    };
    expect(await anvilRpc('eth_getCode', [borrower.address, 'latest']), 'the borrower key has code on this fork').toBe('0x');
    const holder = await ownerOf();
    expect(holder, `Nakamigos #${tokenId} is live collateral: pick another id`).not.toBe(GONDI_LOAN_ADDRESS.toLowerCase());
    if (holder !== borrower.address.toLowerCase()) {
      await anvilRpc('anvil_setBalance', [holder, '0x8ac7230489e80000']);
      await anvilRpc('anvil_impersonateAccount', [holder]);
      await anvilRpc('eth_sendTransaction', [
        {
          from: holder,
          to: NAKAMIGOS,
          data: encodeFunctionData({ abi: erc721, functionName: 'transferFrom', args: [holder as `0x${string}`, borrower.address, tokenId] }),
        },
      ]);
      await anvilRpc('anvil_stopImpersonatingAccount', [holder]);
      await expect.poll(ownerOf, { message: 'the Nakamigos never reached the borrower on the fork', timeout: 20_000 }).toBe(borrower.address.toLowerCase());
    }

    const book = await installLoanBook(page, process.env.ANVIL_RPC_URL!);
    const request: LoanRequestJson = {
      borrower: borrower.address,
      nftCollateralAddress: NAKAMIGOS,
      nftCollateralTokenId: tokenId.toString(),
      principalAmount: parseEther('0.05').toString(),
      maxAprBps: '3000',
      duration: String(14 * 86_400),
      expirationTime: String(Math.floor(Date.now() / 1000) + 3 * 86_400),
      nonce: String(Date.now()),
    };
    const signature = await borrower.signTypedData({
      domain: requestDomain(),
      types: LOAN_REQUEST_TYPES as unknown as Record<string, { name: string; type: string }[]>,
      primaryType: 'LoanRequest',
      message: requestToMessage(request) as unknown as Record<string, unknown>,
    });
    const posted = await book.ask(request, signature);
    expect(posted.status, `the request book refused the request: ${JSON.stringify(posted.json)}`).toBe(201);

    const lender = await walletMock.useIsolatedForkAccount();
    await walletMock.connect(lender);
    await page.goto('/nft-finance');
    await page.getByRole('tab', { name: /NFT Lending/i }).first().click();
    await page.getByRole('button', { name: /Nakamigos/ }).first().click();

    const asking = page.getByTestId('borrower-requests');
    await expect(asking, 'the request never showed under "Borrowers asking".').toBeVisible({ timeout: 30_000 });
    await expect(asking.getByText(`NAKA #${tokenId}`)).toBeVisible();
    await asking.getByRole('button', { name: `Offer on NAKA #${tokenId}` }).click();
    await expect(page.getByRole('button', { name: 'One specific NFT' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('spinbutton', { name: 'Token ID' })).toHaveValue(tokenId.toString());
    await expect(page.getByRole('spinbutton', { name: 'Loan amount (WETH)' })).toHaveValue('0.05');
    await expect(page.getByRole('spinbutton', { name: 'APR (%)' })).toHaveValue('30');
  });
});
