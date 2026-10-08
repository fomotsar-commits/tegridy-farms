// The Solana swap sends a trade to OUR pool when it pays at least as much as Jupiter,
// and to Jupiter when it does not: the page itself, a real signature, the mainnet pool
// program on a local validator. The pool has the shape of the first one on mainnet: a
// Token-2022 token paired with SOL on fee tier 1, at its standard address. Every number
// is checked against one worked out HERE from the vaults and the program's sum, written
// out below: never from the app's quote function, which could agree with itself.
import { expect, test, type Page, type Route } from '@playwright/test';
import { PublicKey, type Keypair } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { formatSol, formatTokenAmount } from '../src/lib/launcher/solana/curve/format';
import { ata, fundedKeypair, lamports, poolFacts, sol, tokenAmount, WSOL } from './fixtures/chain';
import { createSolPool, createToken2022MetadataOnly, transferTokens, type CreatedPool } from './fixtures/lp';
import { actor, press, type Actor } from './fixtures/lpPage';
import { ui, connectWallet } from './fixtures/ui';

const UNIT = 1_000_000n;
const POOL_SOL = sol(10);
const POOL_TOKENS = 1_000_000n * UNIT;
/** The pool's own price: 0.00001 SOL a token. */
const POOL_PRICE = 1e-5;
/** Tier 1 on the validator, as on mainnet: 1% a trade, in parts per million. */
const TIER1_FEE_PPM = 10_000n;

let creator: Keypair;
let mint: PublicKey;
let pool: CreatedPool;

/** The pool program's swap sum, written out: fee rounded up, payout rounded down. */
function poolPays(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const fee = (amountIn * TIER1_FEE_PPM + 999_999n) / 1_000_000n;
  const net = amountIn - fee;
  return (net * reserveOut) / (reserveIn + net);
}

/** The pool's two vault balances, read in Node. Nothing has accrued fees it owes at first; later reads take them off. */
async function reserves(): Promise<{ sol: bigint; tokens: bigint }> {
  const f = await poolFacts(pool.address);
  const solIs0 = f.pool.token0Mint === WSOL.toBase58();
  return { sol: solIs0 ? f.snapshot.reserve0 : f.snapshot.reserve1, tokens: solIs0 ? f.snapshot.reserve1 : f.snapshot.reserve0 };
}

const tokenText = (raw: bigint) => formatTokenAmount(raw, 6).text;
const routeLine = (p: Page) => p.getByTestId('solana-route-line');
const buy = (p: Page) => p.getByRole('button', { name: 'Buy ROUTE', exact: true });
const tokenAccount = (owner: PublicKey) => ata(mint, owner, TOKEN_2022_PROGRAM_ID);

/**
 * One trader's browser on /solana with this spec's token as the one to buy. Jupiter is
 * stubbed to quote the token at `jupiterPrice` SOL (less its own 0.5%); the token search
 * the page uses to learn an unknown mint's decimals answers for this mint.
 */
async function trader(browser: Parameters<typeof actor>[0], kp: Keypair, jupiterPrice: number): Promise<Actor> {
  const a = await actor(browser, kp, { prices: new Map([[mint.toBase58(), { solPerToken: jupiterPrice, decimals: 6 }]]) });
  await a.ctx.route('**/api/jupiter/tokens/v2/search?*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: mint.toBase58(), symbol: 'ROUTE', name: 'Route Test', decimals: 6, isVerified: true, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() }]),
    }),
  );
  return a;
}

/**
 * ONE PRESS. After Buy the wallet is asked with no review screen and no second button,
 * and one line says the swap landed: no card to close. The chain is what each test
 * checks the amounts against.
 */
async function landed(a: Actor, words: string): Promise<void> {
  await expect.poll(() => a.wallet.signed().length, { timeout: 90_000 }).toBe(1);
  await expect(a.page.getByText(words, { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(ui.review(a.page)).toHaveCount(0);
  await expect(ui.outcome(a.page)).toHaveCount(0);
  await expect(a.page.getByRole('button', { name: 'Sign in wallet' })).toHaveCount(0);
}

async function openSwap(p: Page, query: string): Promise<void> {
  await p.goto(`/solana?${query}`);
  await expect(p.getByRole('heading', { name: 'Solana Swap' })).toBeVisible({ timeout: 60_000 });
}

test.beforeAll(async () => {
  creator = await fundedKeypair(30);
  mint = await createToken2022MetadataOnly(creator, { name: 'Route Test', symbol: 'ROUTE', supply: 10_000_000n * UNIT });
  pool = await createSolPool(creator, mint, { configIndex: 1, sol: POOL_SOL, tokens: POOL_TOKENS, at: 'standard', tokenProgram: TOKEN_2022_PROGRAM_ID });
  expect(pool.standard).toBe(true);
});

test('our pool pays more: one press of Buy, the wallet signs a swap in our pool, and the chain holds the trade', async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  const me = await fundedKeypair(5);
  // Jupiter prices the token 20% dearer than our pool does.
  const a = await trader(browser, me, POOL_PRICE * 1.2);
  const p = a.page;
  await openSwap(p, `out=${mint.toBase58()}`);
  await expect(buy(p).or(p.getByRole('button', { name: 'Connect Solana Wallet' }).first())).toBeVisible({ timeout: 60_000 });
  await connectWallet(p);

  const amountIn = sol(0.1);
  const before = await reserves();
  const expected = poolPays(amountIn, before.sol, before.tokens);
  await p.getByLabel('Amount of SOL to pay').fill('0.1');

  // The line names our pool as the route, and the figure on the page is our pool's.
  await expect(routeLine(p)).toContainText('Our pool pays', { timeout: 60_000 });
  await expect(routeLine(p)).toContainText('more than Jupiter.');
  await expect(routeLine(p)).not.toContainText('executes via Jupiter');
  await expect(p.getByTestId('own-pool-fee')).toContainText('1%');
  await expect(p.getByTestId('swap-footer')).toHaveText('No platform fee on a swap in our own pool.');
  // A verified token paired with SOL: nothing to tick before Buy.
  await expect(p.getByRole('checkbox')).toHaveCount(0);
  await expect(p.getByTestId('solana-receive')).toHaveText(new RegExp(`^${tokenText(expected).replace(/,/g, '').split('.')[0]}`));

  // Buy: the wallet, never Jupiter's transaction.
  const jupiterBuilds: string[] = [];
  p.on('request', (r) => {
    if (r.url().includes('/api/jupiter/swap/v1/swap')) jupiterBuilds.push(r.url());
  });
  const solBefore = await lamports(me.publicKey);
  await press(buy(p), 'Buy ROUTE');
  await landed(a, 'Bought ROUTE');
  expect(jupiterBuilds).toEqual([]);
  // The form is back and empty, so the same buy is not one press away.
  await expect(p.getByLabel('Amount of SOL to pay')).toHaveValue('');

  // The chain: exactly what the pool's own sum pays, in the signer's own Token-2022
  // account; the pool took the SOL and gave the tokens; no wrapped-SOL account is left.
  expect(await tokenAmount(tokenAccount(me.publicKey))).toBe(expected);
  const after = await reserves();
  expect(before.tokens - after.tokens).toBe(expected);
  expect(after.sol).toBeGreaterThan(before.sol);
  expect(await tokenAmount(ata(WSOL, me.publicKey))).toBe(null);
  const spent = solBefore - (await lamports(me.publicKey));
  // 0.1 SOL, the new token account's deposit, and the network fee: nothing else.
  expect(spent).toBeGreaterThan(amountIn);
  expect(spent).toBeLessThan(amountIn + sol(0.004));
  expect(jupiterBuilds).toEqual([]);
  expect(a.rpc.violations).toEqual([]);
  await a.ctx.close();
});

test('a sale: our pool pays more SOL than Jupiter, and the SOL arrives as plain SOL', async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  const me = await fundedKeypair(5);
  // Something to sell: the creator sends it.
  await transferTokens(creator, me.publicKey, mint, 50_000n * UNIT);
  // Jupiter pays 20% less SOL for the token than our pool's price.
  const a = await trader(browser, me, POOL_PRICE * 0.8);
  const p = a.page;
  await openSwap(p, `in=${mint.toBase58()}&out=${WSOL.toBase58()}`);
  await connectWallet(p);

  const amountIn = 5_000n * UNIT;
  const before = await reserves();
  const expected = poolPays(amountIn, before.tokens, before.sol);
  await p.getByLabel('Amount of ROUTE to pay').fill('5000');
  await expect(routeLine(p)).toContainText('Our pool pays', { timeout: 60_000 });

  const tokensBefore = (await tokenAmount(tokenAccount(me.publicKey)))!;
  const solBefore = await lamports(me.publicKey);
  // The page's figure for what the sale pays is the pool's own sum.
  await expect(p.getByTestId('solana-receive')).toHaveText(new RegExp(`^${formatSol(expected).slice(0, 6).replace('.', '\\.')}`));
  await press(p.getByRole('button', { name: 'Sell ROUTE', exact: true }), 'Sell ROUTE');
  await landed(a, 'Sold ROUTE');

  expect(tokensBefore - (await tokenAmount(tokenAccount(me.publicKey)))!).toBe(amountIn);
  const gained = (await lamports(me.publicKey)) - solBefore;
  // What the pool paid, less only the network fee.
  expect(gained).toBeLessThanOrEqual(expected);
  expect(gained).toBeGreaterThan(expected - sol(0.002));
  expect(await tokenAmount(ata(WSOL, me.publicKey))).toBe(null);
  expect(a.rpc.violations).toEqual([]);
  await a.ctx.close();
});

test('Jupiter pays more: the line says so, and Buy builds Jupiter’s transaction, never a swap in our pool', async ({ browser }) => {
  test.setTimeout(3 * 60_000);
  const me = await fundedKeypair(2);
  // Jupiter prices the token 20% cheaper than our pool does.
  const a = await trader(browser, me, POOL_PRICE * 0.8);
  const p = a.page;
  await openSwap(p, `out=${mint.toBase58()}`);
  await connectWallet(p);
  await p.getByLabel('Amount of SOL to pay').fill('0.1');
  await expect(routeLine(p)).toContainText('Jupiter pays', { timeout: 60_000 });
  await expect(routeLine(p)).toContainText('more than our pool.');
  await expect(p.getByTestId('own-pool-fee')).toHaveCount(0);

  // Jupiter's build is not stubbed on this chain (it answers 502), so the swap stops there:
  // what matters is WHICH venue was asked to build.
  const build = p.waitForRequest((r) => r.url().includes('/api/jupiter/swap/v1/swap'), { timeout: 60_000 });
  await press(buy(p), 'Buy ROUTE');
  await build;
  await expect(ui.review(p)).toHaveCount(0);
  expect(a.wallet.signed().length).toBe(0);
  expect(await tokenAmount(tokenAccount(me.publicKey))).toBe(null);
  expect(a.rpc.violations).toEqual([]);
  await a.ctx.close();
});

test('the route is held when Buy is pressed: Jupiter moved past our pool since the quote, so nothing is built and the form shows the new route', async ({ browser }) => {
  test.setTimeout(3 * 60_000);
  const me = await fundedKeypair(2);
  const a = await trader(browser, me, POOL_PRICE * 1.2);
  const p = a.page;
  await openSwap(p, `out=${mint.toBase58()}`);
  await connectWallet(p);
  await p.getByLabel('Amount of SOL to pay').fill('0.1');
  await expect(routeLine(p)).toContainText('Our pool pays', { timeout: 60_000 });

  // Between the quote on screen and the press, Jupiter's price drops under our pool's.
  a.jup.setPrice(mint.toBase58(), POOL_PRICE * 0.8);
  await press(buy(p), 'Buy ROUTE');
  // One line says why, and the form is already on the route as it is now: nothing to close.
  await expect(p.getByText('Jupiter now pays more for this trade than our own pool, so nothing was sent. Press again to take the better route.')).toBeVisible({ timeout: 90_000 });
  await expect(routeLine(p)).toContainText('Jupiter pays', { timeout: 60_000 });
  await expect(ui.outcome(p)).toHaveCount(0);
  await expect(p.getByLabel('Amount of SOL to pay')).toHaveValue('0.1');
  expect(a.wallet.signed().length).toBe(0);
  expect(await tokenAmount(tokenAccount(me.publicKey))).toBe(null);
  expect(a.rpc.violations).toEqual([]);
  await a.ctx.close();
});
