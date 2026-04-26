/**
 * R045 (audit-101) tests for the meta-aggregator chainId + slippage hardening.
 *
 * Covers:
 *  - H1: getMetaAggregatorQuotes refuses non-supported chains and tags every
 *        quote with the chainId it was fetched for.
 *  - M1: maxSlippagePct flows uniformly to every aggregator that accepts it,
 *        and is reflected on the returned AggregatorQuote so consumers can
 *        verify "best quote" comparisons are apples-to-apples.
 *  - calculateAggregatorSpread (existing pure helper) still behaves correctly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getMetaAggregatorQuotes,
  getAggregatorPrice,
  calculateAggregatorSpread,
  isAggregatorEnabled,
  DEFAULT_MAX_SLIPPAGE_PCT,
} from './aggregator';

describe('aggregator: chain gating (R045 H1)', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns empty result when chainId is not the supported chain (mainnet)', async () => {
    const result = await getMetaAggregatorQuotes(
      '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      '1000000000000000000',
      '0x000000000000000000000000000000000000dEaD',
      8453, // Base — not supported
    );

    expect(result.best).toBeNull();
    expect(result.allQuotes).toEqual([]);
    expect(result.chainId).toBe(8453);
    // Crucially: no fetches should have been issued for the wrong chain.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns empty result for chainId 0 / undefined-style sentinel', async () => {
    const result = await getMetaAggregatorQuotes('ETH', 'WETH', '1', '0xdead', 0);
    expect(result.best).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('getAggregatorPrice short-circuits to null on wrong chain', async () => {
    const result = await getAggregatorPrice('ETH', 'WETH', '1', '0xdead', 137);
    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('aggregator: chainId tagging on responses (R045 H1)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('tags successful quotes with the chainId they were fetched for', async () => {
    // Mock a single successful response from one aggregator (Odos) and 200/empty from others.
    vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/odos/')) {
        return new Response(JSON.stringify({
          outAmounts: ['1234567890'],
          priceImpact: 0.01,
          gasEstimate: 150_000,
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const result = await getMetaAggregatorQuotes(
      '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      '1000000000000000000',
      '0x000000000000000000000000000000000000dEaD',
      1,
    );

    expect(result.chainId).toBe(1);
    // Odos quote should have landed and be tagged with chainId 1.
    expect(result.allQuotes.length).toBeGreaterThan(0);
    for (const q of result.allQuotes) {
      expect(q.chainId).toBe(1);
    }
    expect(result.best?.chainId).toBe(1);
  });
});

describe('aggregator: uniform slippage propagation (R045 M1)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes user-supplied slippage to Odos as slippageLimitPercent', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ outAmounts: ['100'] }), { status: 200 }),
    );

    await getMetaAggregatorQuotes('ETH', 'WETH', '1', '0xdead', 1, /* slippage */ 1.25);

    const odosCall = fetchSpy.mock.calls.find(([url]) =>
      typeof url === 'string' && url.includes('/odos/'),
    );
    expect(odosCall).toBeDefined();
    const body = JSON.parse((odosCall![1] as RequestInit).body as string);
    expect(body.slippageLimitPercent).toBe(1.25);
  });

  it('passes user-supplied slippage to SwapAPI as a fraction (maxSlippage)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ amountOut: '100', priceImpact: 0 }), { status: 200 }),
    );

    await getMetaAggregatorQuotes('ETH', 'WETH', '1', '0xdead', 1, /* slippage */ 0.5);

    const swapApiCall = fetchSpy.mock.calls.find(([url]) =>
      typeof url === 'string' && url.includes('swapapi.dev'),
    );
    expect(swapApiCall).toBeDefined();
    const url = String(swapApiCall![0]);
    // 0.5% should serialize as a fraction (0.005) since SwapAPI uses fractional slippage.
    expect(url).toMatch(/maxSlippage=0\.005/);
  });

  it('passes user-supplied slippage to Li.Fi as a fraction (slippage)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ estimate: { toAmount: '100' } }), { status: 200 }),
    );

    await getMetaAggregatorQuotes('ETH', 'WETH', '1', '0xdead', 1, /* slippage */ 1);

    const lifiCall = fetchSpy.mock.calls.find(([url]) =>
      typeof url === 'string' && url.includes('/lifi/'),
    );
    expect(lifiCall).toBeDefined();
    const url = String(lifiCall![0]);
    expect(url).toMatch(/slippage=0\.01/);
  });

  it('clamps absurd slippage values into the safe band', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ outAmounts: ['100'] }), { status: 200 }),
    );

    // 99 should clamp to 50; -1 should clamp to 0.05
    await getMetaAggregatorQuotes('ETH', 'WETH', '1', '0xdead', 1, 99);
    let odos = fetchSpy.mock.calls.find(([u]) => typeof u === 'string' && u.includes('/odos/'));
    let body = JSON.parse((odos![1] as RequestInit).body as string);
    expect(body.slippageLimitPercent).toBe(50);

    fetchSpy.mockClear();

    await getMetaAggregatorQuotes('ETH', 'WETH', '1', '0xdead', 1, -1);
    odos = fetchSpy.mock.calls.find(([u]) => typeof u === 'string' && u.includes('/odos/'));
    body = JSON.parse((odos![1] as RequestInit).body as string);
    expect(body.slippageLimitPercent).toBe(0.05);
  });

  it('falls back to DEFAULT_MAX_SLIPPAGE_PCT when slippage is omitted', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ outAmounts: ['100'] }), { status: 200 }),
    );
    await getMetaAggregatorQuotes('ETH', 'WETH', '1', '0xdead', 1);
    const odos = fetchSpy.mock.calls.find(([u]) => typeof u === 'string' && u.includes('/odos/'));
    const body = JSON.parse((odos![1] as RequestInit).body as string);
    expect(body.slippageLimitPercent).toBe(DEFAULT_MAX_SLIPPAGE_PCT);
  });
});

describe('aggregator: pure helpers', () => {
  it('isAggregatorEnabled returns true', () => {
    expect(isAggregatorEnabled()).toBe(true);
  });

  it('calculateAggregatorSpread: aggregator worse than direct returns shouldUseAggregator=false', () => {
    const r = calculateAggregatorSpread(1000n, 900n);
    expect(r.shouldUseAggregator).toBe(false);
    expect(r.userReceives).toBe(1000n);
  });

  it('calculateAggregatorSpread: aggregator better than direct returns improvement', () => {
    const r = calculateAggregatorSpread(1000n, 1010n);
    expect(r.shouldUseAggregator).toBe(true);
    expect(r.improvement).toBe(10n);
    expect(r.userReceives).toBe(1010n);
    expect(r.userSavingsBps).toBe(100); // 1% == 100 bps
  });

  it('calculateAggregatorSpread: zero on-chain output is handled safely', () => {
    const r = calculateAggregatorSpread(0n, 100n);
    expect(r.shouldUseAggregator).toBe(false);
    expect(r.userReceives).toBe(0n);
  });
});
