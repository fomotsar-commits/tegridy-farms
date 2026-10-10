// The read-only LP venue on /pools, against the mainnet cp-swap binary on the local
// validator: the token safety checker, the pool finder (server index + the addresses the
// page works out itself), each pool's health, and "Your positions".
//
// Fixtures are made from Node with the frontend's own initializeIx: a clean pool on fee
// tier 1 (the seeded stand-in for the vault's proposal, 0.15 SOL to open); a squatter on
// the standard tier-1 address at a bad price with an open time ten years out, beside a
// real pool at a fresh signing address; a pool of a freezable token; and a Token-2022
// token with a transfer hook (for which the pool program itself refuses a pool).
//
// What the page is held to: every pool it shows is the one on chain (addresses computed
// here, independently); a squatted standard address is never shown as "the" pool; what
// it could not read is "unread", never "safe" or "none"; the browser never scans the
// program (rpcGuard records any getProgramAccounts as a violation); and reading signs
// nothing.
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { CP_SWAP_PROGRAM, chain, fundedKeypair, sol, tokenAmount } from './fixtures/chain';
import { installRpcGuard, type RpcGuard } from './fixtures/rpcGuard';
import { installTestWallet, type TestWallet } from './fixtures/testWallet';
import { ui, SHOT_SIZES, clickReal, connectWallet, expectClickable, expectNoSidewaysScroll } from './fixtures/ui';
import {
  CREATE_POOL_FEE_RECEIVER, createClassicToken, createSolPool, createTransferHookToken, installJupiterStub, installPoolIndex, type CreatedPool,
} from './fixtures/lp';
import { decodePoolState } from '../src/lib/solana/cpswap/program';

const DEC = 6;
const UNIT = 10n ** BigInt(DEC);
/** Every fixture pool is priced at 1 SOL per million tokens, except the squatter. */
const FAIR = 1e-6;

let creator: Keypair;
let stranger: Keypair;
let clean: PublicKey;
let squatted: PublicKey;
let freezable: PublicKey;
let hooked: PublicKey;
let cleanPool: CreatedPool;
let squatPool: CreatedPool;
let realPool: CreatedPool;
let freezePool: CreatedPool;
let feeReceiverDelta = 0n;

test.beforeAll(async () => {
  test.setTimeout(6 * 60_000);
  creator = await fundedKeypair(10);
  stranger = await fundedKeypair(20);

  const feeBefore = await tokenAmount(CREATE_POOL_FEE_RECEIVER);
  clean = await createClassicToken(creator, { supply: 10_000_000n * UNIT, name: { name: 'E2E Clean', symbol: 'ECLEAN' } });
  cleanPool = await createSolPool(creator, clean, { configIndex: 1, sol: sol(2), tokens: 2_000_000n * UNIT, at: 'standard' });
  const feeAfter = await tokenAmount(CREATE_POOL_FEE_RECEIVER);
  feeReceiverDelta = (feeAfter ?? 0n) - (feeBefore ?? 0n);

  squatted = await createClassicToken(stranger, { supply: 10_000_000n * UNIT, name: { name: 'E2E Squatted', symbol: 'ESQUAT' } });
  const slot = await chain().getSlot('confirmed');
  const now = BigInt((await chain().getBlockTime(slot)) ?? Math.floor(Date.now() / 1000));
  // The squatter: the standard tier-1 address, 100x the fair price, open in ten years.
  squatPool = await createSolPool(stranger, squatted, { configIndex: 1, sol: sol(0.01), tokens: 100n * UNIT, openTime: now + 10n * 365n * 86_400n, at: 'standard' });
  // The real pool, at a fresh address because the standard one is taken.
  realPool = await createSolPool(stranger, squatted, { configIndex: 1, sol: sol(3), tokens: 3_000_000n * UNIT, at: 'fresh' });

  freezable = await createClassicToken(stranger, { freezable: true, supply: 10_000_000n * UNIT, name: { name: 'E2E Freezable', symbol: 'EFRZ' } });
  freezePool = await createSolPool(stranger, freezable, { configIndex: 0, sol: sol(1), tokens: 1_000_000n * UNIT, at: 'standard' });

  hooked = await createTransferHookToken(stranger);
});

interface Actor { ctx: BrowserContext; page: Page; rpc: RpcGuard; jup: { asked: string[] }; index: { calls: string[] }; wallet: TestWallet | null }

async function actor(browser: Browser, o: { wallet?: Keypair; indexDown?: boolean; viewport?: { width: number; height: number } } = {}): Promise<Actor> {
  const ctx = await browser.newContext(o.viewport ? { viewport: o.viewport } : {});
  const wallet = o.wallet ? await installTestWallet(ctx, o.wallet) : null;
  const rpc = await installRpcGuard(ctx);
  const index = await installPoolIndex(ctx, { down: o.indexDown });
  const prices = new Map([clean, squatted, freezable].map((m) => [m.toBase58(), { solPerToken: FAIR, decimals: DEC }]));
  const jup = await installJupiterStub(ctx, prices);
  const page = await ctx.newPage();
  return { ctx, page, rpc, jup, index, wallet };
}

async function openFor(p: Page, mint: PublicKey) {
  await p.goto(`/pools?mint=${mint.toBase58()}`);
  await expect(ui.lp.section(p)).toBeVisible({ timeout: 60_000 });
  await expect(ui.lp.safety(p)).toBeVisible({ timeout: 60_000 });
}

const poolCard = (p: Page, address: PublicKey) => p.locator(`[data-testid="lp-pool"][data-pool="${address.toBase58()}"]`);

test('the fixtures are what they claim, on chain', async () => {
  // Tier 1 charged its 0.15 SOL create fee into the vault's WSOL account.
  expect(feeReceiverDelta).toBe(150_000_000n);
  expect(cleanPool.standard).toBe(true);
  expect(squatPool.standard).toBe(true);
  expect(realPool.standard).toBe(false);
  const raw = await chain().getAccountInfo(squatPool.address, 'confirmed');
  expect(raw?.owner.equals(CP_SWAP_PROGRAM)).toBe(true);
  const squat = decodePoolState(squatPool.address.toBase58(), raw!.data)!;
  expect(squat.openTime).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)) + 9n * 365n * 86_400n);
});

test('a clean pool: token ok, pool read from chain, deposits pass the checks, fee tiers read live', async ({ browser }) => {
  const a = await actor(browser);
  await openFor(a.page, clean);
  const p = a.page;
  await expect(ui.lp.safety(p)).toHaveAttribute('data-verdict', 'ok');
  await expect(ui.lp.safety(p)).toContainText(clean.toBase58());
  await expect(ui.lp.safety(p)).toContainText('E2E Clean');
  await expect(ui.lp.pools(p)).toHaveCount(1);
  const card = poolCard(p, cleanPool.address);
  await expect(card).toHaveAttribute('data-origin', 'standard');
  await expect(card).toHaveAttribute('data-swaps', 'open');
  await expect(card).toHaveAttribute('data-price', 'agrees');
  await expect(card).toHaveAttribute('data-deposits', 'allowed');
  await expect(card).toContainText('Standard address, fee tier 1');
  await expect(card).toContainText('Traders pay 1% a trade');
  await expect(card).toContainText('2 SOL and 2,000,000 tokens');
  await expect(ui.lp.status(p)).toHaveText('One pool found for this token.');
  // Both fee tiers are read from the chain.
  await expect(ui.lp.feeTiers(p)).toHaveCount(2);
  for (const t of await ui.lp.feeTiers(p).all()) await expect(t).toHaveAttribute('data-state', 'live');
  await expect(ui.lp.feeTiers(p).nth(1)).toContainText('0.15 SOL');
  await expect(ui.lp.disclosure(p)).toContainText('have not had their own independent review yet');
  // The price was checked against Jupiter (stubbed), and the server index was asked.
  expect(a.jup.asked).toContain(clean.toBase58());
  expect(a.index.calls.some((c) => c.includes(clean.toBase58()))).toBe(true);
  expect(a.rpc.violations).toEqual([]);
  await a.ctx.close();
});

test('a squatted standard address sits beside the real pool; only the real one passes, and neither is "the" pool', async ({ browser }) => {
  const a = await actor(browser);
  await openFor(a.page, squatted);
  const p = a.page;
  await expect(ui.lp.pools(p)).toHaveCount(2);
  // Deepest first: the real pool at its own address, found only through the index.
  await expect(ui.lp.pools(p).nth(0)).toHaveAttribute('data-pool', realPool.address.toBase58());
  await expect(ui.lp.pools(p).nth(1)).toHaveAttribute('data-pool', squatPool.address.toBase58());
  const real = poolCard(p, realPool.address);
  await expect(real).toHaveAttribute('data-origin', 'other');
  await expect(real).toHaveAttribute('data-deposits', 'allowed');
  const squat = poolCard(p, squatPool.address);
  await expect(squat).toHaveAttribute('data-origin', 'standard');
  await expect(squat).toHaveAttribute('data-swaps', 'not-open-yet');
  await expect(squat).toHaveAttribute('data-deposits', 'refused');
  await expect(squat).toHaveAttribute('data-price', 'disagrees');
  await expect(squat).toContainText('cannot trade');
  await expect(squat).toContainText('earns nothing');
  await expect(ui.lp.indexNote(p)).toContainText('does not make it the right pool');
  expect(a.rpc.violations).toEqual([]);
  await a.ctx.close();
});

test('with the pool index down, the page checks the addresses it can work out and says there may be more', async ({ browser }) => {
  const a = await actor(browser, { indexDown: true });
  await openFor(a.page, squatted);
  const p = a.page;
  // Only the standard address could be found without the index, and it is the squatter.
  await expect(ui.lp.pools(p)).toHaveCount(1);
  await expect(ui.lp.pools(p).first()).toHaveAttribute('data-pool', squatPool.address.toBase58());
  await expect(ui.lp.pools(p).first()).toHaveAttribute('data-deposits', 'refused');
  await expect(ui.lp.indexNote(p)).toContainText('There may be other pools');
  expect(a.rpc.violations).toEqual([]);
  await a.ctx.close();
});

// Owner ruling 2026-10-04: a token its creator can freeze was blocked here, its pool refused
// deposits, and Jupiter was never asked for its price. It is allowed now, with a warning on
// the token and again on its pool, and its price is checked like any other token's.
test('a freezable token is allowed with a warning, on the token and on its pool, which takes deposits; Jupiter is asked for its price', async ({ browser }) => {
  const a = await actor(browser);
  await openFor(a.page, freezable);
  const p = a.page;
  await expect(ui.lp.safety(p)).toHaveAttribute('data-verdict', 'warn');
  // The freeze authority is named, and what it can do to a pool is said.
  await expect(ui.lp.safety(p)).toContainText(
    `Its creator can freeze any account that holds it (freeze authority ${stranger.publicKey.toBase58()}), a pool’s own vault and your own account included. While a pool’s vault is frozen, nobody can take liquidity out of that pool.`,
  );
  const card = poolCard(p, freezePool.address);
  await expect(card).toContainText('Standard address, fee tier 0');
  await expect(card).toHaveAttribute('data-price', 'agrees');
  await expect(card).toHaveAttribute('data-deposits', 'allowed');
  // Never a clean pass: the heading says there are warnings, and the pool's own is listed under it.
  await expect(card).toContainText('Deposits: the checks pass, with warnings');
  await expect(ui.lp.poolWarnings(card)).toContainText(
    'Its creator can freeze the vault of this pool, and while it is frozen nobody can take liquidity out, you included. They can also freeze your own account for the token.',
  );
  await expect(ui.lp.status(p)).toHaveText('One pool found for this token.');
  expect(a.jup.asked, 'its price is checked against Jupiter now').toContain(freezable.toBase58());
  expect(a.rpc.violations).toEqual([]);
  await a.ctx.close();
});

test('a Token-2022 token with a transfer hook is refused, it has no pool, and Jupiter is never asked about it', async ({ browser }) => {
  const a = await actor(browser);
  await openFor(a.page, hooked);
  const p = a.page;
  await expect(ui.lp.safety(p)).toHaveAttribute('data-verdict', 'blocked');
  await expect(ui.lp.safety(p)).toContainText('Token-2022');
  await expect(ui.lp.safety(p)).toContainText('a transfer hook');
  // The words say whose limit it is: the pool program's own, so a pool for it could not exist.
  await expect(ui.lp.safety(p)).toContainText('The pool program does not accept tokens with it.');
  await expect(ui.lp.noPools(p)).toBeVisible();
  // A blocked token is never priced: there is nothing to check a price for.
  expect(a.jup.asked).not.toContain(hooked.toBase58());
  expect(a.rpc.violations).toEqual([]);
  await a.ctx.close();
});

test('your positions: the wallet’s own pool share, read from its token accounts, signing nothing', async ({ browser }) => {
  const a = await actor(browser, { wallet: creator });
  const p = a.page;
  await p.goto('/pools');
  await expect(ui.lp.positions(p)).toBeVisible({ timeout: 60_000 });
  await connectWallet(p, ui.lp.positions(p));
  const row = ui.lp.position(p);
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await expect(row).toHaveAttribute('data-pool', cleanPool.address.toBase58());
  await expect(row).toHaveAttribute('data-placement', 'found');
  // The share, from the chain in Node: the creator's LP balance over the pool's LP supply.
  const lpHeld = (await tokenAmount(getAssociatedTokenAddressSync(cleanPool.lpMint, creator.publicKey)))!;
  const pool = decodePoolState(cleanPool.address.toBase58(), (await chain().getAccountInfo(cleanPool.address, 'confirmed'))!.data)!;
  const pct = ((Number(lpHeld) / Number(pool.lpSupply)) * 100).toFixed(4);
  await expect(row).toContainText(`${pct}%`);
  await expect(row).toContainText('no problems found');
  // The row prints addresses short, with the whole one a press away: a token the site has no room for heads it by its short address.
  const mint = clean.toBase58();
  await expect(row).toContainText(`${mint.slice(0, 4)}…${mint.slice(-4)} / SOL`);
  expect(a.wallet!.records, 'reading positions put nothing in front of the wallet').toEqual([]);
  expect(a.rpc.violations).toEqual([]);
  await a.ctx.close();
});

test('phone, iPad and desktop: the finder is pressable, 16px inputs, 44px targets, no sideways scroll', async ({ browser }) => {
  const a = await actor(browser, { viewport: { width: 390, height: 844 } });
  const p = a.page;
  await openFor(p, squatted);
  await expect(ui.lp.pools(p)).toHaveCount(2);
  // Pressable where a person would press it: scrolled to the middle of the screen, as a
  // thumb scrolls, then the browser is asked what is on top at the control's centre. (The
  // shared checkAtSizes scrolls only "if needed", which can leave a control under the
  // section's sticky tab bar; on a phone a person scrolls it out from under that bar.)
  const shots = process.env.E2E_SHOTS_DIR;
  for (const s of SHOT_SIZES) {
    await p.setViewportSize({ width: s.width, height: s.height });
    await expectNoSidewaysScroll(p);
    for (const [loc, what] of [[ui.lp.mintInput(p), 'Token mint address'], [ui.lp.findButton(p), 'Find pools'], [ui.lp.pools(p).first(), 'the first pool']] as const) {
      await loc.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await expectClickable(loc, `${what} (${s.name} ${s.width}px)`);
    }
    if (shots) await p.screenshot({ path: `${shots.replace(/[\\/]+$/, '')}/lp-finder-${test.info().project.name}-${s.name}.png`, fullPage: true });
  }
  for (const size of [390, 820, 1280]) {
    await p.setViewportSize({ width: size, height: 900 });
    await expectNoSidewaysScroll(p);
    const fields = await ui.lp.section(p).locator('input').evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
    expect(fields.length).toBeGreaterThan(0);
    for (const px of fields) expect(px, `input font at ${size}px`).toBeGreaterThanOrEqual(16);
    const buttons = await ui.lp.section(p).locator('button:visible').evaluateAll((els) => els.map((e) => ({ t: (e.textContent ?? '').trim().slice(0, 30), h: e.getBoundingClientRect().height })));
    for (const b of buttons) expect(b.h, `"${b.t}" at ${size}px`).toBeGreaterThanOrEqual(44);
  }
  // A person can search again from the phone.
  await p.setViewportSize({ width: 390, height: 844 });
  await ui.lp.mintInput(p).fill(clean.toBase58());
  await clickReal(ui.lp.findButton(p), 'Find pools');
  await expect(ui.lp.safety(p)).toContainText(clean.toBase58(), { timeout: 30_000 });
  await expect(ui.lp.pools(p)).toHaveCount(1);
  expect(a.rpc.violations).toEqual([]);
  await a.ctx.close();
});

