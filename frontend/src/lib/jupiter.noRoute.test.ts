// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getQuote, NoRouteError } from './jupiter';

/**
 * getQuote tells "Jupiter has no route" apart from "the quote could not be fetched".
 *
 * Our proxy turns Jupiter's own no-route codes into a 404 with the fixed body
 * {"error":"No route","code":"NO_ROUTE"} (api/_lib/aggregator-proxy.js, pinned in
 * api/__tests__/aggregator-proxy.test.js) and every other upstream failure into a
 * 502. Only that exact answer is "no route". This is the rule
 * lib/solana/lp/outsidePrice.ts already follows; before this, getQuote threw the
 * same "Quote unavailable (status)" for all of them, and the swap page worded
 * every one as "No route".
 */

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ASK = { inputMint: SOL, outputMint: USDC, amount: '100000000', slippageBps: 50 };

function answer(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(text, { status })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getQuote: only the proxy’s own NO_ROUTE answer is "no route"', () => {
  it('a 404 carrying code NO_ROUTE rejects with NoRouteError', async () => {
    answer(404, { error: 'No route', code: 'NO_ROUTE' });
    const err = await getQuote(ASK).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(NoRouteError);
    expect((err as Error).name).toBe('NoRouteError');
    expect((err as Error).message).toMatch(/no route/i);
  });

  it.each([
    ['a 404 with another body (a path off the allowlist)', 404, { error: 'Not found' }],
    ['a 404 that is not JSON (a rewrite gone wrong)', 404, '<!doctype html><title>Not found</title>'],
    ['a 404 whose JSON is null', 404, 'null'],
    ['the proxy’s 502 for an upstream failure', 502, { error: 'Upstream service error' }],
    ['a 502 that happens to carry the code', 502, { error: 'No route', code: 'NO_ROUTE' }],
    ['the rate limit', 429, { error: 'Too many requests' }],
  ])('%s is a failed fetch, with its status, and NOT NoRouteError', async (_name, status, body) => {
    answer(status, body);
    const err = await getQuote(ASK).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NoRouteError);
    expect((err as Error).message).toBe(`Quote unavailable (${status})`);
    expect((err as Error).message).not.toMatch(/no route/i);
  });

  it('a request that never arrived rejects with the fetch error, NOT NoRouteError', async () => {
    const dropped = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn(async () => { throw dropped; }));
    const err = await getQuote(ASK).then(() => null, (e: unknown) => e);
    expect(err).toBe(dropped);
    expect(err).not.toBeInstanceOf(NoRouteError);
  });

  it('a quote that answered is returned as it came', async () => {
    const quote = { inputMint: SOL, outputMint: USDC, inAmount: '100000000', outAmount: '14925000' };
    answer(200, quote);
    await expect(getQuote(ASK)).resolves.toEqual(quote);
  });
});
