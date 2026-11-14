// Island, answer twenty-five (the sheet, build 3), on the production build at 390x844: from
// the Bayla room, Add SOL + BAYLA raises the sheet over the room with Add with one coin on it,
// its green button on the first screen with no scroll, still on screen at 660 tall; Back closes
// it; the island's deep link opens it over the room. (Answer twenty-two's door landed on /pools;
// the sheet replaces it.) The chain, the pool index and Jupiter are answered from made-up
// accounts for BAYLA's own pool address; every other /api call fails.
import { test, expect, type Page } from '@playwright/test';
import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';
import { LIVE_PROGRAM_ID, deriveAmmConfig } from '../src/lib/solana/cpswap/program';
import { buildPool, clockAccount, configBytes, mintBytes, type FakeAccount } from '../src/lib/solana/lp/testkit.fixture';
import { METAPLEX_TOKEN_METADATA_ID, metadataPda } from '../src/lib/launcher/solana/write/metaplex';
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

// The coin's name on chain, locked, as the real BAYLA's is (a Metaplex record: key 4, update authority,
// mint, name, symbol, uri, no fee, no creators, not sold, not mutable): its token check reads clean.
const borshText = (t: string) => [t.length, 0, 0, 0, ...Buffer.from(t, 'utf8')];
const nameOnChain = (mint: string) =>
  Uint8Array.from([4, ...new Uint8Array(32), ...new PublicKey(mint).toBytes(), ...borshText('BAYLA'), ...borshText('BAYLA'), ...borshText('https://x.test/b.json'), 0, 0, 0, 0, 0]);

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
    [metadataPda(new PublicKey(BAYLA)).toBase58()]: { owner: METAPLEX_TOKEN_METADATA_ID.toBase58(), data: nameOnChain(BAYLA) },
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
    const w = { scrolls: [] as number[], sheetTops: [] as number[] };
    (window as unknown as { __walk: typeof w }).__walk = w;
    const push = (a: number[], v: number) => { if (a[a.length - 1] !== v) a.push(v); };
    const tick = () => {
      // Every frame with the sheet up: the room's scroll under it, and where the sheet's top is.
      const sheet = document.querySelector('[data-testid="action-sheet"]');
      if (sheet && innerHeight >= 800) {
        push(w.scrolls, Math.round(window.scrollY));
        push(w.sheetTops, Math.round(sheet.getBoundingClientRect().top));
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
  // Island answer twenty-five, build 3: the room's door raises the sheet over the room, never the pools page.
  expect(await link.getAttribute('href')).toBe('/bayla?sheet=add');
  await link.click();
  await page.waitForURL(/\/bayla\?sheet=add$/);
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element | null) => (el ? { top: Math.round(el.getBoundingClientRect().top), bottom: Math.round(el.getBoundingClientRect().bottom) } : null);
    const sheet = document.querySelector('[data-testid="action-sheet"]');
    // The sheet's own button: the room under it holds the home's swap card, drawn as the sheet's form, with one too.
    const go = sheet?.querySelector('[data-testid="sheet-go"]') ?? null;
    return {
      walk: (window as unknown as { __walk: unknown }).__walk,
      innerHeight,
      scrollY: Math.round(scrollY),
      sheet: rect(sheet),
      go: rect(go),
      goText: go?.textContent?.trim() ?? null,
      // Seen ones only: the pool card the form rides on is in the sheet, hidden.
      greens: sheet ? [...sheet.querySelectorAll('.btn-primary')].filter((b) => b.getClientRects().length > 0).length : 0,
      hero: rect(document.querySelector('h1')),
      url: location.pathname + location.search,
    };
  });
}

// Set DOOR_WALK_OUT to a folder to keep the screens this walk sees.
const OUT = process.env.DOOR_WALK_OUT;
const shoot = async (page: Page, name: string, fullPage = false) => {
  if (OUT) await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
};
type Walk = { scrolls: number[]; sheetTops: number[] };

test('Add in the BAYLA room raises the sheet over the room: its button on it with zero scroll, at 844 tall and at 660', async ({ page }) => {
  test.skip(test.info().project.name !== 'chromium', 'one walk, at the phone size this test sets');
  test.slow();
  const { unknown } = await playDoor(page);
  await walkIn(page);
  const sheet = page.getByRole('dialog', { name: 'Add SOL + BAYLA' });
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  await expect(sheet.getByTestId('sheet-go')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_500);
  await shoot(page, 'sheet-844');
  const tall = await measure(page);
  if (OUT) console.log('SHEET', JSON.stringify(tall), 'unanswered rpc:', [...unknown].join(','));
  // The room never scrolled under it, and the sheet, which fits what it holds, moved little once it rose.
  expect((tall.walk as Walk).scrolls).toEqual([0]);
  const tops = (tall.walk as Walk).sheetTops;
  expect(Math.max(...tops) - Math.min(...tops), `the sheet's tops: ${tops.join(', ')}`).toBeLessThanOrEqual(60);
  expect(tall.goText).toBe('Add SOL + BAYLA');
  expect(tall.go!.bottom).toBeLessThanOrEqual(tall.innerHeight);
  // One green button on the screen the sheet is: its own.
  expect(tall.greens).toBe(1);
  // The room is still there, under the veil.
  expect(tall.hero).not.toBeNull();
  // A phone browser with its bars: the button is still on the screen at 660 tall.
  await page.setViewportSize({ width: 390, height: 660 });
  await page.waitForTimeout(600);
  await shoot(page, 'sheet-660');
  const short = await measure(page);
  expect(short.go!.top).toBeGreaterThanOrEqual(0);
  expect(short.go!.bottom).toBeLessThanOrEqual(660);
  // Back closes it, and the room is as it was.
  await sheet.getByRole('button', { name: 'Back to the room' }).click();
  await page.waitForURL(/\/bayla$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await shoot(page, 'sheet-back');
});

test('the island’s deep link opens the sheet over the coin’s room, and Back stays on the site', async ({ page }) => {
  test.skip(test.info().project.name !== 'chromium', 'one walk, at the phone size this test sets');
  test.slow();
  await playDoor(page);
  await page.goto(`/pools?mint=${BAYLA}&task=add&pool=${POOL}`);
  await page.waitForURL(/\/bayla\?sheet=add$/);
  const sheet = page.getByRole('dialog', { name: 'Add SOL + BAYLA' });
  await expect(sheet.getByTestId('sheet-go')).toBeVisible({ timeout: 30_000 });
  await shoot(page, 'sheet-deep-link');
  await sheet.getByRole('button', { name: 'Back to the room' }).click();
  await page.waitForURL(/\/bayla$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a connected visitor: the drawn rows, her line with no button, and one green button', async ({ page, context }) => {
  test.skip(test.info().project.name !== 'chromium', 'one walk, at the phone size this test sets');
  test.slow();
  await installConnectOnlySolanaWallet(context);
  await playDoor(page);
  // The connected wallet reads warm, so her line in the sheet is the drawn one.
  await page.route('**/api/aggregator**', (route) => {
    if (new URL(route.request().url()).searchParams.get('resource') !== 'heat') return route.abort();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ address: CONNECT_ONLY_WALLET_ADDRESS, degrees: 41.2, tier: 'Observer', is_cold: false, held_since_unix: 1_760_000_000, as_of_unix: Math.floor(Date.now() / 1000), token_count: 1, breakdown: [], x_handle: null }),
    });
  });
  await walkIn(page);
  const sheet = page.getByRole('dialog', { name: 'Add SOL + BAYLA' });
  await expect(sheet.getByTestId('sheet-go')).toBeVisible({ timeout: 30_000 });
  // No wallet yet: the sheet's own green button connects one.
  await sheet.getByTestId('sheet-go').click();
  await page.getByRole('dialog').getByRole('button', { name: new RegExp(CONNECT_ONLY_WALLET_NAME) }).click();
  await expect(sheet.getByRole('button', { name: 'Max SOL' })).toBeEnabled({ timeout: 30_000 });
  await sheet.getByRole('button', { name: '0.5 SOL' }).click();
  await expect(sheet.getByTestId('sheet-amount')).toHaveValue('0.5');
  const facts = sheet.getByTestId('lp-door-facts');
  await expect(facts).toContainText('Pool price1 BAYLA = ');
  await expect(facts).toContainText(/Outside price[\d.]+ SOL/);
  await expect(sheet.getByTestId('sheet-fee-line')).toHaveText(/^LPs keep [\d.]+% of each trade, the venue [\d.]+%\.$/);
  await expect(sheet.getByTestId('sheet-bayla')).toHaveText('41.20° Observer. Every day in this pool counts double.');
  await expect(sheet.getByTestId('sheet-bayla').getByRole('link')).toHaveCount(0);
  // Under the sheet her header button is quiet: the sheet's own green button is her move.
  await expect(page.getByTestId('bayla-line-button')).toHaveAttribute('data-quiet', 'true');
  await expect(sheet.getByTestId('sheet-go')).toBeEnabled();
  expect(await sheet.locator('.btn-primary:visible').count()).toBe(1);
  await page.waitForTimeout(800);
  await shoot(page, 'sheet-connected');
  const m = await measure(page);
  expect(m.go!.bottom).toBeLessThanOrEqual(m.innerHeight);
});
