// What the page tells a person when things do not go to plan. The rule this repo paid
// for: failing to CONFIRM a transaction is not the transaction failing. Saying "failed"
// about a transaction that landed makes people pay twice.
//
// The launches here are made from Node with the frontend's own curve/ix.ts and carry no
// metadata (how a launch made outside this site looks); the page under test only trades.
import { test, expect, type Browser } from '@playwright/test';
import type { Keypair, PublicKey } from '@solana/web3.js';
import { ata, buyDirect, createLaunchDirect, fundedKeypair, lamports, landedTx, sol, tokenAmount } from './fixtures/chain';
import { installTestWallet } from './fixtures/testWallet';
import { installRpcGuard } from './fixtures/rpcGuard';
import { installUploadStub } from './fixtures/uploadStub';
import { ui, checkAtSizes, clickReal, connectWallet } from './fixtures/ui';

async function trader(browser: Browser, kp: Keypair) {
  const ctx = await browser.newContext();
  const wallet = await installTestWallet(ctx, kp);
  const rpc = await installRpcGuard(ctx);
  await installUploadStub(ctx);
  const page = await ctx.newPage();
  return { ctx, wallet, rpc, page };
}

let mint: PublicKey;
test.beforeAll(async () => {
  const creator = await fundedKeypair(1);
  mint = await createLaunchDirect(creator);
});

test('a confirmation we could not read is "sent, not confirmed yet", never "failed"; Check again settles it', async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const kp = await fundedKeypair(2);
  const t = await trader(browser, kp);
  await t.page.goto(`/curve-launch/${mint.toBase58()}`);
  await connectWallet(t.page, ui.tradePanel(t.page));
  await clickReal(ui.trade.side(t.page, 'buy'), 'buy');
  await ui.trade.amount(t.page, 'buy').fill('0.02');
  await clickReal(ui.trade.reviewButton(t.page, 'buy'), 'Review buy');
  await expect(ui.review(t.page)).toBeVisible({ timeout: 60_000 });

  // From the moment it is signed, every status read fails (HTTP 500) until released.
  // Long enough to outlast the blockhash window, so the page must give its final answer
  // while it still cannot read a status.
  t.rpc.fail('getSignatureStatuses', 500, 10 * 60_000);
  await clickReal(ui.signButton(t.page), 'Sign in wallet');
  const out = ui.outcome(t.page);
  await expect(out).toBeVisible({ timeout: 5 * 60_000 });
  await expect(out).toHaveAttribute('data-status', 'unknown');
  await expect(out).toContainText('Sent, not confirmed yet');
  const signature = t.wallet.lastSigned().signature!;
  await expect(out).toContainText(signature);
  await expect(out).not.toContainText(/fail/i);
  await expect(ui.tradePanel(t.page)).not.toContainText(/fail/i);
  expect(t.rpc.failedCount('getSignatureStatuses')).toBeGreaterThan(0);

  // The chain says it landed.
  const landed = await landedTx(signature);
  expect(landed.meta?.err ?? null).toBeNull();
  expect((await tokenAmount(ata(mint, kp.publicKey)))! > 0n).toBe(true);

  t.rpc.release('getSignatureStatuses');
  await clickReal(ui.checkAgain(t.page), 'Check again');
  await expect(out).toHaveAttribute('data-status', 'confirmed', { timeout: 60_000 });
  expect(t.rpc.violations).toEqual([]);
  await t.ctx.close();
});

// L1: the lock on "sent, not confirmed yet" used to live in the panel's memory only, so a
// reload (or leaving and coming back) gave back a fresh trade form while the first
// trade could still land. It must survive both, and be checked on the chain first.
test('sent, not confirmed, then a reload: no trade form until the chain answers', async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const kp = await fundedKeypair(2);
  const t = await trader(browser, kp);
  await t.page.goto(`/curve-launch/${mint.toBase58()}`);
  await connectWallet(t.page, ui.tradePanel(t.page));
  await clickReal(ui.trade.side(t.page, 'buy'), 'buy');
  await ui.trade.amount(t.page, 'buy').fill('0.02');
  await clickReal(ui.trade.reviewButton(t.page, 'buy'), 'Review buy');
  await expect(ui.review(t.page)).toBeVisible({ timeout: 60_000 });
  t.rpc.fail('getSignatureStatuses', 500, 10 * 60_000);
  await clickReal(ui.signButton(t.page), 'Sign in wallet');
  await expect(ui.outcome(t.page)).toHaveAttribute('data-status', 'unknown', { timeout: 5 * 60_000 });
  const signature = t.wallet.lastSigned().signature!;

  // Reload, and leave and come back: the note is there, it is checked (and still cannot
  // be read), and there is no trade form to press.
  for (const hop of ['reload', 'away and back'] as const) {
    if (hop === 'reload') await t.page.reload();
    else {
      await t.page.goto('/curve-launch');
      await t.page.goto(`/curve-launch/${mint.toBase58()}`);
    }
    const card = ui.pendingTrade(t.page);
    await expect(card, hop).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('Sent, not confirmed yet');
    await expect(card).toContainText(signature);
    await expect(card).not.toContainText(/fail/i);
    await expect(card.getByRole('button', { name: 'Check again' })).toBeEnabled({ timeout: 60_000 });
    await expect(ui.tradePanel(t.page)).toHaveCount(0);
  }
  await checkAtSizes(t.page, 'pending-trade', [[ui.pendingTrade(t.page).getByRole('button', { name: 'Check again' }), 'Check again']]);

  // The chain can be read again: Check again settles it and the trade form comes back.
  t.rpc.release('getSignatureStatuses');
  await clickReal(ui.pendingTrade(t.page).getByRole('button', { name: 'Check again' }), 'Check again');
  await expect(ui.pendingTrade(t.page)).toHaveCount(0, { timeout: 60_000 });
  await expect(ui.tradePanel(t.page)).toBeVisible({ timeout: 30_000 });
  expect(await t.page.evaluate((m) => sessionStorage.getItem(`curve-launch:pending-trade:${m}`), mint.toBase58())).toBeNull();
  expect(t.rpc.violations).toEqual([]);
  await t.ctx.close();
});

test('selling more than you hold is stopped by the test run, before the wallet is asked', async ({ browser }) => {
  const kp = await fundedKeypair(1);
  const held = await buyDirect(kp, mint, sol(0.01));
  const t = await trader(browser, kp);
  await t.page.goto(`/curve-launch/${mint.toBase58()}`);
  await connectWallet(t.page, ui.tradePanel(t.page));
  await clickReal(ui.trade.side(t.page, 'sell'), 'sell');
  // Ten times the balance, in whole tokens.
  await ui.trade.amount(t.page, 'sell').fill(String((held * 10n) / 1_000_000n + 1n));
  const review = ui.trade.reviewButton(t.page, 'sell');
  if (await review.isEnabled()) {
    await review.click();
    const out = ui.outcome(t.page);
    await expect(out).toHaveAttribute('data-status', 'not-sent', { timeout: 60_000 });
    await expect(out).toContainText('Nothing was charged.');
  }
  // Either way: the wallet was never asked, and nothing moved.
  expect(t.wallet.records).toEqual([]);
  expect(await tokenAmount(ata(mint, kp.publicKey))).toBe(held);
  expect(t.rpc.violations).toEqual([]);
  await t.ctx.close();
});

test('a signature the person declines is "not sent", and nothing is charged', async ({ browser }) => {
  const kp = await fundedKeypair(1);
  const t = await trader(browser, kp);
  t.wallet.setMode('decline');
  await t.page.goto(`/curve-launch/${mint.toBase58()}`);
  await connectWallet(t.page, ui.tradePanel(t.page));
  await clickReal(ui.trade.side(t.page, 'buy'), 'buy');
  await ui.trade.amount(t.page, 'buy').fill('0.01');
  await clickReal(ui.trade.reviewButton(t.page, 'buy'), 'Review buy');
  const before = await lamports(kp.publicKey);
  await expect(ui.review(t.page)).toBeVisible({ timeout: 60_000 });
  await clickReal(ui.signButton(t.page), 'Sign in wallet');
  const out = ui.outcome(t.page);
  await expect(out).toHaveAttribute('data-status', 'not-sent', { timeout: 30_000 });
  await expect(out).toContainText('Your wallet did not sign it.');
  expect(t.wallet.records.map((r) => r.outcome)).toEqual(['declined']);
  expect(await lamports(kp.publicKey)).toBe(before);
  await t.ctx.close();
});
