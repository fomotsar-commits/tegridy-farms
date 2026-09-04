/**
 * R080 wiring (2026-08-28): production actually consults the per-provider zod
 * schemas at each `res.json()` boundary in `lib/aggregator.ts`.
 *
 * `schemas/schemas.test.ts` proves the schemas can parse fixtures; nothing
 * there can prove `aggregator.ts` calls them. Every "malformed" fixture below
 * was chosen to sail PAST the inline amountOut guard (so before the wiring,
 * these tests fail with the provider's quote present — red-run verified
 * against the pre-wiring tree on 2026-08-28) and to violate the provider's
 * schema (so after the wiring, that one provider is skipped and the quote
 * race survives).
 *
 * The well-formed fixtures are the other half of the breadth check: rich,
 * realistic bodies (extra keys everywhere, Odos' real `priceImpact: null`)
 * must still produce quotes, or the schema gate would be silently benching
 * healthy providers.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getMetaAggregatorQuotes } from './aggregator';

const AMOUNT = '1000000000000000000';
const SENDER = '0x000000000000000000000000000000000000dEaD';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

/** Serve `body` for the provider whose proxy URL contains `fragment`; every other provider 404s. */
function mockOnly(fragment: string, body: unknown) {
  return vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes(fragment)) return new Response(JSON.stringify(body), { status: 200 });
    return new Response('{}', { status: 404 });
  });
}

/** Serve one body per provider URL fragment; unmatched providers 404. */
function mockMany(bodies: Record<string, unknown>) {
  return vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const [fragment, body] of Object.entries(bodies)) {
      if (url.includes(fragment)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
}

const quotes = () => getMetaAggregatorQuotes('ETH', WETH, AMOUNT, SENDER, 1);

afterEach(() => vi.restoreAllMocks());

describe('schema gate: malformed bodies the inline guard alone waves through', () => {
  it('SwapAPI: a non-object `tx` drops the quote instead of shipping it', async () => {
    // amountOut + priceImpact satisfy the inline guard; `tx` as a string is
    // outside the contract. Pre-wiring this produced a quote.
    mockOnly('/api/swapapi/', { amountOut: '123000', priceImpact: 0.01, tx: 'gimme' });
    const result = await quotes();
    expect(result.allQuotes.map((q) => q.source)).not.toContain('swapapi');
    expect(result.best).toBeNull();
  });

  it('Odos: a poisoned outAmounts element beyond [0] drops the quote', async () => {
    // The inline guard reads only outAmounts[0]; the schema validates every
    // element. Pre-wiring this produced a quote.
    mockOnly('/odos/', { outAmounts: ['5000000', 'DROP TABLE quotes'] });
    const result = await quotes();
    expect(result.allQuotes.map((q) => q.source)).not.toContain('odos');
    expect(result.best).toBeNull();
  });

  it('KyberSwap: a non-scalar routeSummary.gas drops the quote', async () => {
    // Pre-wiring this produced a quote whose estimatedGas was the literal
    // string "[object Object]".
    mockOnly('/kyber/', { data: { routeSummary: { amountOut: '777000', gas: {} } } });
    const result = await quotes();
    expect(result.allQuotes.map((q) => q.source)).not.toContain('kyberswap');
    expect(result.best).toBeNull();
  });

  it('a malformed provider is skipped; the race and the healthy provider survive', async () => {
    mockMany({
      '/api/swapapi/': { amountOut: '999999', priceImpact: 0, tx: ['not', 'an', 'object'] },
      '/odos/': { outAmounts: ['888888'], priceImpact: 0.02 },
    });
    const result = await quotes();
    expect(result.allQuotes.map((q) => q.source)).toEqual(['odos']);
    expect(result.best?.source).toBe('odos');
    expect(result.best?.amountOut).toBe('888888');
  });
});

describe('schema gate breadth: rich realistic bodies still quote', () => {
  it.each([
    ['swapapi', '/api/swapapi/', {
      amountOut: '123', priceImpact: 0.3,
      tx: { to: WETH, data: '0xdeadbeef', value: '0', gas: '210000' },
      route: [{ pool: '0xabc' }],
    }],
    ['odos', '/odos/', {
      // priceImpact: null is real Odos behaviour on some routes — the schema
      // must tolerate it or Odos gets benched in production.
      outAmounts: ['999'], priceImpact: null, gasEstimate: 412000.5,
      pathId: '0f81a', blockNumber: 23456789, netOutValue: 12.5,
    }],
    ['cowswap', '/cow/', {
      quote: {
        sellToken: WETH, buyToken: WETH, buyAmount: '888', sellAmount: AMOUNT,
        feeAmount: '31500000000000', validTo: 1756400000, kind: 'sell',
      },
      id: 424242, expiration: '2026-08-28T00:00:00Z', verified: true,
    }],
    ['lifi', '/lifi/', {
      type: 'lifi', tool: '1inch',
      estimate: {
        toAmount: '777', fromAmount: AMOUNT, toAmountMin: '770',
        gasCosts: [{ type: 'SEND', estimate: '21000', amount: '31500000000000', token: { symbol: 'ETH' } }],
        executionDuration: 30,
      },
      transactionRequest: { to: WETH, data: '0x' },
    }],
    ['kyberswap', '/kyber/', {
      code: 0, message: 'successfully', requestId: 'r-1',
      data: {
        routeSummary: {
          amountOut: '666', gas: '253000', tokenIn: WETH, tokenOut: WETH,
          amountIn: AMOUNT, gasUsd: '1.02', route: [[{ pool: '0xdef' }]],
        },
        routerAddress: WETH,
      },
    }],
    ['openocean', '/openocean/', {
      code: 200,
      data: {
        outAmount: '555', estimatedGas: 189000, price_impact: '-0.09%',
        inToken: { symbol: 'ETH', decimals: 18 }, path: { from: 'ETH' },
      },
    }],
    ['paraswap', '/paraswap/', {
      priceRoute: {
        destAmount: '444', srcAmount: AMOUNT, gasCost: '227300', gasCostUSD: '1.2',
        side: 'SELL', network: 1, bestRoute: [{ percent: 100 }], hmac: '0f81a',
      },
    }],
  ])('%s: realistic body with extra keys yields a quote', async (source, fragment, body) => {
    mockOnly(fragment as string, body);
    const result = await quotes();
    expect(result.allQuotes.map((q) => q.source)).toEqual([source]);
  });
});
