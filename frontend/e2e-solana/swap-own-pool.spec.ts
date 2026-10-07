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
import { ui, connectWallet, signAndWait } from './fixtures/ui';

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

test('our pool pays more: Buy opens the review of a swap in our pool, the wallet signs it, and the chain holds the trade', async ({ browser }) => {
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
  await expect(routeLine(p)).toContainText('Routed to the venue pool:', { timeout: 60_000 });
  await expect(routeLine(p)).toContainText('more output than Jupiter.');
  await expect(routeLine(p)).toContainText('Checked our pool and Jupiter.');
  await expect(routeLine(p)).not.toContainText('executes via Jupiter');
  await expect(p.getByTestId('own-pool-fee')).toContainText('1%');
  await expect(p.getByTestId('swap-footer')).toContainText('This swap goes through our own pool.');
  await expect(p.getByTestId('solana-receive')).toHaveText(new RegExp(`^${tokenText(expected).replace(/,/g, '').split('.')[0]}`));

  // Buy: the review, never Jupiter's transaction.
  const jupiterBuilds: string[] = [];
  p.on('request', (r) => {
    if (r.url().includes('/api/jupiter/swap/v1/swap')) jupiterBuilds.push(r.url());
  });
  const solBefore = await lamports(me.publicKey);
  await press(buy(p), 'Buy ROUTE');
  const review = ui.review(p);
  await expect(review).toBeVisible({ timeout: 90_000 });
  await expect(review.getByRole('heading', { name: 'Review your swap' })).toBeVisible();
  await expect(review).toContainText(pool.address.toBase58());
  await expect(review).toContainText('Standard address for fee tier 1');
  await expect(review).toContainText(mint.toBase58());
  await expect(review).toContainText(`${formatSol(amountIn, 9)} SOL`);
  await expect(review).toContainText(`${tokenText(expected)} tokens`);
  await expect(review).toContainText('more than Jupiter quoted just now');
  await expect(review).toContainText('Test run passed');
  expect(jupiterBuilds).toEqual([]);

  expect(await signAndWait(p)).toBe('confirmed');
  expect(a.wallet.signed().length).toBe(1);

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
  await expect(routeLine(p)).toContainText('Routed to the venue pool:', { timeout: 60_000 });

  const tokensBefore = (await tokenAmount(tokenAccount(me.publicKey)))!;
  const solBefore = await lamports(me.publicKey);
  await press(p.getByRole('button', { name: 'Buy SOL', exact: true }), 'Buy SOL');
  const review = ui.review(p);
  await expect(review).toBeVisible({ timeout: 90_000 });
  await expect(review).toContainText('5,000 tokens');
  await expect(review).toContainText(`${formatSol(expected)} SOL`);
  await expect(review).toContainText('that account is closed at the end, so you get plain SOL back.');
  expect(await signAndWait(p)).toBe('confirmed');

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
  await expect(routeLine(p)).toContainText('Routed to Jupiter:', { timeout: 60_000 });
  await expect(routeLine(p)).toContainText('better than our own pool, so the trade went there.');
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

test('the route is held when Buy is pressed: Jupiter moved past our pool since the quote, so nothing is built', async ({ browser }) => {
  test.setTimeout(3 * 60_000);
  const me = await fundedKeypair(2);
  const a = await trader(browser, me, POOL_PRICE * 1.2);
  const p = a.page;
  await openSwap(p, `out=${mint.toBase58()}`);
  await connectWallet(p);
  await p.getByLabel('Amount of SOL to pay').fill('0.1');
  await expect(routeLine(p)).toContainText('Routed to the venue pool:', { timeout: 60_000 });

  // Between the quote on screen and the press, Jupiter's price drops under our pool's.
  a.jup.setPrice(mint.toBase58(), POOL_PRICE * 0.8);
  await press(buy(p), 'Buy ROUTE');
  const outcome = ui.outcome(p);
  await expect(outcome).toBeVisible({ timeout: 90_000 });
  await expect(outcome).toHaveAttribute('data-status', 'not-sent');
  await expect(outcome).toContainText('Jupiter now pays more for this trade than our own pool does, so nothing was built here.');
  expect(a.wallet.signed().length).toBe(0);

  // Start over lands on the route as it is now.
  await press(outcome.getByRole('button', { name: 'Start over' }), 'Start over');
  await expect(routeLine(p)).toContainText('Routed to Jupiter:', { timeout: 60_000 });
  expect(await tokenAmount(tokenAccount(me.publicKey))).toBe(null);
  expect(a.rpc.violations).toEqual([]);
  await a.ctx.close();
});
