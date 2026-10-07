// The dollar prices behind the LP pages' "about $" lines: off means no Jupiter call at
// all; on means one price/v3 call for the three pairing coins, kept 60 s, and a price that
// was not read (a 429, a missing coin, a zero) is null for that coin, never 0.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { BAYLA_MINT, USDC_MINT, WSOL_MINT } from '../../../lib/solana/lp/tokenSafety';
import { USD_LINES } from '../../../lib/solana/lp/usd';
import { USD_PRICES_TTL_MS, __resetUsdPrices, useUsdPrices } from './useUsdPrices';

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const PRICES = { [WSOL_MINT]: { usdPrice: 150 }, [USDC_MINT]: { usdPrice: 0.99 }, [BAYLA_MINT]: null };

beforeEach(() => __resetUsdPrices());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useUsdPrices', () => {
  it('ships off, and off means no fetch: every coin null, no read time', async () => {
    expect(USD_LINES).toBe('off');
    const fetchMock = vi.fn(async () => response(PRICES));
    vi.stubGlobal('fetch', fetchMock);
    const h = renderHook(() => useUsdPrices(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.result.current).toEqual({ prices: { SOL: null, USDC: null, BAYLA: null }, readAt: null });
  });

  it('on: one price/v3 call naming the three coins; a read price > 0 is kept, a missing one is null', async () => {
    const fetchMock = vi.fn<(input: string) => Promise<Response>>(async () => response(PRICES));
    vi.stubGlobal('fetch', fetchMock);
    const before = Date.now();
    const h = renderHook(() => useUsdPrices(0, 'on'));
    await waitFor(() => expect(h.result.current.readAt).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url.startsWith('/api/jupiter/price/v3?ids=')).toBe(true);
    for (const mint of [WSOL_MINT, USDC_MINT, BAYLA_MINT]) expect(url).toContain(mint);
    expect(h.result.current.prices).toEqual({ SOL: 150, USDC: 0.99, BAYLA: null });
    expect(h.result.current.readAt).toBeGreaterThanOrEqual(before);
  });

  it('a 429 is null for every coin, not 0, with no read time', async () => {
    const fetchMock = vi.fn(async () => response({ error: 'busy' }, 429));
    vi.stubGlobal('fetch', fetchMock);
    const h = renderHook(() => useUsdPrices(0, 'on'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.result.current).toEqual({ prices: { SOL: null, USDC: null, BAYLA: null }, readAt: null });
  });

  it('a zero, negative or non-finite price is null for that coin: $0 is a value a visitor would read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ [WSOL_MINT]: { usdPrice: 0 }, [USDC_MINT]: { usdPrice: -1 }, [BAYLA_MINT]: { usdPrice: 0.002 } })));
    const h = renderHook(() => useUsdPrices(0, 'on'));
    await waitFor(() => expect(h.result.current.readAt).not.toBeNull());
    expect(h.result.current.prices).toEqual({ SOL: null, USDC: null, BAYLA: 0.002 });
  });

  it('a read is kept 60 s: a second mount or a Read again inside that window makes no new call, after it one', async () => {
    const fetchMock = vi.fn(async () => response(PRICES));
    vi.stubGlobal('fetch', fetchMock);
    const t0 = 1_760_000_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    const first = renderHook(() => useUsdPrices(0, 'on'));
    await waitFor(() => expect(first.result.current.readAt).toBe(t0));
    now.mockReturnValue(t0 + USD_PRICES_TTL_MS - 1);
    const second = renderHook((k: number) => useUsdPrices(k, 'on'), { initialProps: 0 });
    await waitFor(() => expect(second.result.current.readAt).toBe(t0));
    second.rerender(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now.mockReturnValue(t0 + USD_PRICES_TTL_MS);
    second.rerender(2);
    await waitFor(() => expect(second.result.current.readAt).toBe(t0 + USD_PRICES_TTL_MS));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
