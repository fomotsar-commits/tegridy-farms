// The pool card on /pools against the mainnet cp-swap binary on the local validator
// (DESIGN 2.C1): headed by its pair and tier, the trade record the program itself writes
// (A2: "No trade has reached this pool yet." until a swap flips the price record), the depth
// above the Add button, the venue's books folded away, and on a press the pool's last 20
// transactions (B1) within a read budget of 21 calls.
//
// Fixtures from Node: one classic token with one tier-1 pool at its standard address, priced
// at the stub's market. A swap lands from Node between two reads; a deposit goes through the
// page's own Add form, so the past counts it under deposits. Every amount the page prints is
// worked out HERE from the chain (the vault's delta, the landed transaction's block time),
// never from the page. Runs as chromium AND as a phone (mobile-chrome), like every lp-* spec.
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { Keypair, PublicKey } from '@solana/web3.js';
import { chain, fundedKeypair, landedTx, poolFacts, sol, tokenAmount } from './fixtures/chain';
import { installRpcGuard, type RpcGuard } from './fixtures/rpcGuard';
import { ui, clickReal, expectClickable } from './fixtures/ui';
import { createClassicToken, createSolPool, installJupiterStub, installPoolIndex, swapDirect, type CreatedPool } from './fixtures/lp';
import { actor as walletActor, addAndReview, closeAll, connect, openAdd, openPools, poolCard, press, sidesOf, signConfirmed, type Prices } from './fixtures/lpPage';
import { quoteText, shortAddress } from '../src/lib/solana/lp/format';
import { SOL_QUOTE } from '../src/lib/solana/lp/quotes';
import { formatWhen } from '../src/lib/solana/lp/poolHealth';
import { NO_TRADE_YET, POOL_PAST_BUTTON } from '../src/lib/solana/lp/poolPast';

const DEC = 6;
const UNIT = 10n ** BigInt(DEC);
/** The fixture pool is priced at 1 SOL per million tokens, and the stub quotes the same. */
const FAIR = 1e-6;
/** One pool-past press: one getSignaturesForAddress plus one batch of at most 20 getTransaction (B1). */
const PAST_BUDGET = 21;

let creator: Keypair;
let trader: Keypair;
let mint: PublicKey;
let pool: CreatedPool;

test.beforeAll(async () => {
  test.setTimeout(6 * 60_000);
  creator = await fundedKeypair(20);
  trader = await fundedKeypair(5);
  mint = await createClassicToken(creator, { supply: 10_000_000n * UNIT, name: { name: 'E2E Card', symbol: 'ECARD' } });
  pool = await createSolPool(creator, mint, { configIndex: 1, sol: sol(2), tokens: 2_000_000n * UNIT, at: 'standard' });
});

const prices = (): Prices => new Map([[mint.toBase58(), { solPerToken: FAIR, decimals: DEC }]]);

interface Reader { ctx: BrowserContext; page: Page; rpc: RpcGuard }

/** A visitor with no wallet: the guard, the real pool index in process, the price stub. */
async function reader(browser: Browser): Promise<Reader> {
  const ctx = await browser.newContext();
  const rpc = await installRpcGuard(ctx);
  await installPoolIndex(ctx);
  await installJupiterStub(ctx, prices());
  const page = await ctx.newPage();
  return { ctx, page, rpc };
}

const card = (p: Page) => poolCard(p, pool.address);
const heading = (p: Page) => card(p).getByRole('heading', { level: 3 });
const tradeRecord = (p: Page) => card(p).getByTestId('lp-pool-trade');
const fold = (p: Page) => card(p).getByTestId('lp-pool-more');
const pastText = (p: Page) => card(p).getByTestId('lp-pool-past-text');
/** The lookup's one Read again, in the finder's form (the card's own stamp carries none). */
const readAgain = (p: Page) => p.getByTestId('lp-finder').getByRole('button', { name: 'Read again', exact: true });

/** Open the fold and press the pool past under the `card-past` label; returns the sentence once it is on the page. */
async function readPast(a: { page: Page; rpc: RpcGuard }) {
  const p = a.page;
  if (!(await fold(p).evaluate((el) => (el as HTMLDetailsElement).open))) await press(fold(p).locator('summary'), 'More about this pool');
  a.rpc.view('card-past');
  await press(card(p).getByRole('button', { name: POOL_PAST_BUTTON, exact: true }), POOL_PAST_BUTTON);
  await expect(pastText(p)).toBeVisible({ timeout: 60_000 });
  return pastText(p);
}

test('a pool nobody has traded: headed by its pair and tier, No trade has reached this pool yet., the depth above the Add button, the books folded away', async ({ browser }) => {
  const a = await reader(browser);
  const p = a.page;
  await openPools(p, mint);
  await expect(ui.lp.pools(p)).toHaveCount(1);
  // The token is not in the site's registry, so the heading carries its short mint, never the name the token claims.
  await expect(heading(p)).toHaveText(`${shortAddress(mint.toBase58())} / SOL · 1% tier`);
  await expect(heading(p)).not.toContainText('ECARD');
  await expect(card(p)).toContainText('Standard address for its tier');
  await expect(card(p)).toContainText('2 SOL and 2,000,000 tokens');
  await expect(tradeRecord(p)).toHaveText(NO_TRADE_YET);
  await expect(card(p)).toHaveAttribute('data-price', 'agrees');
  // The read stamp is on the card.
  await expect(card(p).getByTestId('lp-read-at')).toContainText(/^Read (just now|\d+ s ago)$/);
  // The depth sits above the Add button (a phone read the form a screen before the depth, MAP 3.33).
  await expect(card(p)).toHaveAttribute('data-add', 'offer', { timeout: 60_000 });
  const depth = await card(p).getByText('In the pool', { exact: true }).boundingBox();
  const add = await ui.lp.addButton(card(p)).boundingBox();
  expect(depth && add && depth.y + depth.height <= add.y, 'In the pool should be above the Add button').toBe(true);
  // The venue's books are in the closed fold: not on the open card.
  await expect(fold(p)).not.toHaveAttribute('open');
  await expect(card(p).getByText('Venue’s share of fees waiting')).toBeHidden();
  await expect(card(p).getByText('Opened by', { exact: true })).toBeHidden();
  await expectClickable(fold(p).locator('summary'), 'More about this pool');
  expect(a.rpc.violations).toEqual([]);
  await a.ctx.close();
});

test('a swap from Node, then Read again: Last trade at the swap’s block time; the pool past press prints 1 swap and the exact amount in, within 21 calls', async ({ browser }) => {
  test.setTimeout(4 * 60_000);
  const a = await reader(browser);
  const p = a.page;
  await openPools(p, mint);
  await expect(tradeRecord(p)).toHaveText(NO_TRADE_YET);

  // The swap: 0.1 SOL in, from Node, settled to finalized. The amount the pool took in is the
  // coin vault's delta, read here, never the argument the page might echo.
  const s = sidesOf(await poolFacts(pool.address));
  const vaultBefore = (await tokenAmount(s.solVault)) ?? 0n;
  const { signature } = await swapDirect(trader, pool.address, sol(0.1));
  const vaultAfter = (await tokenAmount(s.solVault)) ?? 0n;
  const inAmount = vaultAfter - vaultBefore;
  expect(inAmount).toBeGreaterThan(0n);
  const t = await landedTx(signature);
  expect(t.blockTime, 'the validator stamps every block').not.toBeNull();

  await clickReal(readAgain(p), 'Read again');
  await expect(tradeRecord(p)).toHaveText(`Last trade: ${formatWhen(BigInt(t.blockTime!))}`, { timeout: 60_000 });
  await expect(card(p)).not.toContainText(/\bactive\b/i);

  const text = await readPast(a);
  await expect(text).toHaveAttribute('data-kind', 'ok');
  // The opening counted as an opening, the swap as a swap, the amount in to the lamport.
  await expect(text).toContainText('1 swap,');
  await expect(text).toContainText('1 opening');
  await expect(text).toContainText(`Traded in: ${quoteText(inAmount, SOL_QUOTE)} and 0 tokens.`);
  await expect(text).toContainText('the rate can change, so no total is shown');
  await expect(text).not.toContainText(/fees? (earned|so far|total)/i);
  expect(a.rpc.count('card-past'), 'one signatures page and one batch of transactions').toBeLessThanOrEqual(PAST_BUDGET);
  expect(a.rpc.violations).toEqual([]);
  await a.ctx.close();
});

test('a deposit through the page’s own Add form is counted under deposits by the pool past', async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  const a = await walletActor(browser, creator, { prices: prices() });
  const p = a.page;
  await openPools(p, mint);
  await connect(p);
  const { panel } = await addAndReview(a, pool.address, '0.25');
  await press(ui.lp.reviewAdd(panel), 'Review: add liquidity');
  await signConfirmed(a);
  await closeAll(p, panel);

  await clickReal(readAgain(p), 'Read again');
  await expect(ui.lp.pools(p)).toHaveCount(1);
  const text = await readPast(a);
  await expect(text).toHaveAttribute('data-kind', 'ok');
  await expect(text).toContainText(/\b1 deposit from 1 wallet\b/);
  await expect(text).toContainText('1 opening');
  expect(a.rpc.count('card-past')).toBeLessThanOrEqual(PAST_BUDGET);
  expect(a.rpc.violations).toEqual([]);
  await a.ctx.close();
});

test('with the Add form open, In the pool sits above the amount boxes (a phone read it a screen below)', async ({ browser }) => {
  const a = await walletActor(browser, creator, { prices: prices() });
  const p = a.page;
  await openPools(p, mint);
  await connect(p);
  const { card: c, panel } = await openAdd(p, pool.address);
  const depth = await c.getByText('In the pool', { exact: true }).boundingBox();
  const coinBox = await ui.lp.coinToAdd(panel, 'SOL').boundingBox();
  const tokenBox = await ui.lp.tokensToAdd(panel).boundingBox();
  expect(depth && coinBox && depth.y + depth.height <= coinBox.y, 'In the pool should be above the SOL box').toBe(true);
  expect(depth && tokenBox && depth.y + depth.height <= tokenBox.y, 'In the pool should be above the tokens box').toBe(true);
  expect(a.rpc.violations).toEqual([]);
  await a.ctx.close();
});

test('reading the card signs nothing and never scans the program', async ({ browser }) => {
  const a = await reader(browser);
  await openPools(a.page, mint);
  await expect(ui.lp.pools(a.page)).toHaveCount(1);
  await readPast(a);
  expect(a.rpc.violations).toEqual([]);
  // Node's own view of the chain: the pool is still the one the card shows.
  const raw = await chain().getAccountInfo(pool.address, 'confirmed');
  expect(raw).not.toBeNull();
  await a.ctx.close();
});
