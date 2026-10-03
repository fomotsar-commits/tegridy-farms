import { test, expect, type Page } from '@playwright/test';
import { decodeFunctionData, encodeFunctionResult, multicall3Abi, pad, toHex } from 'viem';
import { BUNGALOWS } from '../src/lib/bungalows';
import { gotoRoute, waitForQuiescence } from './fixtures/routes';

// The burn card where a visitor meets it. No vitest renders HomePage or the dashboards, so
// the mounts are pinned here. Chain reads are never live in this file: they are sealed (the
// card must say it could not read) or answered from a recording (the card must print it,
// and every figure must fit its row).

const TOKEN_ROOMS = BUNGALOWS.filter((b) => b.address);
const room = (id: string) => BUNGALOWS.find((b) => b.id === id)!;

// The hosts the wagmi transports read Ethereum and Base from (src/lib/chains/viemChains.ts).
const RPC_HOSTS = new Set([
  'ethereum-rpc.publicnode.com',
  'eth.drpc.org',
  'base-rpc.publicnode.com',
  'base.drpc.org',
  'mainnet.base.org',
]);
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };

// balanceOf(0x000000000000000000000000000000000000dEaD), spelled out. Not derived from the
// app's own constant: a recording that answers whatever address the app asks proves nothing.
const BURN_ADDRESS_BALANCE_CALL = '0x70a08231000000000000000000000000000000000000000000000000000000000000dead';

type Erc20Recording = { token: string; totalSupply: bigint; decimals: number; atBurnAddress: bigint };
type RpcCall = { id: number; method: string; params?: unknown[] };
/** What the chain answers. `recording: null` refuses every read. Mutable, so a test can bring the chain back. */
type Chain = { evm: Erc20Recording | null; solana: { mint: string; amount: string } | null; multicalls: number; supplyReads: number };

async function seed(page: Page, id: string) {
  await page.addInitScript((door) => {
    try {
      localStorage.setItem('tegridy-onboarding-seen', '1');
      localStorage.setItem(`tegridy-onboarding-${door}-seen`, '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
      localStorage.setItem('tegridy-bungalow', door);
    } catch { /* private mode */ }
  }, id);
}

/** Route every EVM RPC host and the Solana proxy to `chain`. Sealed until the test fills it in. */
async function stubChain(page: Page, initial: Partial<Pick<Chain, 'evm' | 'solana'>> = {}): Promise<Chain> {
  const chain: Chain = { evm: initial.evm ?? null, solana: initial.solana ?? null, multicalls: 0, supplyReads: 0 };
  const word = (v: bigint) => pad(toHex(v), { size: 32 });

  const answerEvm = (call: RpcCall, rec: Erc20Recording) => {
    const tx = call.params?.[0] as { data?: `0x${string}` } | undefined;
    if (call.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: call.id, result: '0x1' };
    if (call.method === 'eth_call' && tx?.data?.startsWith('0x82ad56cb')) {
      chain.multicalls += 1;
      const { args } = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
      const calls = args![0] as readonly { target: string; callData: string }[];
      const result = calls.map(({ target, callData }) => {
        const data = callData.toLowerCase();
        const value = target.toLowerCase() !== rec.token.toLowerCase() ? null
          : data === '0x18160ddd' ? rec.totalSupply
          : data === '0x313ce567' ? BigInt(rec.decimals)
          : data === BURN_ADDRESS_BALANCE_CALL ? rec.atBurnAddress
          : null;
        return value === null ? { success: false, returnData: '0x' as const } : { success: true, returnData: word(value) };
      });
      return { jsonrpc: '2.0', id: call.id, result: encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result }) };
    }
    return { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'not in the recording' } };
  };

  await page.route((url) => RPC_HOSTS.has(url.hostname), async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const rec = chain.evm;
    if (!rec) return route.fulfill({ status: 503, headers: CORS, body: 'sealed' });
    const body = request.postDataJSON() as RpcCall | RpcCall[];
    const out = Array.isArray(body) ? body.map((c) => answerEvm(c, rec)) : answerEvm(body, rec);
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(out) });
  });

  await page.route('**/api/solrpc', async (route) => {
    const rec = chain.solana;
    if (!rec) return route.fulfill({ status: 503, body: 'sealed' });
    const body = route.request().postDataJSON() as RpcCall | RpcCall[];
    const out = (Array.isArray(body) ? body : [body]).map((call) => {
      if (call.method === 'getTokenSupply' && call.params?.[0] === rec.mint) {
        chain.supplyReads += 1;
        return { jsonrpc: '2.0', id: call.id, result: { context: { slot: 1 }, value: { amount: rec.amount, decimals: 6 } } };
      }
      return { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'not in the recording' } };
    });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });
  return chain;
}

const PEPE_RECORDING = (): Erc20Recording => ({
  token: room('pepe').address!,
  totalSupply: 420_689_899_645_071_695787564425681079n,
  decimals: 18,
  atBurnAddress: 6_917_544_537_127_740524900319904797n,
});

const burnCard = (page: Page, symbol: string) => page.locator(`section[aria-label="${symbol} burn"]`);
/** The headline percent, exactly: a substring match would pass "under 0.0001%" for "0.0001%". */
const headline = (page: Page, symbol: string) => burnCard(page, symbol).locator('p > span').first();
const OUTAGE = (symbol: string) => `The ${symbol} burn could not be read right now. That is an outage, not a zero.`;

/**
 * Does every ledger figure fit its row? Measured on the TEXT, with a Range: the value cell
 * shrinks to its row and the ledger clips, so a figure that is too wide moves no element's
 * box. A figure that does not fit shows up here as text past the row's padding edge, or as
 * a unit dropped onto a second line under its number.
 */
async function ledgerMisfits(page: Page, symbol: string): Promise<string[]> {
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate((label) => {
    const card = document.querySelector(`section[aria-label="${label}"]`)!;
    const rows = [...card.querySelectorAll('dl > div')];
    if (rows.length === 0) return ['the card has no ledger rows to measure'];
    const bad: string[] = [];
    for (const rowEl of rows) {
      const dd = rowEl.querySelector('dd')!;
      const box = rowEl.getBoundingClientRect();
      const style = getComputedStyle(rowEl);
      const left = box.left + parseFloat(style.paddingLeft);
      const right = box.right - parseFloat(style.paddingRight);
      const range = document.createRange();
      range.selectNodeContents(dd);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0);
      const textLeft = Math.min(...rects.map((r) => r.left));
      const textRight = Math.max(...rects.map((r) => r.right));
      const oneLine = Math.max(...rects.map((r) => r.top)) < Math.min(...rects.map((r) => r.bottom));
      if (textLeft < left - 0.5 || textRight > right + 0.5 || !oneLine) {
        bad.push(`"${dd.textContent}" spans ${Math.round(textLeft)}..${Math.round(textRight)} in a row of ${Math.round(left)}..${Math.round(right)}${oneLine ? '' : ', on more than one line'}`);
      }
    }
    return bad;
  }, `${symbol} burn`);
}

/** Behavioural, as in tab-target-size.spec.ts: body is overflow-x hidden, so widths can lie. */
async function slidSideways(page: Page): Promise<number> {
  return page.evaluate(() => {
    window.scrollTo(500, window.scrollY);
    const x = window.scrollX;
    window.scrollTo(0, window.scrollY);
    return x;
  });
}

test.describe('the burn card, on every door', () => {
  test('this file knows all twelve token bungalows', () => {
    expect(TOKEN_ROOMS.map((b) => b.id)).toHaveLength(12);
  });

  for (const b of TOKEN_ROOMS) {
    test(`/${b.id} shows one ${b.symbol} burn card, and an outage in words when the chain cannot be read`, async ({ page }) => {
      test.skip(test.info().project.name !== 'chromium', 'the mount is the same component on every device; the fit tests below run on all four');
      await seed(page, b.id);
      await stubChain(page);
      await gotoRoute(page, `/${b.id}`);

      const card = burnCard(page, b.symbol);
      await expect(card).toHaveCount(1, { timeout: 20_000 });
      await expect(card.getByRole('status')).toHaveText(OUTAGE(b.symbol), { timeout: 30_000 });
      await expect(card.locator('dl')).toHaveCount(0);
      expect(await card.innerText(), 'an unread burn prints no percent').not.toContain('%');
      // An outage must leave the way back open: Refresh is the card's only re-read.
      await expect(card.getByRole('button', { name: 'Refresh' })).toBeEnabled();
      await expect(page.locator('section[aria-label$=" burn"]')).toHaveCount(1);
    });
  }

  test('the venue front door carries no burn card', async ({ page }) => {
    test.skip(test.info().project.name !== 'chromium', 'one gate, device-independent');
    await seed(page, 'venue');
    await gotoRoute(page, '/');
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 20_000 });
    // Absence is only evidence once the page has finished arriving.
    await waitForQuiescence(page);
    await expect(page.locator('section[aria-label$=" burn"]')).toHaveCount(0);
  });

  for (const id of ['pepe', 'bayla']) {
    test(`/dashboard in the ${id} bungalow carries its burn card too`, async ({ page }) => {
      test.skip(test.info().project.name !== 'chromium', 'the mount is the same component on every device');
      const b = room(id);
      await seed(page, id);
      await stubChain(page);
      await gotoRoute(page, '/dashboard');
      const card = burnCard(page, b.symbol);
      await expect(card).toHaveCount(1, { timeout: 30_000 });
      await expect(card.getByRole('status')).toHaveText(OUTAGE(b.symbol), { timeout: 30_000 });
    });
  }
});

test.describe('the burn card, read and fitted', () => {
  test('/pepe prints a fifteen-digit burn and every figure fits its row', async ({ page }) => {
    await seed(page, 'pepe');
    const chain = await stubChain(page, { evm: PEPE_RECORDING() });
    await gotoRoute(page, '/pepe');

    const card = burnCard(page, 'PEPE');
    await expect(card.locator('dl')).toBeVisible({ timeout: 30_000 });
    expect(chain.multicalls, 'the recording answered nothing, so the figures below are not its figures').toBeGreaterThan(0);
    await expect(headline(page, 'PEPE')).toHaveText('1.64%');
    await expect(card).toContainText('6.91T of the 420.69T PEPE ever minted');
    await expect(card).toContainText('6,917,644,892,056');
    await expect(card).toContainText('413,772,355,107,944');
    await expect(card).toContainText('Read from Ethereum.');
    await card.scrollIntoViewIfNeeded();
    expect(await ledgerMisfits(page, 'PEPE')).toEqual([]);
    expect(await slidSideways(page), 'the page slid sideways').toBe(0);
  });

  test('/pepe still fits on the narrowest phone the venue supports, 320px', async ({ page }) => {
    test.skip(test.info().project.name !== 'chromium', 'a width, not a device: one engine is enough');
    await page.setViewportSize({ width: 320, height: 700 });
    await seed(page, 'pepe');
    await stubChain(page, { evm: PEPE_RECORDING() });
    await gotoRoute(page, '/pepe');
    const card = burnCard(page, 'PEPE');
    await expect(card.locator('dl')).toBeVisible({ timeout: 30_000 });
    await card.scrollIntoViewIfNeeded();
    expect(await ledgerMisfits(page, 'PEPE')).toEqual([]);
    expect(await slidSideways(page), 'the page slid sideways').toBe(0);
  });

  test('/brainlet prints a Solana burn through the proxy and fits', async ({ page }) => {
    const brainlet = room('brainlet');
    await seed(page, 'brainlet');
    const chain = await stubChain(page, { solana: { mint: brainlet.address!, amount: '999998668613490' } });
    await gotoRoute(page, '/brainlet');

    const card = burnCard(page, 'BRAINLET');
    await expect(card.locator('dl')).toBeVisible({ timeout: 30_000 });
    expect(chain.supplyReads).toBeGreaterThan(0);
    await expect(headline(page, 'BRAINLET')).toHaveText('0.0001%');
    await expect(card).toContainText('1,331 of the 1.00B BRAINLET ever minted');
    await expect(card).toContainText('999,998,669');
    await expect(card).toContainText('Read from Solana.');
    await card.scrollIntoViewIfNeeded();
    expect(await ledgerMisfits(page, 'BRAINLET')).toEqual([]);
    expect(await slidSideways(page), 'the page slid sideways').toBe(0);
  });

  test('/qr on Base counts the burn address only, and shows a supply fall without counting it', async ({ page }) => {
    test.skip(test.info().project.name !== 'chromium', 'figures, not layout');
    await seed(page, 'qr');
    const E18 = 10n ** 18n;
    // 10B destroyed with burn(): supply 90B. The card cannot tell that from a bridge-out.
    await stubChain(page, {
      evm: { token: room('qr').address!, totalSupply: 90_000_000_000n * E18, decimals: 18, atBurnAddress: 6_669_949_934n * E18 },
    });
    await gotoRoute(page, '/qr');

    const card = burnCard(page, 'QR');
    await expect(card.locator('dl')).toBeVisible({ timeout: 30_000 });
    await expect(headline(page, 'QR')).toHaveText('6.66%');
    await expect(card).toContainText('Read from Base.');
    await expect(card.locator('dt')).toHaveText(['Burnt', 'Ever minted', 'Supply fall, not counted']);
    await expect(card.locator('dd')).toHaveText(['6,669,949,934 QR', '100,000,000,000 QR', '10,000,000,000 QR']);
  });

  for (const id of ['pepe', 'brainlet']) {
    test(`/${id}: Refresh brings the figure back after an outage`, async ({ page }) => {
      test.skip(test.info().project.name !== 'chromium', 'the same hook on every device');
      const b = room(id);
      await seed(page, id);
      const chain = await stubChain(page);
      await gotoRoute(page, `/${id}`);

      const card = burnCard(page, b.symbol);
      await expect(card.getByRole('status')).toHaveText(OUTAGE(b.symbol), { timeout: 30_000 });

      // The chain comes back. Nothing re-reads by itself: the outage line must still be there.
      if (id === 'pepe') chain.evm = PEPE_RECORDING();
      else chain.solana = { mint: b.address!, amount: '999998668613490' };
      await page.waitForTimeout(1500);
      await expect(card.getByRole('status')).toHaveText(OUTAGE(b.symbol));

      await card.getByRole('button', { name: 'Refresh' }).click();
      await expect(card.locator('dl')).toBeVisible({ timeout: 30_000 });
      await expect(headline(page, b.symbol)).toHaveText(id === 'pepe' ? '1.64%' : '0.0001%');
      await expect(card.getByRole('status')).toHaveCount(0);
    });
  }
});
