// The whole life of one token, through the site, on the mainnet binaries (local validator):
// launch with an opening buy (the platform reserve lands in the treasury in the same
// transaction) → listed → bought → sold → bought to the target → graduated by a
// stranger → traded in its own pool.
//
// Every step asserts ON THE CHAIN, to the raw unit, against numbers computed in Node from
// the chain state just before the click. The page's own words are asserted only where a
// person relies on them (the "fills the curve" note, which buttons are offered).
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { Keypair, PublicKey } from '@solana/web3.js';
import { PublicKey as Pk } from '@solana/web3.js';
import {
  CP_SWAP_PROGRAM, LAUNCH_PROGRAM, METAPLEX, VAULT, WSOL, ata, chain, curve, curveOwner, expectedOpeningBuy, expectedPoolOut, fundedKeypair,
  globalConfig, lamportDelta, lamports, landedTx, launchPool, metadataFacts, migrationAuthority, mintFacts, sol, tokenAmount, txAccountKeys,
  waitForPoolOpenByWallClock,
} from './fixtures/chain';
import { installTestWallet, type TestWallet } from './fixtures/testWallet';
import { installRpcGuard, type RpcGuard } from './fixtures/rpcGuard';
import { installUploadStub, makePng, SVG_WITH_SCRIPT, type UploadStub } from './fixtures/uploadStub';
import { installHeatStub, type HeatStub } from './fixtures/heatStub';
import { LAUNCH_INDEX } from './fixtures/walletGuard';
import { ui, checkAtSizes, clickReal, connectWallet, expectConnected, signAndWait, tokensToInput } from './fixtures/ui';
import { quoteBuyOnCurve, quoteSellOnCurve } from '../src/lib/launcher/solana/curve/math';
import { formatSol } from '../src/lib/launcher/solana/curve/format';
import { poolStatePda, curveVaultPda, BONDING_CURVE_SIZE } from '../src/lib/launcher/solana/curve/program';

interface Actor { ctx: BrowserContext; page: Page; wallet: TestWallet; rpc: RpcGuard; upload: UploadStub; heat: HeatStub; kp: Keypair }

async function actor(browser: Browser, sol: number): Promise<Actor> {
  const kp = await fundedKeypair(sol);
  const ctx = await browser.newContext();
  const wallet = await installTestWallet(ctx, kp);
  const rpc = await installRpcGuard(ctx);
  const upload = await installUploadStub(ctx);
  const heat = await installHeatStub(ctx);
  const page = await ctx.newPage();
  return { ctx, page, wallet, rpc, upload, heat, kp };
}

const TX_LIMIT = 1232;
const cu: Record<string, number | null> = {};

async function landedOk(signature: string | null, kind: string) {
  expect(signature, `${kind}: the wallet signed nothing`).toBeTruthy();
  const t = await landedTx(signature!);
  expect(t.meta?.err ?? null, `${kind} ${signature} reverted on chain`).toBeNull();
  cu[kind] = t.meta?.computeUnitsConsumed ?? null;
  return t;
}

// Deliberately NO reload between trades: a person buys and then sells on the same page,
// so the page must show the new balances and reserves on its own. (2026-09-26: it did
// not. Its reads use the RPC's default FINALIZED commitment and are not repeated, so for
// ~13 s after a confirmed trade the panel quotes the old curve; with a reload after each
// trade every on-chain assertion in this file passed.)
async function startOver(p: Page) {
  const btn = ui.outcome(p).getByRole('button', { name: /^(Close|Start over)$/ });
  if (await btn.count()) await btn.first().click();
}

test('launch (reserve paid at create), trade, graduate and trade in the pool, all from the site', async ({ browser }, testInfo) => {
  test.setTimeout(20 * 60_000);
  const g = await globalConfig();
  const creator = await actor(browser, 5);
  const buyer = await actor(browser, 5);
  const finisher = await actor(browser, 1);
  let mint!: PublicKey;

  await test.step('1. the write path is open, and the wallet connects through the site', async () => {
    const p = creator.page;
    creator.rpc.view('create');
    await p.goto('/curve-launch');
    await expect(ui.navTab(p)).toBeVisible();
    await expect(ui.navTab(p).getByText('Soon', { exact: true })).toHaveCount(0);
    await expect(ui.gateBanner(p)).toContainText('Open.', { timeout: 30_000 });
    await expect(ui.gateBanner(p)).toContainText(LAUNCH_PROGRAM.toBase58());
    // The create form is behind the heat door, which reads the connected Solana wallet.
    await expect(ui.createForm(p)).toHaveCount(0);
    await connectWallet(p, ui.door(p));
    await expect(ui.door(p).getByText('WARM', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expectConnected(ui.createForm(p), creator.kp.publicKey.toBase58());
    expect(creator.heat.asked).toContain(creator.kp.publicKey.toBase58());
  });

  await test.step('2. bad input is refused before anything is uploaded or signed', async () => {
    const p = creator.page;
    const review = ui.form.reviewButton(p);
    await ui.form.picture(p).setInputFiles({ name: 'corn.png', mimeType: 'image/png', buffer: makePng() });
    await ui.form.symbol(p).fill('ECORN');
    await ui.form.name(p).fill(`Corn ${String.fromCharCode(0x202e)}gnp.exe`); // a right-to-left override (U+202E)
    await expect(review).toBeDisabled();
    await ui.form.name(p).fill('E2E Corn');
    await ui.form.symbol(p).fill('SOL'); // a reserved ticker
    await expect(review).toBeDisabled();
    await ui.form.symbol(p).fill('ECORN');
    await ui.form.picture(p).setInputFiles({ name: 'x.svg', mimeType: 'image/svg+xml', buffer: SVG_WITH_SCRIPT });
    await expect(review).toBeDisabled();
    expect(creator.wallet.records, 'nothing was put in front of the wallet').toEqual([]);
    expect(creator.upload.uploads, 'nothing was uploaded').toEqual([]);
  });

  await test.step('3. launch with a 0.05 SOL opening buy', async () => {
    const p = creator.page;
    await ui.form.picture(p).setInputFiles({ name: 'corn.png', mimeType: 'image/png', buffer: makePng() });
    await ui.form.name(p).fill('E2E Corn');
    await ui.form.symbol(p).fill('ECORN');
    await ui.form.description(p).fill('A token launched by the end-to-end test on a local validator.');
    await ui.form.openingBuyToggle(p).check();
    await ui.form.openingBuy(p).fill('0.05');
    const expected = expectedOpeningBuy(g, sol(0.05));
    await expect(ui.form.reviewButton(p)).toBeEnabled({ timeout: 30_000 });
    await checkAtSizes(p, '1-launch-form', [[ui.form.reviewButton(p), 'Review launch'], [ui.form.picture(p), 'Token picture']]);
    await clickReal(ui.form.reviewButton(p), 'Review launch');
    await expect(ui.review(p)).toBeVisible({ timeout: 60_000 });
    await expect(ui.publicForever(p)).toBeVisible();
    // The review names the reserve paid in this transaction, its receiver as the chain
    // records it, and the rent for the treasury's token account (read, not hard-coded).
    const tokenRent = BigInt(await chain().getMinimumBalanceForRentExemption(165));
    await expect(ui.review(p)).toContainText('Platform reserve, paid in this transaction');
    await expect(ui.review(p)).toContainText(g.feeRecipient.toBase58());
    await expect(ui.review(p)).toContainText(`${formatSol(tokenRent, 9)} SOL (rent, read from the network just now)`);
    await expect(ui.review(p)).toContainText('does not stop the treasury selling those tokens, including while the curve is live');

    const before = await lamports(creator.kp.publicKey);
    // After a create the page goes to the new launch's own page (it may show the outcome
    // card first, or go straight there with the launch "not found yet" while it lands).
    await clickReal(ui.signButton(p), 'Sign in wallet');
    await expect.poll(() => creator.wallet.signed().length, { timeout: 60_000 }).toBe(1);
    const rec = creator.wallet.lastSigned();
    const create = creator.wallet.lastIx('create_launch');
    mint = new Pk(create.accounts.mint);
    await p.waitForURL(new RegExp(`/curve-launch/${mint.toBase58()}`), { timeout: 120_000 });
    const t = await landedOk(rec.signature, 'create');
    // The chain has it; the page must re-read and show it without being asked to.
    await expect(ui.creatorStake(p), 'the launch page did not re-read the curve after the create landed (still "not found yet")')
      .toBeVisible({ timeout: 45_000 });
    await expect(ui.pendingLaunch(p)).toHaveCount(0);

    // What was signed: one upload message, one transaction; the opening buy's floor is the exact quote.
    expect(creator.wallet.records.filter((r) => r.kind === 'message' && r.outcome === 'signed')).toHaveLength(1);
    const buy = creator.wallet.lastIx('buy');
    expect(BigInt(buy.args.maxLamportsIn)).toBe(sol(0.05));
    expect(BigInt(buy.args.minTokensOut), 'the opening buy has no slippage: nothing can trade before it').toBe(expected.tokensOut);
    expect(rec.bytes + 150, `create transaction is ${rec.bytes} B; wallets need >= 150 B of the ${TX_LIMIT}`).toBeLessThanOrEqual(TX_LIMIT);

    const mf = await mintFacts(mint);
    expect(mf).toEqual({ mintAuthority: null, freezeAuthority: null, decimals: 6, supply: g.tokenTotalSupply });
    const md = await metadataFacts(mint);
    expect(md?.owner.equals(METAPLEX)).toBe(true);
    expect(md?.mint.equals(mint)).toBe(true);
    expect(md?.name).toBe('E2E Corn');
    expect(md?.symbol).toBe('ECORN');
    expect(md?.uri).toBe(creator.upload.uploads.at(-1)?.metadataUri);
    expect(md?.uri, 'the on-chain link must not name a gateway: gateways get retired, the link is forever').toMatch(/^ipfs:\/\/b[a-z2-7]+$/);
    expect(md?.isMutable, 'name, symbol and picture are locked forever').toBe(false);
    expect(md?.updateAuthority.equals(creator.kp.publicKey)).toBe(true);
    expect((await curveOwner(mint))?.equals(LAUNCH_PROGRAM)).toBe(true);
    const c = await curve(mint);
    expect(c?.curve.creator.equals(creator.kp.publicKey)).toBe(true);
    expect(await tokenAmount(ata(mint, creator.kp.publicKey))).toBe(expected.tokensOut);
    // Reserve at create: the treasury's token account holds EXACTLY the reserve right
    // after the create, the curve records it paid, and the vault holds only the curve's share.
    const reserve = (g.tokenTotalSupply * g.platformReserveBps) / 10_000n;
    expect(reserve > 0n).toBe(true);
    expect(create.accounts.fee_recipient).toBe(g.feeRecipient.toBase58());
    expect(create.accounts.treasury_token).toBe(ata(mint, g.feeRecipient).toBase58());
    expect(await tokenAmount(ata(mint, g.feeRecipient)), 'the treasury holds exactly the platform reserve').toBe(reserve);
    expect(c?.curve.platformReserveTokens).toBe(reserve);
    expect(c?.curve.platformReserveReleased).toBe(true);
    expect(await tokenAmount(curveVaultPda(mint, LAUNCH_PROGRAM))).toBe(g.tokenTotalSupply - reserve - expected.tokensOut);
    const trailing = create.args.trailing ? create.args.trailing.split(',') : [];
    if (trailing.length) {
      expect(trailing).toEqual([LAUNCH_INDEX.toBase58()]);
      expect(txAccountKeys(t).some((k) => k.equals(LAUNCH_INDEX))).toBe(true);
    }
    testInfo.annotations.push({ type: 'create', description: `${rec.bytes} B, ${t.meta?.computeUnitsConsumed} CU, creator paid ${before - (await lamports(creator.kp.publicKey))} lamports` });

    // The launch page says what the creator bought, and never "0" for "could not read".
    await expect(ui.creatorStake(p)).toBeVisible({ timeout: 30_000 });
    await expect(ui.creatorStake(p)).not.toContainText(/could not read/);
  });

  await test.step('4. the list shows it first, with progress', async () => {
    const p = creator.page;
    creator.rpc.view('list');
    await p.goto('/curve-launch');
    const first = ui.listRows(p).first();
    await expect(first).toContainText(mint.toBase58(), { timeout: 60_000 });
    await expect(first).toContainText('E2E Corn');
    await expect(first).toContainText(/Raised [\d.]+ SOL, [\d.]+% of the way to graduation/);
    await expect(first).not.toContainText(/Raised 0 SOL/);
    const calls = creator.rpc.count('list');
    testInfo.annotations.push({ type: 'list-rpc-calls', description: String(calls) });
    // A third of the proxy's per-IP minute budget (300). The plan's target is ~25; the count is logged.
    expect(calls).toBeLessThanOrEqual(100);
  });

  await test.step('5. a second wallet buys 0.3 SOL: tokens and both fee legs exact', async () => {
    const p = buyer.page;
    buyer.rpc.view('trade');
    await p.goto(`/curve-launch/${mint.toBase58()}`);
    await connectWallet(p, ui.tradePanel(p));
    const c = (await curve(mint))!;
    const q = quoteBuyOnCurve(c.curve, sol(0.3));
    if (!q.ok) throw new Error(q.error);
    await clickReal(ui.trade.side(p, 'buy'), 'buy');
    await ui.trade.amount(p, 'buy').fill('0.3');
    await clickReal(ui.trade.reviewButton(p, 'buy'), 'Review buy');
    expect(await signAndWait(p)).toBe('confirmed');
    const t = await landedOk(buyer.wallet.lastSigned().signature, 'buy');
    const signed = buyer.wallet.lastIx('buy');
    const floor = BigInt(signed.args.minTokensOut);
    expect(floor > 0n && floor <= q.value.tokensOut && floor >= (q.value.tokensOut * 95n) / 100n, `floor ${floor} within 5% of ${q.value.tokensOut}`).toBe(true);
    expect(await tokenAmount(ata(mint, buyer.kp.publicKey))).toBe(q.value.tokensOut);
    const creatorLeg = (q.value.feeLamports * c.curve.creatorFeeShareBps) / 10_000n;
    expect(lamportDelta(t, c.curve.creator)).toBe(creatorLeg);
    expect(lamportDelta(t, g.feeRecipient)).toBe(q.value.feeLamports - creatorLeg);
    await startOver(p);
  });

  await test.step('6. it sells half: SOL out exact', async () => {
    const p = buyer.page;
    const held = (await tokenAmount(ata(mint, buyer.kp.publicKey)))!;
    const half = held / 2n;
    const c = (await curve(mint))!;
    const rentFloor = BigInt(await chain().getMinimumBalanceForRentExemption(BONDING_CURVE_SIZE));
    const q = quoteSellOnCurve(c.curve, half, 0n, { curveAccountLamports: c.lamports, rentExemptLamports: rentFloor });
    if (!q.ok) throw new Error(q.error);
    await clickReal(ui.trade.side(p, 'sell'), 'sell');
    await ui.trade.amount(p, 'sell').fill(tokensToInput(half));
    await clickReal(ui.trade.reviewButton(p, 'sell'), 'Review sell');
    expect(await signAndWait(p)).toBe('confirmed');
    const t = await landedOk(buyer.wallet.lastSigned().signature, 'sell');
    expect(BigInt(buyer.wallet.lastIx('sell').args.tokensIn)).toBe(half);
    expect(BigInt(buyer.wallet.lastIx('sell').args.minLamportsOut) > 0n).toBe(true);
    expect(lamportDelta(t, buyer.kp.publicKey)).toBe(q.value.lamportsOut - BigInt(t.meta!.fee));
    expect(await tokenAmount(ata(mint, buyer.kp.publicKey))).toBe(held - half);
    await startOver(p);
    // Mid-curve, as the buyer sees it after two trades, with no reload.
    await expect(ui.tradePanel(p)).toBeVisible();
    await checkAtSizes(p, '2-launch-mid-curve', [
      [ui.trade.side(p, 'buy'), 'buy toggle'],
      [ui.trade.side(p, 'sell'), 'sell toggle'],
      [ui.trade.reviewButton(p, 'sell'), 'Review sell'],
    ]);
  });

  await test.step('7. a buy larger than what is left fills the curve and is capped', async () => {
    const p = buyer.page;
    const c = (await curve(mint))!;
    const q = quoteBuyOnCurve(c.curve, sol(2));
    if (!q.ok) throw new Error(q.error);
    expect(q.value.capped).toBe(true);
    await clickReal(ui.trade.side(p, 'buy'), 'buy');
    await ui.trade.amount(p, 'buy').fill('2');
    await expect(ui.tradePanel(p)).toContainText('This buy fills the curve');
    await clickReal(ui.trade.reviewButton(p, 'buy'), 'Review buy');
    await expect(ui.review(p)).toContainText('This buy fills the curve', { timeout: 60_000 });
    expect(await signAndWait(p)).toBe('confirmed');
    const t = await landedOk(buyer.wallet.lastSigned().signature, 'buy-capped');
    // Debited: the capped amount (fee inside it) + the network fee; the ATA already existed.
    expect(lamportDelta(t, buyer.kp.publicKey)).toBe(-(q.value.lamportsIn + BigInt(t.meta!.fee)));
    const after = (await curve(mint))!.curve;
    expect(after.realSolReserves).toBe(after.graduationTargetLamports + after.migrationReserveLamports);
    await startOver(p);
    await p.reload();
    // Buying is no longer offered (either the side is off, or its review is); selling still is.
    const buySide = ui.trade.side(p, 'buy');
    if (await buySide.isEnabled()) {
      await clickReal(buySide, 'buy');
      if (await ui.trade.amount(p, 'buy').isEnabled()) await ui.trade.amount(p, 'buy').fill('0.01');
      await expect(ui.trade.reviewButton(p, 'buy')).toBeDisabled();
    }
    await clickReal(ui.trade.side(p, 'sell'), 'sell');
    await ui.trade.amount(p, 'sell').fill('1');
    await expect(ui.trade.reviewButton(p, 'sell')).toBeEnabled();
  });

  let pool!: PublicKey;
  await test.step('8. a third wallet finishes graduation: pool opened, LP burned', async () => {
    const p = finisher.page;
    finisher.rpc.view('graduate');
    await p.goto(`/curve-launch/${mint.toBase58()}`);
    await connectWallet(p, ui.graduationPanel(p));
    await clickReal(ui.graduate(p), 'Review: finish graduation');
    expect(await signAndWait(p)).toBe('confirmed');
    const t = await landedOk(finisher.wallet.lastSigned().signature, 'migrate');
    const c = (await curve(mint))!.curve;
    pool = poolStatePda(mint, LAUNCH_PROGRAM);
    expect(c.complete).toBe(true);
    expect(c.pool.equals(pool)).toBe(true);
    const pf = await launchPool(mint);
    expect(pf.owner.equals(CP_SWAP_PROGRAM)).toBe(true);
    expect([pf.pool.token0Mint, pf.pool.token1Mint].sort()).toEqual([WSOL.toBase58(), mint.toBase58()].sort());
    expect((await mintFacts(new Pk(pf.pool.lpMint))).supply, 'LP burned').toBe(0n);
    expect(lamportDelta(t, VAULT) > 0n, 'the fee recipient received the unspent migration reserve').toBe(true);
    const auth = await chain().getAccountInfo(migrationAuthority(), 'confirmed');
    expect(!auth || auth.lamports === 0).toBe(true);
    // Graduation did not touch the platform reserve: it was paid at create.
    expect(await tokenAmount(ata(mint, g.feeRecipient))).toBe(c.platformReserveTokens);
    await startOver(p);
    await p.reload();
    await expect(ui.graduationPanel(p)).toContainText('when this token was created', { timeout: 30_000 });
    await expect(p.getByRole('button', { name: /release/i })).toHaveCount(0);
  });

  await test.step('9. pool buy and pool sell: outputs exact, WSOL unwrapped', async () => {
    const p = buyer.page;
    buyer.rpc.view('pool');
    const waited = await waitForPoolOpenByWallClock(mint);
    testInfo.annotations.push({ type: 'waited-for-pool-open', description: `${waited} ms (validator clock ahead of the wall clock)` });
    await p.goto(`/curve-launch/${mint.toBase58()}`);
    await expect(ui.poolPanel(p)).toBeVisible({ timeout: 30_000 });
    await expect(ui.graduationPanel(p)).toContainText('when this token was created', { timeout: 30_000 });
    await checkAtSizes(p, '3-launch-graduated', [
      [ui.pool.side(p, 'buy'), 'pool buy toggle'],
      [ui.pool.side(p, 'sell'), 'pool sell toggle'],
      [ui.pool.reviewButton(p, 'buy'), 'Review pool buy'],
    ]);
    const wsolBefore = await tokenAmount(ata(WSOL, buyer.kp.publicKey));
    const tokBefore = (await tokenAmount(ata(mint, buyer.kp.publicKey))) ?? 0n;
    const outBuy = await expectedPoolOut(mint, WSOL, sol(0.05));
    await clickReal(ui.pool.side(p, 'buy'), 'pool buy');
    await ui.pool.amount(p, 'buy').fill('0.05');
    await clickReal(ui.pool.reviewButton(p, 'buy'), 'Review pool buy');
    expect(await signAndWait(p)).toBe('confirmed');
    await landedOk(buyer.wallet.lastSigned().signature, 'pool-buy');
    const got = (await tokenAmount(ata(mint, buyer.kp.publicKey)))! - tokBefore;
    expect(got).toBe(outBuy);
    expect(got >= BigInt(buyer.wallet.lastIx('swap_base_input').args.minimumAmountOut)).toBe(true);
    if (wsolBefore === null) expect(await tokenAmount(ata(WSOL, buyer.kp.publicKey)), 'the temporary WSOL account is closed').toBeNull();
    await startOver(p);

    const sellAmount = got / 2n;
    const outSell = await expectedPoolOut(mint, mint, sellAmount);
    await clickReal(ui.pool.side(p, 'sell'), 'pool sell');
    await ui.pool.amount(p, 'sell').fill(tokensToInput(sellAmount));
    await clickReal(ui.pool.reviewButton(p, 'sell'), 'Review pool sell');
    expect(await signAndWait(p)).toBe('confirmed');
    const t = await landedOk(buyer.wallet.lastSigned().signature, 'pool-sell');
    // The WSOL leg is unwrapped in the same transaction, so SOL arrives as lamports.
    expect(lamportDelta(t, buyer.kp.publicKey)).toBe(outSell - BigInt(t.meta!.fee));
    if (wsolBefore === null) expect(await tokenAmount(ata(WSOL, buyer.kp.publicKey))).toBeNull();
  });

  await test.step('10. nobody was asked to sign anything the wallet refused, and no page broke the RPC rules', async () => {
    for (const a of [creator, buyer, finisher]) {
      expect(a.wallet.records.filter((r) => r.outcome === 'refused').map((r) => r.reason)).toEqual([]);
      expect(a.rpc.violations).toEqual([]);
    }
    testInfo.annotations.push({ type: 'compute-units', description: JSON.stringify(cu) });
    console.log(`[solana e2e] compute units by kind: ${JSON.stringify(cu)}`);
  });

  await Promise.all([creator.ctx.close(), buyer.ctx.close(), finisher.ctx.close()]);
});
