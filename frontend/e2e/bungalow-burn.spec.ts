import { test, expect, type Page } from '@playwright/test';
import { decodeFunctionData, encodeFunctionResult, multicall3Abi, pad, toHex } from 'viem';
import { BUNGALOWS } from '../src/lib/bungalows';
import { EVM_BURN_ADDRESS } from '../src/lib/bungalowBurn';
import { gotoRoute, waitForQuiescence } from './fixtures/routes';

// The burn card on a bungalow's door. No vitest renders HomePage, so the mount is pinned
// here. Chain reads are never live in this file: they are sealed (the card must say it
// could not read) or answered from a recording (the card must print it and still fit).

const TOKEN_ROOMS = BUNGALOWS.filter((b) => b.address);

// The hosts the wagmi transports read Ethereum and Base from (src/lib/chains/viemChains.ts).
const RPC_HOSTS = new Set([
  'ethereum-rpc.publicnode.com',
  'eth.drpc.org',
  'base-rpc.publicnode.com',
  'base.drpc.org',
  'mainnet.base.org',
]);
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };

type Erc20Recording = { token: string; totalSupply: bigint; decimals: number; atBurnAddress: bigint };
type RpcCall = { id: number; method: string; params?: unknown[] };

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

/** Answer every EVM RPC request from `recording`, or refuse them all when it is null. */
async function stubEvm(page: Page, recording: Erc20Recording | null): Promise<{ multicalls: number }> {
  const seen = { multicalls: 0 };
  const word = (v: bigint) => pad(toHex(v), { size: 32 });
  const burnBalanceCall = `0x70a08231${EVM_BURN_ADDRESS.slice(2).toLowerCase().padStart(64, '0')}`;

  const answer = (call: RpcCall) => {
    const tx = call.params?.[0] as { data?: `0x${string}` } | undefined;
    if (call.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: call.id, result: '0x1' };
    if (recording && call.method === 'eth_call' && tx?.data?.startsWith('0x82ad56cb')) {
      seen.multicalls += 1;
      const { args } = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
      const calls = args![0] as readonly { target: string; callData: string }[];
      const result = calls.map(({ target, callData }) => {
        const data = callData.toLowerCase();
        const value = target.toLowerCase() !== recording.token.toLowerCase() ? null
          : data === '0x18160ddd' ? recording.totalSupply
          : data === '0x313ce567' ? BigInt(recording.decimals)
          : data === burnBalanceCall ? recording.atBurnAddress
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
    if (!recording) return route.fulfill({ status: 503, headers: CORS, body: 'sealed' });
    const body = request.postDataJSON() as RpcCall | RpcCall[];
    const out = Array.isArray(body) ? body.map(answer) : answer(body);
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(out) });
  });
  return seen;
}

/** Answer getTokenSupply for `mint` from a recording, or refuse the proxy when `amount` is null. */
async function stubSolana(page: Page, mint: string, amount: string | null): Promise<{ supplyReads: number }> {
  const seen = { supplyReads: 0 };
  await page.route('**/api/solrpc', async (route) => {
    if (amount === null) return route.fulfill({ status: 503, body: 'sealed' });
    const body = route.request().postDataJSON() as RpcCall | RpcCall[];
    const out = (Array.isArray(body) ? body : [body]).map((call) => {
      if (call.method === 'getTokenSupply' && call.params?.[0] === mint) {
        seen.supplyReads += 1;
        return { jsonrpc: '2.0', id: call.id, result: { context: { slot: 1 }, value: { amount, decimals: 6 } } };
      }
      return { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'not in the recording' } };
    });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });
  return seen;
}

/** Sideways overflow, measured two ways: the page past the viewport, and anything past the card's own edge. */
async function overflow(page: Page, label: string) {
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate((cardLabel) => {
    const card = document.querySelector(`section[aria-label="${cardLabel}"]`)!;
    const box = card.getBoundingClientRect();
    let past = 0;
    for (const el of card.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0) past = Math.max(past, r.right - box.right, box.left - r.left);
    }
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      card: Math.round(past),
    };
  }, label);
}

test.describe('the burn card, on every door', () => {
  test('this file knows all twelve token bungalows', () => {
    expect(TOKEN_ROOMS.map((b) => b.id)).toHaveLength(12);
  });

  for (const b of TOKEN_ROOMS) {
    test(`/${b.id} shows one ${b.symbol} burn card, and an outage in words when the chain cannot be read`, async ({ page }) => {
      test.skip(test.info().project.name !== 'chromium', 'the mount is the same component on every device; the fit tests below run on all four');
      await seed(page, b.id);
      await stubEvm(page, null);
      await stubSolana(page, b.address!, null);
      await gotoRoute(page, `/${b.id}`);

      const card = page.locator(`section[aria-label="${b.symbol} burn"]`);
      await expect(card).toHaveCount(1, { timeout: 20_000 });
      await expect(card.getByRole('status')).toHaveText(
        `The ${b.symbol} burn could not be read right now. That is an outage, not a zero.`,
        { timeout: 30_000 },
      );
      await expect(card.locator('dl')).toHaveCount(0);
      expect(await card.innerText(), 'an unread burn prints no percent').not.toContain('%');
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
});

test.describe('the burn card, read and fitted', () => {
  test('/pepe prints a fifteen-digit burn and nothing runs off the side', async ({ page }) => {
    const pepe = BUNGALOWS.find((b) => b.id === 'pepe')!;
    await seed(page, 'pepe');
    const seen = await stubEvm(page, {
      token: pepe.address!,
      totalSupply: 420_689_899_645_071_695787564425681079n,
      decimals: 18,
      atBurnAddress: 6_917_544_537_127_740524900319904797n,
    });
    await gotoRoute(page, '/pepe');

    const card = page.locator('section[aria-label="PEPE burn"]');
    await expect(card.locator('dl')).toBeVisible({ timeout: 30_000 });
    expect(seen.multicalls, 'the recording answered nothing, so the figures below are not its figures').toBeGreaterThan(0);
    await expect(card).toContainText('1.64%');
    await expect(card).toContainText('6.91T of the 420.69T PEPE ever minted');
    await expect(card).toContainText('6,917,644,892,056');
    await expect(card).toContainText('413,772,355,107,943');
    await card.scrollIntoViewIfNeeded();
    expect(await overflow(page, 'PEPE burn')).toEqual({ page: 0, card: 0 });
  });

  test('/brainlet prints a Solana burn through the proxy and fits', async ({ page }) => {
    const brainlet = BUNGALOWS.find((b) => b.id === 'brainlet')!;
    await seed(page, 'brainlet');
    const seen = await stubSolana(page, brainlet.address!, '999998668613490');
    await gotoRoute(page, '/brainlet');

    const card = page.locator('section[aria-label="BRAINLET burn"]');
    await expect(card.locator('dl')).toBeVisible({ timeout: 30_000 });
    expect(seen.supplyReads).toBeGreaterThan(0);
    await expect(card).toContainText('0.0001%');
    await expect(card).toContainText('1,331 of the 1.00B BRAINLET ever minted');
    await expect(card).toContainText('999,998,668');
    await card.scrollIntoViewIfNeeded();
    expect(await overflow(page, 'BRAINLET burn')).toEqual({ page: 0, card: 0 });
  });
});
