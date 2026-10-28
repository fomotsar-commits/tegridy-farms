// Island, answer twenty-two ("where the door lands"), on the production build at 390x844:
// from the Bayla room, Add SOL + BAYLA opens /pools with Add with one coin at the top of the
// first screen, and the page never scrolls to reach it. The chain, the pool index and Jupiter
// are answered from made-up accounts for BAYLA's own pool address; every other /api call fails.
import { test, expect, type Page } from '@playwright/test';
import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';
import { LIVE_PROGRAM_ID, deriveAmmConfig } from '../src/lib/solana/cpswap/program';
import { buildPool, clockAccount, configBytes, mintBytes, type FakeAccount } from '../src/lib/solana/lp/testkit.fixture';
import { CONNECT_ONLY_WALLET_ADDRESS, CONNECT_ONLY_WALLET_NAME, installConnectOnlySolanaWallet } from './fixtures/solanaConnectOnlyWallet';

// The Bayla room's door, as lib/bungalows.ts names it (the spec checks the room's link says the same).
const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const POOL = 'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4';
const SOL = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const LOADER = 'BPFLoader2111111111111111111111111111111111';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
// A pool Jupiter routes through that our program does not own: an outside price.
const OUTSIDE_AMM = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const SOL_PER_BAYLA = 0.000006;

test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

async function playDoor(page: Page) {
  if (!LIVE_PROGRAM_ID) throw new Error('this checkout has no pool program id');
  const program = LIVE_PROGRAM_ID.toBase58();
  const now = Math.floor(Date.now() / 1000);
  const pool = buildPool({ mint: new PublicKey(BAYLA), address: new PublicKey(POOL), configIndex: 1, quoteReserve: 50n * 10n ** 9n, tokenReserve: 8_333_333n * 10n ** 6n, openTime: 1n });
  const accounts: Record<string, FakeAccount & { executable?: boolean }> = {
    [program]: { owner: LOADER, data: new Uint8Array(0), executable: true },
    [deriveAmmConfig(LIVE_PROGRAM_ID, 0).toBase58()]: { owner: program, data: configBytes(0, 2_500n, 120_000n) },
    ...pool.accounts,
    [BAYLA]: { owner: TOKEN_PROGRAM, data: mintBytes(null, 6) },
    SysvarC1ock11111111111111111111111111111111: clockAccount(BigInt(now)),
    [CONNECT_ONLY_WALLET_ADDRESS]: { owner: '11111111111111111111111111111111', data: new Uint8Array(0), lamports: 3_000_000_000 },
  };
  const acct = (a: string) => {
    const x = accounts[a];
    return x ? { data: [Buffer.from(x.data).toString('base64'), 'base64'], owner: x.owner, executable: x.executable ?? false, lamports: x.lamports ?? 2_039_280, rentEpoch: 0, space: x.data.length } : null;
  };
  const unknown = new Set<string>();
  const result = (method: string, params: unknown[]): unknown => {
    const ctx = { slot: 1000 };
    switch (method) {
      case 'getAccountInfo': return { context: ctx, value: acct(String(params[0])) };
      case 'getMultipleAccounts': return { context: ctx, value: (params[0] as string[]).map(acct) };
      case 'getBalance': return { context: ctx, value: accounts[String(params[0])]?.lamports ?? 0 };
      case 'getGenesisHash': return MAINNET_GENESIS;
      case 'getMinimumBalanceForRentExemption': return (128 + Number(params[0])) * 6960;
      case 'getTokenAccountsByOwner': case 'getProgramAccounts': case 'getSignaturesForAddress': return method === 'getTokenAccountsByOwner' ? { context: ctx, value: [] } : [];
      case 'getSlot': case 'getBlockHeight': return 1000;
      case 'getBlockTime': return now;
      case 'getLatestBlockhash': return { context: ctx, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 2000 } };
      default: unknown.add(method); return null;
    }
  };
  // Registered first, so asked last: anything not answered below fails, as an unreachable proxy does.
  await page.route('**/api/**', (route) => route.abort());
  await page.route('**/api/solrpc', (route) => {
    const body = route.request().postDataJSON() as unknown;
    const calls = (Array.isArray(body) ? body : [body]) as { id?: unknown; method: string; params?: unknown[] }[];
    const replies = calls.map((c) => ({ jsonrpc: '2.0', id: c.id, result: result(c.method, c.params ?? []) }));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? replies : replies[0]) });
  });
  await page.route('**/api/pools?*', (route) => {
    const q = new URL(route.request().url()).searchParams;
    const body = q.has('all') ? { all: true, pools: [POOL] } : q.has('mint') ? { mint: q.get('mint'), pools: q.get('mint') === BAYLA ? [POOL] : [] } : { lpMint: q.get('lpMint'), pools: [] };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...body, program, truncated: false }) });
  });
  await page.route('**/api/jupiter/swap/v1/quote?*', (route) => {
    const q = new URL(route.request().url()).searchParams;
    const [input, output, amount] = [q.get('inputMint')!, q.get('outputMint')!, q.get('amount')!];
    const out = input === SOL ? Math.floor((Number(amount) / 1e9 / SOL_PER_BAYLA) * 1e6) : Math.floor((Number(amount) / 1e6) * SOL_PER_BAYLA * 1e9);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        inputMint: input, outputMint: output, inAmount: amount, outAmount: String(out), otherAmountThreshold: String(Math.floor(out * 0.995)),
        swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0', platformFee: null, contextSlot: 1000, timeTaken: 0.01,
        routePlan: [{ percent: 100, bps: 10000, swapInfo: { ammKey: OUTSIDE_AMM, label: 'Pump.fun Amm', inputMint: input, outputMint: output, inAmount: amount, outAmount: String(out), feeAmount: '0', feeMint: input } }],
      }),
    });
  });
  // Every frame on /pools: the page's scroll and where the door's top is.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('tegridy-onboarding-seen', '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
    } catch { /* private mode */ }
    const w = { scrolls: [] as number[], doorTops: [] as number[] };
    (window as unknown as { __walk: typeof w }).__walk = w;
    const push = (a: number[], v: number) => { if (a[a.length - 1] !== v) a.push(v); };
    const tick = () => {
      if (location.pathname === '/pools') {
        push(w.scrolls, Math.round(window.scrollY));
        const d = document.querySelector('[data-testid="lp-door"]');
        if (d) push(w.doorTops, Math.round(d.getBoundingClientRect().top));
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return { unknown };
}

async function walkIn(page: Page) {
  await page.goto('/bayla');
  const link = page.getByRole('link', { name: 'Add SOL + BAYLA' }).first();
  await expect(link).toBeVisible({ timeout: 30_000 });
  expect(await link.getAttribute('href')).toBe(`/pools?mint=${BAYLA}&task=add&pool=${POOL}`);
  await link.click();
  await page.waitForURL(/\/pools/);
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element | null) => (el ? { top: Math.round(el.getBoundingClientRect().top), bottom: Math.round(el.getBoundingClientRect().bottom) } : null);
    const panel = document.querySelector('[data-testid="lp-one-coin-panel"]');
    const button = (name: string) => [...(panel?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === name) ?? null;
    const review = button('Review: add with one coin');
    const connect = button('Connect Solana Wallet');
    const amount = panel?.querySelector('input[inputmode="decimal"]') ?? null;
    const bottomBar = [...document.querySelectorAll('nav')].filter((n) => getComputedStyle(n).position === 'fixed' && n.getBoundingClientRect().top > innerHeight / 2)[0] ?? null;
    return {
      walk: (window as unknown as { __walk: unknown }).__walk,
      innerHeight,
      scrollY: Math.round(scrollY),
      door: rect(document.querySelector('[data-testid="lp-door"]')),
      roomName: document.querySelector('[data-testid="lp-door"] h2')?.textContent ?? null,
      panel: rect(panel),
      amount: rect(amount),
      review: rect(review),
      connect: rect(connect),
      reviewDisabled: review ? (review as HTMLButtonElement).disabled : null,
      hero: rect(document.querySelector('h1')),
      finder: rect(document.querySelector('[data-testid="lp-tasks"]')),
      poolCard: rect(document.querySelector('[data-testid="lp-pool"]')),
      bottomBar: rect(bottomBar),
      url: location.pathname + location.search,
    };
  });
}

// Set DOOR_WALK_OUT to a folder to keep the screens this walk sees.
const OUT = process.env.DOOR_WALK_OUT;
const shoot = async (page: Page, name: string, fullPage = false) => {
  if (OUT) await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
};
type Walk = { scrolls: number[]; doorTops: number[] };

test('a fresh visitor: the form is the first thing on /pools, and nothing scrolls', async ({ page }) => {
  test.skip(test.info().project.name !== 'chromium', 'one walk, at the phone size this test sets');
  test.slow();
  const { unknown } = await playDoor(page);
  await walkIn(page);
  const panel = page.getByTestId('lp-one-coin-panel');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('lp-pool')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2_000);
  await shoot(page, 'fresh-first-screen');
  await shoot(page, 'fresh-full', true);
  const m = await measure(page);
  if (OUT) console.log('FRESH', JSON.stringify(m), 'unanswered rpc:', [...unknown].join(','));
  expect(m.url, 'the door left the address').toBe(`/pools?mint=${BAYLA}`);
  // Not one frame on /pools away from the top, and the door never moved.
  expect((m.walk as Walk).scrolls).toEqual([0]);
  expect((m.walk as Walk).doorTops).toHaveLength(1);
  expect(m.roomName).toBe('Bayla');
  expect(m.door!.top).toBeLessThan(m.hero!.top);
  expect(m.door!.top).toBeLessThan(m.finder!.top);
  // No wallet yet: its green button is the panel's first, above the bottom bar.
  expect(m.connect!.bottom).toBeLessThanOrEqual(m.bottomBar?.top ?? m.innerHeight);
});

test('a connected visitor: one amount, one sentence, one green button on the first screen', async ({ page, context }) => {
  test.skip(test.info().project.name !== 'chromium', 'one walk, at the phone size this test sets');
  test.slow();
  await installConnectOnlySolanaWallet(context);
  const { unknown } = await playDoor(page);
  await walkIn(page);
  const panel = page.getByTestId('lp-one-coin-panel');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  // Connect from the panel's own button, as a visitor whose wallet is not connected yet does.
  const connect = page.getByRole('banner').getByRole('button', { name: 'Connect a Solana wallet' });
  await connect.click();
  await page.getByRole('dialog').getByRole('button', { name: new RegExp(CONNECT_ONLY_WALLET_NAME) }).click();
  await expect(panel.getByText(/after both steps’ fees and deposits/)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_500);
  await shoot(page, 'connected-first-screen');
  const before = await measure(page);
  await panel.getByLabel('SOL to put in').fill('0.5');
  await expect(panel.getByTestId('lp-one-share')).toBeVisible();
  await page.waitForTimeout(800);
  await shoot(page, 'connected-amount');
  const after = await measure(page);
  if (OUT) console.log('CONNECTED', JSON.stringify(before), 'AFTER', JSON.stringify(after), 'unanswered rpc:', [...unknown].join(','));
  for (const m of [before, after]) {
    expect((m.walk as Walk).scrolls).toEqual([0]);
    expect((m.walk as Walk).doorTops).toHaveLength(1);
    // The green button on the first screen, above the bottom bar, with an amount in and without.
    expect(m.review!.bottom).toBeLessThanOrEqual(m.bottomBar?.top ?? m.innerHeight);
  }
  expect(after.reviewDisabled).toBe(false);
});
