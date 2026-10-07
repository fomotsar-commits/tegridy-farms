// Every read ends. The proxy is made to hold `getMultipleAccounts` unanswered for longer
// than the page waits (readFetch.ts, 20 s): the finder must say it could not read the pools,
// with the timeout sentence and a pressable Read again, inside 30 s of opening the page,
// instead of "Reading..." for good. Released, Read again shows the pool.
//
// The validator proves the whole loop for the chain's reads. It cannot prove a hung Jupiter
// (the stub answers at once): readFetch.test.ts carries that.
//
// Acceptance (DESIGN 2.A1): a screenshot of the finder at 390 wide with the sentence and
// the Read again button whole, written to E2E_SHOTS_DIR when it is set.
import { test, expect } from '@playwright/test';
import type { Keypair, PublicKey } from '@solana/web3.js';
import { fundedKeypair, sol } from './fixtures/chain';
import { createClassicToken, createSolPool, installJupiterStub, installPoolIndex, type CreatedPool } from './fixtures/lp';
import { installRpcGuard } from './fixtures/rpcGuard';
import { ui, clickReal, expectClickable, expectNoSidewaysScroll } from './fixtures/ui';
import { READ_TIMEOUT_MS, timeoutDetail } from '../src/lib/solana/lp/readFetch';

const DEC = 6;
const UNIT = 10n ** BigInt(DEC);
/** Longer than the page waits, shorter than the test's patience. */
const HANG_MS = READ_TIMEOUT_MS + 5_000;
/** The page's own figure plus the time a read takes to start and a card to render. */
const MUST_SAY_SO_WITHIN_MS = 30_000;

let creator: Keypair;
let mint: PublicKey;
let pool: CreatedPool;

test.beforeAll(async () => {
  test.setTimeout(3 * 60_000);
  creator = await fundedKeypair(10);
  mint = await createClassicToken(creator, { supply: 10_000_000n * UNIT, name: { name: 'E2E Slow', symbol: 'ESLOW' } });
  pool = await createSolPool(creator, mint, { configIndex: 1, sol: sol(2), tokens: 2_000_000n * UNIT, at: 'standard' });
});

test('a chain read that never answers ends in "could not read" with Read again; released, Read again shows the pool', async ({ browser }) => {
  test.setTimeout(4 * 60_000);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const rpc = await installRpcGuard(ctx);
  await installPoolIndex(ctx);
  await installJupiterStub(ctx, new Map([[mint.toBase58(), { solPerToken: 1e-6, decimals: DEC }]]));
  const p = await ctx.newPage();

  // Every account read the finder makes is held: the pools, the token, the fee tiers.
  rpc.hang('getMultipleAccounts', HANG_MS);
  const opened = Date.now();
  await p.goto(`/pools?mint=${mint.toBase58()}`);
  await expect(ui.lp.section(p)).toBeVisible({ timeout: 60_000 });

  const sentence = timeoutDetail('the chain');
  const notice = ui.lp.finder(p).getByText(`We could not read the pools (${sentence})`);
  await expect(notice).toBeVisible({ timeout: Math.max(1_000, MUST_SAY_SO_WITHIN_MS - (Date.now() - opened)) });
  expect(Date.now() - opened, 'the page said so within 30 s of opening').toBeLessThan(MUST_SAY_SO_WITHIN_MS);
  await expect(notice).toContainText('it does not mean there are none');
  expect(rpc.hungCount('getMultipleAccounts'), 'the hang was what the page ran into').toBeGreaterThan(0);
  // Never "no pools": an unread is not a negative.
  await expect(ui.lp.noPools(p)).toHaveCount(0);
  await expect(ui.lp.pools(p)).toHaveCount(0);

  const again = ui.lp.finder(p).getByRole('button', { name: 'Read again', exact: true });
  await expectClickable(again, 'Read again');
  await expectNoSidewaysScroll(p);
  const dir = process.env.E2E_SHOTS_DIR;
  if (dir) await p.screenshot({ path: `${dir.replace(/[\\/]+$/, '')}/lp-timeouts-hang-390.png`, fullPage: true });

  // Released, a press reads the pool from the chain.
  rpc.release('getMultipleAccounts');
  await clickReal(again, 'Read again');
  await expect(ui.lp.pools(p)).toHaveCount(1, { timeout: 60_000 });
  await expect(p.locator(`[data-testid="lp-pool"][data-pool="${pool.address.toBase58()}"]`)).toBeVisible();
  await expect(ui.lp.pools(p).first()).toContainText('2 SOL and 2,000,000 tokens');
  await expect(notice).toHaveCount(0);
  expect(rpc.violations).toEqual([]);
  await ctx.close();
});
