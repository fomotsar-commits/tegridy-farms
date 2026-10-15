// The /pools page as the liquidity specs drive it (lp-write.spec.ts, lp-create.spec.ts):
// one actor per browser context, the pool cards and position rows, the review's rows, and
// the plans the page should build, worked out in Node from a fresh read of the pool.
//
// Every button pressed goes through `press` (scrolled to the middle of the screen, then
// elementFromPoint), never only toBeVisible.
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { PublicKey, type Keypair } from '@solana/web3.js';
import { landedTx, mintFacts, poolFacts, type PoolFacts } from './chain';
import { SOL_COIN, coinAbout, coinExact, coinOfPool, type Coin } from './coins';
import { installJupiterStub, installPoolIndex, type JupiterStub } from './lp';
import { installRpcGuard, type RpcGuard } from './rpcGuard';
import { installTestWallet, TEST_WALLET_NAME, type TestWallet } from './testWallet';
import { ui, clickReal, connectWallet, expectClickable, signAndWait } from './ui';
import { formatSol, formatTokenAmount } from '../../src/lib/launcher/solana/curve/format';
import { isPlanProblem, planDeposit, planWithdraw, type DepositPlan, type WithdrawPlan } from '../../src/lib/solana/lp/liquidityMath';

export const LP_PENDING_KEY = 'lp:pending';

export type Prices = Map<string, { solPerToken: number; decimals: number }>;

// ── what the page prints, worked out here from Node's numbers (TxFlowView's own formats) ──

export const SOL = (l: bigint) => `${formatSol(l)} SOL`;
export const solExact = (l: bigint) => `${formatSol(l, 9)} SOL`;
export const units = (v: bigint, d: number) => formatTokenAmount(v, d, d).text;
export const tok = (v: bigint, d: number) => formatTokenAmount(v, d).text;
export const signedSol = (l: bigint) => `${l < 0n ? '-' : '+'}${SOL(l < 0n ? -l : l)}`;
export const signedTok = (v: bigint, d: number) => `${v < 0n ? '-' : '+'}${tok(v < 0n ? -v : v, d)}`;
export const pct = (n: bigint, d: bigint) => (d > 0n ? (Number(n) / Number(d)) * 100 : 0);
export const shareText = (p: number) => (!Number.isFinite(p) || p <= 0 ? 'none' : p < 0.01 ? '<0.01%' : `${p.toFixed(2)}%`);
export const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── the pool, read in Node ─────────────────────────────────────────────────────

/**
 * The two sides of a pool: its pairing coin (SOL, USDC or BAYLA, by the rank in coins.ts)
 * and the token priced in it. `solIs0` and `solVault` are the coin's side under the names
 * the SOL-pool specs were written with: for a SOL pool they are the SOL side, and for any
 * other pool the same values as `coinIs0` and `coinVault`.
 */
export interface Sides {
  coin: Coin;
  coinIs0: boolean;
  coinVault: PublicKey;
  solIs0: boolean;
  solVault: PublicKey;
  lpMint: PublicKey;
  tokenMint: PublicKey;
  tokenProgram: PublicKey;
  tokenVault: PublicKey;
}
export function sidesOf(f: PoolFacts): Sides {
  const p = f.pool;
  const pair = coinOfPool(p.token0Mint, p.token1Mint);
  if (!pair) throw new Error(`pool ${f.address.toBase58()} is not paired with SOL, USDC or BAYLA`);
  const { coin, coinIs0 } = pair;
  const coinVault = new PublicKey(coinIs0 ? p.token0Vault : p.token1Vault);
  return {
    coin,
    coinIs0,
    coinVault,
    solIs0: coinIs0,
    solVault: coinVault,
    lpMint: new PublicKey(p.lpMint),
    tokenMint: new PublicKey(coinIs0 ? p.token1Mint : p.token0Mint),
    tokenProgram: new PublicKey(coinIs0 ? p.token1Program : p.token0Program),
    tokenVault: new PublicKey(coinIs0 ? p.token1Vault : p.token0Vault),
  };
}

/**
 * A deposit plan the page should build: the pool's own answer, with no balance rule (every
 * actor here holds plenty). `driving` is the box typed in: the coin's (`'sol'` in the
 * SOL-pool specs, `'coin'` for any coin) or the token's. The coin's side comes back as
 * `costSol` / `maxSol`, in the coin's own base units whatever the coin is.
 */
export function depositPlan(f: PoolFacts, driving: 'sol' | 'coin' | 'token', maxIn: bigint, bps = 100n): DepositPlan & { costSol: bigint; costTok: bigint; maxSol: bigint; maxTok: bigint } {
  const s = sidesOf(f);
  const plan = planDeposit(f.snapshot, { quoteIsToken0: s.coinIs0, driving: driving === 'token' ? 'token' : 'quote', maxIn, bps, availableQuote: null, availableToken: null });
  if (isPlanProblem(plan)) throw new Error(`deposit plan: ${plan.problem}`);
  return {
    ...plan,
    costSol: s.coinIs0 ? plan.cost0 : plan.cost1,
    costTok: s.coinIs0 ? plan.cost1 : plan.cost0,
    maxSol: s.coinIs0 ? plan.max0 : plan.max1,
    maxTok: s.coinIs0 ? plan.max1 : plan.max0,
  };
}

/** A withdrawal plan the page should build. The coin's side comes back as `minSol` / `outSol`, in the coin's own base units. */
export function withdrawPlan(f: PoolFacts, held: bigint, pctBps: bigint, bps = 100n): WithdrawPlan & { minSol: bigint; minTok: bigint; outSol: bigint; outTok: bigint } {
  const s = sidesOf(f);
  const plan = planWithdraw(f.snapshot, { held, pctBps, bps });
  if (isPlanProblem(plan)) throw new Error(`withdraw plan: ${plan.problem}`);
  return {
    ...plan,
    minSol: s.coinIs0 ? plan.min0 : plan.min1,
    minTok: s.coinIs0 ? plan.min1 : plan.min0,
    outSol: s.coinIs0 ? plan.out0 : plan.out1,
    outTok: s.coinIs0 ? plan.out1 : plan.out0,
  };
}

// ── the browser side ───────────────────────────────────────────────────────────

export interface Actor { ctx: BrowserContext; page: Page; rpc: RpcGuard; jup: JupiterStub; index: { calls: string[] }; wallet: TestWallet }

export async function actor(
  browser: Browser,
  kp: Keypair,
  o: { prices: Prices; indexDown?: boolean; indexOmit?: Set<string>; routeThrough?: PublicKey; down?: Set<string>; versions?: ('legacy' | 0)[] },
): Promise<Actor> {
  const ctx = await browser.newContext();
  const wallet = await installTestWallet(ctx, kp, TEST_WALLET_NAME, o.versions ? { versions: o.versions } : {});
  const rpc = await installRpcGuard(ctx);
  const index = await installPoolIndex(ctx, { down: o.indexDown, omit: o.indexOmit });
  const jup = await installJupiterStub(ctx, o.prices, { routeThrough: o.routeThrough, down: o.down });
  const page = await ctx.newPage();
  // A reload while a transaction is in the air asks first; the person says yes.
  page.on('dialog', (d) => void d.accept());
  return { ctx, page, rpc, jup, index, wallet };
}

export async function openPools(p: Page, mint?: PublicKey, extra = ''): Promise<void> {
  await p.goto(`/pools${mint ? `?mint=${mint.toBase58()}${extra}` : ''}`);
  await expect(ui.lp.section(p)).toBeVisible({ timeout: 60_000 });
  if (mint) await expect(ui.lp.safety(p)).toBeVisible({ timeout: 60_000 });
}

export const connect = (p: Page) => connectWallet(p, ui.lp.positions(p));

/**
 * Scrolled to the middle of the screen first, as a person scrolls to it: "scroll if
 * needed" can stop with the control just under the page's sticky tab bar, which is not
 * where anyone presses it. Then the browser is asked what is on top at its centre.
 */
export async function centre(loc: Locator, what: string): Promise<void> {
  await expect(loc, `${what} should be visible`).toBeVisible();
  await loc.evaluate((el) => el.scrollIntoView({ block: 'center' }));
}
export async function pressable(loc: Locator, what: string): Promise<void> {
  await centre(loc, what);
  await expectClickable(loc, what);
}
export async function press(loc: Locator, what: string): Promise<void> {
  await centre(loc, what);
  await clickReal(loc, what);
}

/** After a reload the wallet usually reconnects on its own; connect again only when it did not. */
export async function ensureConnected(p: Page): Promise<void> {
  const positions = ui.lp.positions(p);
  await expect(positions).toBeVisible({ timeout: 60_000 });
  const ask = positions.getByText('Connect a Solana wallet to see the pool shares it holds');
  try {
    await expect(ask).toBeHidden({ timeout: 10_000 });
  } catch {
    await connect(p);
  }
}

/**
 * Wait until a pool just opened is open by the WALL clock. A pool's open time is set from
 * the validator's clock, which runs ahead of this machine's (chain.ts
 * waitForPoolOpenByWallClock), and a browser judges "open" on its own clock.
 */
export async function waitPoolOpenByWallClock(pool: PublicKey, maxMs = 5 * 60_000): Promise<void> {
  const open = Number((await poolFacts(pool)).pool.openTime);
  const waitMs = Math.max(0, (open + 2) * 1000 - Date.now());
  if (waitMs > maxMs) throw new Error(`the pool opens ${Math.round(waitMs / 1000)} s from now by the wall clock: the validator clock has drifted too far, restart it`);
  await new Promise((r) => setTimeout(r, waitMs));
}

export const poolCard = (p: Page, address: PublicKey | string) => p.locator(`[data-testid="lp-pool"][data-pool="${typeof address === 'string' ? address : address.toBase58()}"]`);
export const positionRow = (p: Page, pool: PublicKey | string) => p.locator(`[data-testid="lp-position"][data-pool="${typeof pool === 'string' ? pool : pool.toBase58()}"]`);
/** A position by its share token, for a share with no pool yet: the row prints addresses short, so its text no longer names the whole mint. */
export const shareRow = (p: Page, lpMint: PublicKey | string) => p.locator(`[data-testid="lp-position"][data-lp-mint="${typeof lpMint === 'string' ? lpMint : lpMint.toBase58()}"]`);
export const pendingNotes = (p: Page) => p.evaluate((k) => sessionStorage.getItem(k), LP_PENDING_KEY);

/** The review's rows, label → value, as a person reads them. */
export async function reviewRows(p: Page): Promise<Record<string, string>> {
  await expect(ui.review(p)).toBeVisible({ timeout: 60_000 });
  return ui.review(p).evaluate((el) => {
    const out: Record<string, string> = {};
    for (const row of Array.from(el.querySelectorAll('div'))) {
      const kids = Array.from(row.children);
      if (kids.length === 2 && kids.every((k) => k.tagName === 'SPAN')) out[(kids[0]!.textContent ?? '').trim()] = (kids[1]!.textContent ?? '').trim();
    }
    return out;
  });
}

/** Open Add on a pool card; returns the panel, with the wallet's balances read. `coin` is the pool's pairing coin (SOL unless said). */
export async function openAdd(p: Page, pool: PublicKey, coin: Coin = SOL_COIN): Promise<{ card: Locator; panel: Locator }> {
  const card = poolCard(p, pool);
  await expect(card).toHaveAttribute('data-add', 'offer', { timeout: 60_000 });
  await press(ui.lp.addButton(card), 'Add liquidity');
  const panel = ui.lp.addPanel(card);
  await expect(panel).toBeVisible();
  // Max is offered once the wallet's balances are read.
  await expect(ui.lp.maxCoin(panel, coin.symbol)).toBeVisible({ timeout: 30_000 });
  return { card, panel };
}

/** Open Remove on a position row; returns the panel. */
export async function openRemove(row: Locator): Promise<Locator> {
  await expect(row).toHaveAttribute('data-remove', 'offer', { timeout: 60_000 });
  await press(ui.lp.removeButton(row), 'Remove liquidity');
  const panel = ui.lp.removePanel(row);
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * Close the outcome card (back to the panel's form: the pools and positions are read
 * again), then the panel. After taking ALL of a share out, the re-read drops its row and
 * the panel goes with it (`rowGoes`): then there is no panel left to close.
 */
export async function closeAll(p: Page, panel: Locator, o: { rowGoes?: boolean } = {}): Promise<void> {
  const outcome = ui.outcome(p);
  if (await outcome.count()) {
    const btn = outcome.getByRole('button', { name: /^(Close|Start over)$/ });
    await press(btn, 'close the outcome');
  }
  if (!o.rowGoes) await press(panel.getByRole('button', { name: 'Close', exact: true }), 'close the panel');
  await expect(panel).toHaveCount(0, { timeout: 60_000 });
}

/** Sign what is on screen and require it confirmed; returns the signature and the landed transaction. */
export async function signConfirmed(a: Actor) {
  const status = await signAndWait(a.page);
  expect(status, await ui.outcome(a.page).innerText()).toBe('confirmed');
  const signature = a.wallet.lastSigned().signature!;
  await expect(ui.outcome(a.page)).toContainText(signature);
  const t = await landedTx(signature);
  expect(t.meta?.err ?? null).toBeNull();
  return { signature, t };
}

/** Add `coinText` of the pool's coin to `pool` (typing the coin's box: SOL unless said), and wait for Review to be offered. */
export async function addAndReview(a: Actor, pool: PublicKey, coinText: string, bps = 100n, coin: Coin = SOL_COIN) {
  const { card, panel } = await openAdd(a.page, pool, coin);
  if (bps !== 100n) await press(panel.getByRole('button', { name: `${Number(bps) / 100}%`, exact: true }), 'slippage preset');
  await ui.lp.coinToAdd(panel, coin.symbol).fill(coinText);
  await expect(ui.lp.reviewAdd(panel)).toBeEnabled({ timeout: 30_000 });
  return { card, panel };
}

/**
 * Press Review on an Add panel, and check the review against Node's plan for the pool as
 * it is now. Every amount on the coin's side is checked in the pool's own coin, read from
 * the pool itself (`sidesOf`), and the review must name that coin.
 */
export async function reviewDeposit(a: Actor, panel: Locator, pool: PublicKey, driving: 'sol' | 'coin' | 'token', maxIn: bigint, bps = 100n) {
  await press(ui.lp.reviewAdd(panel), 'Review: add liquidity');
  const rows = await reviewRows(a.page);
  const f = await poolFacts(pool);
  const plan = depositPlan(f, driving, maxIn, bps);
  const s = sidesOf(f);
  const decimals = (await mintFacts(s.tokenMint)).decimals;
  expect(rows['Pool']).toBe(pool.toBase58());
  expect(rows['Token (mint)']).toBe(s.tokenMint.toBase58());
  expect(rows['Paired with']).toBe(s.coin.symbol);
  expect(rows['You get']).toBe(`${units(plan.lp, f.pool.lpMintDecimals)} pool shares, exactly`);
  expect(rows['You put in about']).toBe(`${coinAbout(plan.costSol, s.coin)} and ${tok(plan.costTok, decimals)} tokens`);
  expect(rows['At most']).toMatch(new RegExp(`^${esc(`${coinExact(plan.maxSol, s.coin)} and ${units(plan.maxTok, decimals)} tokens`)}`));
  return { rows, f, plan, s, decimals };
}
