// What the page tells a person when things do not go to plan. The rule this repo paid
// for: failing to CONFIRM a transaction is not the transaction failing. Saying "failed"
// about a transaction that landed makes people pay twice.
//
// The launches here are made from Node with the frontend's own curve/ix.ts and carry no
// metadata (how a launch made outside this site looks); the page under test only trades.
import { test, expect, type Browser, type Page, type Response } from '@playwright/test';
import { PublicKey, type Keypair } from '@solana/web3.js';
import { ata, buyDirect, createLaunchDirect, curve, fundedKeypair, lamports, landedTx, sol, tokenAmount } from './fixtures/chain';
import { bayla, giveBayla } from './fixtures/bayla';
import { installTestWallet } from './fixtures/testWallet';
import { installRpcGuard } from './fixtures/rpcGuard';
import { installUploadStub, makePng } from './fixtures/uploadStub';
import { installHeatStub } from './fixtures/heatStub';
import { ui, checkAtSizes, clickReal, connectWallet, expectConnected } from './fixtures/ui';

async function trader(browser: Browser, kp: Keypair) {
  const ctx = await browser.newContext();
  const wallet = await installTestWallet(ctx, kp);
  const rpc = await installRpcGuard(ctx);
  await installUploadStub(ctx);
  await installHeatStub(ctx);
  const page = await ctx.newPage();
  return { ctx, wallet, rpc, page };
}

/**
 * The network's answer to the page's first broadcast of a transaction. Ask for it BEFORE
 * pressing Sign, and wait for it before a reload that is meant to happen "while it is in
 * the air".
 *
 * The "sent" card is not that proof. The page draws it, and writes its note, BEFORE the
 * first byte leaves (submit.ts: the note must exist before the first send). A reload in the
 * next moment stops that request in the browser, the transaction never reaches the chain,
 * and a test that then asks the chain for it fails: in a whole run on 2026-10-04 the reload
 * came 87 ms after the broadcast began, and the launch never landed. "In the air" is
 * broadcast and not yet confirmed, so that is what these tests wait for.
 */
function firstBroadcast(page: Page): Promise<Response> {
  const answered = page.waitForResponse(
    (r) => r.url().endsWith('/api/solrpc') && r.request().method() === 'POST' && (r.request().postData() ?? '').includes('"sendTransaction"'),
    { timeout: 120_000 },
  );
  // Awaited later: a test that stops before then must not leave a rejection nobody handles.
  answered.catch(() => undefined);
  return answered;
}

/** The broadcast was taken: the network answered with this transaction's own signature, and no error. */
async function expectBroadcastTaken(answered: Promise<Response>, signature: string): Promise<void> {
  const answer = (await (await answered).json()) as { result?: unknown; error?: unknown };
  expect(answer.error ?? null, 'the network took the broadcast').toBeNull();
  expect(answer.result, 'the network answered with the signature the wallet gave').toBe(signature);
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

  // The chain says it landed: the tokens are in the buyer's account (a fresh wallet, which
  // held none). Asked of the account, not of the signature: the buy is over a minute old
  // by now, and under load the local validator may have dropped it from its transaction
  // history already (chain.ts landedTx).
  await expect.poll(async () => ((await tokenAmount(ata(mint, kp.publicKey))) ?? 0n) > 0n, { message: 'the buy landed: its tokens are on chain', timeout: 30_000 }).toBe(true);

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

// FS-1: the note used to be written only when the wait for the network ENDED (up to two
// minutes). A reload during that wait gave back an open trade form while the first trade
// could still land. Now the note exists from the moment the transaction is sent, and
// leaving the page asks first.
test('a reload WHILE the trade is still in the air: leaving asks first, and the page comes back held, not open', async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const kp = await fundedKeypair(2);
  const t = await trader(browser, kp);
  const dialogs: string[] = [];
  t.page.on('dialog', (d) => {
    dialogs.push(d.type());
    void d.accept();
  });
  await t.page.goto(`/curve-launch/${mint.toBase58()}`);
  await connectWallet(t.page, ui.tradePanel(t.page));
  await clickReal(ui.trade.side(t.page, 'buy'), 'buy');
  await ui.trade.amount(t.page, 'buy').fill('0.02');
  await clickReal(ui.trade.reviewButton(t.page, 'buy'), 'Review buy');
  await expect(ui.review(t.page)).toBeVisible({ timeout: 60_000 });
  // No status can be read, so the page keeps waiting: this is the window that was unsafe.
  t.rpc.fail('getSignatureStatuses', 500, 10 * 60_000);
  const broadcast = firstBroadcast(t.page);
  await clickReal(ui.signButton(t.page), 'Sign in wallet');
  const sent = ui.sent(t.page);
  await expect(sent).toBeVisible({ timeout: 60_000 });
  const signature = t.wallet.lastSigned().signature!;
  await expect(sent).toContainText(signature);
  await expect(sent).not.toContainText(/Waiting for your wallet/);
  await expect(ui.outcome(t.page)).toHaveCount(0);
  // The note is already there, before any answer.
  expect(await t.page.evaluate((m) => sessionStorage.getItem(`curve-launch:pending-trade:${m}`), mint.toBase58())).toContain(signature);

  // In the air: broadcast, and still not confirmed (no status can be read).
  await expectBroadcastTaken(broadcast, signature);
  await expect(ui.outcome(t.page)).toHaveCount(0);
  await t.page.reload();
  expect(dialogs, 'leaving while it was in the air asked first').toContain('beforeunload');
  const card = ui.pendingTrade(t.page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText(signature);
  await expect(ui.tradePanel(t.page)).toHaveCount(0);

  // It landed; once the chain can be read, Check again settles it and the form comes back.
  expect((await landedTx(signature)).meta?.err ?? null).toBeNull();
  t.rpc.release('getSignatureStatuses');
  await clickReal(card.getByRole('button', { name: 'Check again' }), 'Check again');
  await expect(ui.pendingTrade(t.page)).toHaveCount(0, { timeout: 60_000 });
  await expect(ui.tradePanel(t.page)).toBeVisible({ timeout: 30_000 });
  expect(t.rpc.violations).toEqual([]);
  await t.ctx.close();
});

// FS-1, the launch: the new token's key lived only in memory, so a reload during the
// wait gave a fresh form that would build a SECOND launch with a new key.
test('a reload WHILE a launch is in the air: the form comes back holding Review until the creator decides', async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const kp = await fundedKeypair(3);
  // Enough $BAYLA for two plants: the launch in the air, and the next one Review offers.
  await giveBayla(kp, bayla(250_000));
  const t = await trader(browser, kp);
  t.page.on('dialog', (d) => void d.accept());
  await t.page.goto('/curve-launch');
  await connectWallet(t.page, ui.door(t.page));
  const fill = async () => {
    await ui.form.picture(t.page).setInputFiles({ name: 'corn.png', mimeType: 'image/png', buffer: makePng() });
    await ui.form.name(t.page).fill('Reload Corn');
    await ui.form.symbol(t.page).fill('RCORN');
  };
  await fill();
  await clickReal(ui.form.reviewButton(t.page), 'Review launch');
  await expect(ui.review(t.page)).toBeVisible({ timeout: 60_000 });
  t.rpc.fail('getSignatureStatuses', 500, 10 * 60_000);
  const broadcast = firstBroadcast(t.page);
  await clickReal(ui.signButton(t.page), 'Sign in wallet');
  await expect(ui.sent(t.page)).toBeVisible({ timeout: 60_000 });
  const launched = t.wallet.lastIx('create_launch').accounts.mint;

  // In the air: broadcast, and still not confirmed (no status can be read).
  await expectBroadcastTaken(broadcast, t.wallet.lastSigned().signature!);
  await expect(ui.outcome(t.page)).toHaveCount(0);
  await t.page.reload();
  // The wallet reconnects on its own after a reload.
  await expectConnected(ui.createForm(t.page), kp.publicKey.toBase58());
  const earlier = ui.earlierLaunch(t.page);
  await expect(earlier).toBeVisible({ timeout: 30_000 });
  await expect(earlier).toContainText(launched);
  await expect(earlier).toContainText(/may still be landing/, { timeout: 60_000 });
  await fill();
  await expect(ui.form.reviewButton(t.page)).toBeDisabled();
  await checkAtSizes(t.page, 'earlier-launch', [
    [earlier.getByRole('button', { name: 'My earlier launch did not land: start a new one' }), 'did not land'],
  ]);

  // The chain can be read again and the launch landed: a fresh visit says it went through
  // and no longer holds Review. "Landed" is asked of the launch's own curve account, not
  // of the signature (the local validator forgets old signatures: chain.ts landedTx).
  await expect.poll(async () => (await curve(new PublicKey(launched))) !== null, { message: 'the launch landed: its curve is on chain', timeout: 30_000 }).toBe(true);
  t.rpc.release('getSignatureStatuses');
  await t.page.reload();
  await expectConnected(ui.createForm(t.page), kp.publicKey.toBase58());
  await expect(ui.earlierLaunch(t.page)).toContainText(/went through/, { timeout: 60_000 });
  await fill();
  await expect(ui.form.reviewButton(t.page)).toBeEnabled({ timeout: 30_000 });
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
