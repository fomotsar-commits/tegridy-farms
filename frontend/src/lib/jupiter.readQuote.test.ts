// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { SOL_MINT, USDC_MINT } from './solana';
import { PLATFORM_TREASURY_VAULT } from './launcher/solana/curve/program';

/**
 * readQuote keeps three answers apart: a quote, "Jupiter has no route", and
 * "Jupiter could not be read".
 *
 * Before it existed the page had only getQuote, which THROWS for all of the
 * last two, and the page's catch printed "No route for this pair / amount."
 * for a 502, a rate limit and a dropped connection alike. On that code this
 * file has nothing to import. (T-JUP-01..03, T-JUP-12.)
 */

const TOKEN = PublicKey.unique().toBase58();
const OTHER = PublicKey.unique().toBase58();
const USER = PublicKey.unique().toBase58();
const AMOUNT = '100000000';
const ASK = { inputMint: SOL_MINT, outputMint: TOKEN, amount: AMOUNT, slippageBps: 50 };

const QUOTE = {
  inputMint: SOL_MINT, outputMint: TOKEN, inAmount: AMOUNT, outAmount: '21762184421', otherAmountThreshold: '21653373499',
  swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0', routePlan: [], platformFee: { amount: '109357710', feeBps: 50 },
};

async function load() {
  vi.resetModules();
  return import('./jupiter');
}

function answer(status: number, body: unknown) {
  const spy = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(() => {
  vi.stubEnv('VITE_SOLANA_FEE_ACCOUNT', PLATFORM_TREASURY_VAULT.toBase58());
  vi.stubEnv('VITE_SOLANA_PLATFORM_FEE_BPS', '50');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('readQuote: a quote', () => {
  it('a priced answer for the asked trade is a quote, and says the fee rate the request carried', async () => {
    const { readQuote } = await load();
    const spy = answer(200, QUOTE);
    expect(await readQuote(ASK)).toEqual({ kind: 'quote', quote: QUOTE, feeBpsSent: 50 });
    expect(new URL(spy.mock.calls[0]![0], 'https://x.test').searchParams.get('platformFeeBps')).toBe('50');
  });

  it('feeBpsSent is null when the request carried no fee: asked without one, or a pair with no fee side', async () => {
    const { readQuote } = await load();
    const a = answer(200, QUOTE);
    expect(await readQuote({ ...ASK, noPlatformFee: true })).toMatchObject({ kind: 'quote', feeBpsSent: null });
    expect(new URL(a.mock.calls[0]![0], 'https://x.test').searchParams.has('platformFeeBps')).toBe(false);

    const tokenToToken = { ...QUOTE, inputMint: OTHER };
    const b = answer(200, tokenToToken);
    expect(await readQuote({ ...ASK, inputMint: OTHER })).toMatchObject({ kind: 'quote', feeBpsSent: null });
    expect(new URL(b.mock.calls[0]![0], 'https://x.test').searchParams.has('platformFeeBps')).toBe(false);
  });

  it('feeBpsSent is the rate this build is configured with, whatever it is', async () => {
    vi.stubEnv('VITE_SOLANA_PLATFORM_FEE_BPS', '100');
    const { readQuote } = await load();
    answer(200, QUOTE);
    expect(await readQuote(ASK)).toMatchObject({ kind: 'quote', feeBpsSent: 100 });
  });

  it('sends the same request getQuote sends', async () => {
    const { readQuote, getQuote } = await load();
    const a = answer(200, QUOTE);
    await readQuote(ASK);
    const b = answer(200, QUOTE);
    await getQuote(ASK);
    expect(a.mock.calls[0]![0]).toBe(b.mock.calls[0]![0]);
  });
});

describe('readQuote: "no route" is only the proxy’s own answer', () => {
  it('a 404 whose body carries code NO_ROUTE is no-route', async () => {
    const { readQuote } = await load();
    answer(404, { error: 'No route', code: 'NO_ROUTE' });
    expect(await readQuote(ASK)).toEqual({ kind: 'no-route' });
  });

  it.each([
    ['a 404 with another body', 404, { error: 'Not found' }],
    ['a 404 with no JSON at all', 404, '<html>not found</html>'],
    ['a 404 with a null body', 404, 'null'],
    ['a 404 whose code is only similar', 404, { code: 'NO_ROUTES_FOUND' }],
  ])('%s is unread, not no-route', async (_name, status, body) => {
    const { readQuote } = await load();
    answer(status, body);
    expect(await readQuote(ASK)).toEqual({ kind: 'unread', detail: 'Jupiter did not give a price (HTTP 404)' });
  });
});

describe('readQuote: everything else is unread, never "no route" and never a throw', () => {
  it.each([502, 429, 500, 503, 400])('HTTP %i', async (status) => {
    const { readQuote } = await load();
    // Even with the NO_ROUTE body: only a 404 carries that answer.
    answer(status, { error: 'No route', code: 'NO_ROUTE' });
    expect(await readQuote(ASK)).toEqual({ kind: 'unread', detail: `Jupiter did not give a price (HTTP ${status})` });
  });

  it('a network error', async () => {
    const { readQuote } = await load();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await readQuote(ASK)).toEqual({ kind: 'unread', detail: 'Jupiter could not be reached' });
  });

  it.each([
    ['not JSON', 'upstream timeout'],
    ['null', 'null'],
    ['an array', '[]'],
    ['a bare string', '"ok"'],
  ])('a 200 whose body is %s', async (_name, body) => {
    const { readQuote } = await load();
    answer(200, body);
    expect(await readQuote(ASK)).toEqual({ kind: 'unread', detail: 'Jupiter’s answer could not be read' });
  });

  it.each([
    ['another input mint', { inputMint: OTHER }],
    ['another output mint', { outputMint: USDC_MINT }],
    ['another input amount', { inAmount: '100000001' }],
    ['no input amount', { inAmount: undefined }],
  ])('a 200 for a different trade (%s)', async (_name, over) => {
    const { readQuote } = await load();
    answer(200, { ...QUOTE, ...over });
    expect(await readQuote(ASK)).toEqual({ kind: 'unread', detail: 'Jupiter answered for a different trade' });
  });

  it.each([
    ['missing', undefined],
    ['a number', 21762184421],
    ['not digits', '2.17e10'],
    ['negative', '-5'],
    ['zero', '0'],
    ['empty', ''],
  ])('a 200 whose outAmount is %s: unread, never a quote for nothing', async (_name, outAmount) => {
    const { readQuote } = await load();
    answer(200, { ...QUOTE, outAmount });
    expect(await readQuote(ASK)).toEqual({ kind: 'unread', detail: 'Jupiter answered without an amount' });
  });
});

describe('readQuote: a cancelled request is not an answer', () => {
  it('an AbortError is passed on, so a stale request cannot overwrite the screen with "unread"', async () => {
    const { readQuote } = await load();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('The operation was aborted.', 'AbortError'); }));
    await expect(readQuote(ASK)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('the signal reaches fetch', async () => {
    const { readQuote } = await load();
    const spy = answer(200, QUOTE);
    const ctrl = new AbortController();
    await readQuote({ ...ASK, signal: ctrl.signal });
    expect(spy.mock.calls[0]![1]!.signal).toBe(ctrl.signal);
  });
});

describe('isNoRouteBody (moved here from lp/outsidePrice.ts, one implementation)', () => {
  it('only an object whose code is exactly NO_ROUTE', async () => {
    const { isNoRouteBody } = await load();
    const body = (b: string) => new Response(b, { status: 404 });
    expect(await isNoRouteBody(body(JSON.stringify({ error: 'No route', code: 'NO_ROUTE' })))).toBe(true);
    expect(await isNoRouteBody(body(JSON.stringify({ code: 'no_route' })))).toBe(false);
    expect(await isNoRouteBody(body(JSON.stringify({ error: 'NO_ROUTE' })))).toBe(false);
    expect(await isNoRouteBody(body('null'))).toBe(false);
    expect(await isNoRouteBody(body('NO_ROUTE'))).toBe(false);
  });
});

describe('buildSwapWithExpiry: the block height the transaction expires at (T-JUP-12)', () => {
  const build = async (response: Record<string, unknown>) => {
    const j = await load();
    const spy = answer(200, response);
    const built = await j.buildSwapWithExpiry({ quote: QUOTE, userPublicKey: USER, priorityLevel: 'high' });
    return { built, spy, j };
  };

  it('returns lastValidBlockHeight from the response', async () => {
    const { built } = await build({ swapTransaction: 'AAAA', lastValidBlockHeight: 430_812_345 });
    expect(built).toEqual({ swapTransaction: 'AAAA', lastValidBlockHeight: 430_812_345 });
  });

  it.each([
    ['absent', {}],
    ['null', { lastValidBlockHeight: null }],
    ['a string', { lastValidBlockHeight: '430812345' }],
    ['zero', { lastValidBlockHeight: 0 }],
    ['negative', { lastValidBlockHeight: -1 }],
    ['a fraction', { lastValidBlockHeight: 1.5 }],
  ])('%s is null: unknown, never a made-up height', async (_name, extra) => {
    const { built } = await build({ swapTransaction: 'AAAA', ...extra });
    expect(built).toEqual({ swapTransaction: 'AAAA', lastValidBlockHeight: null });
  });

  it('buildSwapTransaction is the same build and the same request, returning only the transaction', async () => {
    const { spy, j } = await build({ swapTransaction: 'AAAA', lastValidBlockHeight: 7 });
    const again = answer(200, { swapTransaction: 'AAAA', lastValidBlockHeight: 7 });
    expect(await j.buildSwapTransaction({ quote: QUOTE, userPublicKey: USER, priorityLevel: 'high' })).toBe('AAAA');
    expect(again.mock.calls[0]![1]!.body).toBe(spy.mock.calls[0]![1]!.body);
  });

  it('no transaction in the response still throws, as before', async () => {
    const j = await load();
    answer(200, { lastValidBlockHeight: 7 });
    await expect(j.buildSwapWithExpiry({ quote: QUOTE, userPublicKey: USER })).rejects.toThrow('No swap transaction returned');
  });
});

describe('feeAccountFor (exported for tests)', () => {
  it('derives the fee owner’s account for the mint, and is null with no owner or a bad one', async () => {
    const { associatedTokenAddress } = await import('./launcher/solana/curve/ix');
    const j = await load();
    expect(j.feeAccountFor(SOL_MINT)).toBe(associatedTokenAddress(new PublicKey(SOL_MINT), PLATFORM_TREASURY_VAULT).toBase58());
    vi.stubEnv('VITE_SOLANA_FEE_ACCOUNT', 'not-a-key');
    expect((await load()).feeAccountFor(SOL_MINT)).toBeNull();
    vi.stubEnv('VITE_SOLANA_FEE_ACCOUNT', '');
    expect((await load()).feeAccountFor(SOL_MINT)).toBeNull();
  });
});
