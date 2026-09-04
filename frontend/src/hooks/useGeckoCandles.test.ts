import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useGeckoCandles, __resetGeckoCandlesCacheForTests } from './useGeckoCandles';
import type { ChartableMarket } from '../lib/chart/markets';

// The hook's whole job is to keep "could not read" and "nothing traded" apart,
// and to spend the shared GeckoTerminal budget once per question. Each case
// names the mutation it kills.

const MARKET: ChartableMarket = { network: 'eth', pool: '0xabc', label: 'TOWELI' };
const OTHER: ChartableMarket = { network: 'solana', pool: 'So11111111111111111111111111111111111111112', label: 'BAYLA' };

const HOUR = 3600;

function envelope(list: number[][], meta?: unknown): unknown {
  return { data: { attributes: { ohlcv_list: list } }, ...(meta === undefined ? {} : { meta }) };
}

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  __resetGeckoCandlesCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useGeckoCandles', () => {
  it('does not fetch at all without a pool, and holds a null series', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useGeckoCandles({ market: null, timeframe: '1h' }));
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.series).toBeNull();
  });

  it('reads one pool once and reports the source\'s own symbols', async () => {
    // Typed as the real `fetch`: the URL this hook builds is asserted below, and
    // an untyped vi.fn() has an empty argument tuple, so `calls[0][0]` would not
    // be reachable at all.
    const fetchMock = vi.fn<typeof fetch>(async () =>
      response(
        envelope(
          [
            [0, 1, 2, 0.5, 1.5, 10],
            [HOUR, 1.5, 1.6, 1.4, 1.55, 0],
          ],
          { base: { symbol: 'TOWELI', address: '0xdead' }, quote: { symbol: 'WETH' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useGeckoCandles({ market: MARKET, timeframe: '1h' }));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      'api.geckoterminal.com/api/v2/networks/eth/pools/0xabc/ohlcv/hour',
    );
    expect(result.current.quoteSymbol).toBe('WETH');
    expect(result.current.baseAddress).toBe('0xdead');
    expect(result.current.barsRead).toBe(2);
    expect(result.current.series?.candleCount).toBe(2);
    // The zero-volume bucket stayed a candle and was counted, not hidden.
    expect(result.current.series?.zeroVolumeBars).toBe(1);
    expect(result.current.reason).toBeNull();
  });

  it('treats a 429 as a refusal and does NOT retry it', async () => {
    const fetchMock = vi.fn(async () =>
      response({ status: { error_code: 429, error_message: 'rate limited' } }, 429),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useGeckoCandles({ market: MARKET, timeframe: '1h' }));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));

    expect(result.current.reason).toBe('rate-limited');
    expect(result.current.httpStatus).toBe(429);
    // Mutation: copy PriceChart's five-attempt backoff onto this path and a
    // shared rate limit gets five times worse every time the page opens.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The state a refused read leaves behind must not be drawable.
    expect(result.current.series).toBeNull();
  });

  it('retries a dead connection at most twice, then reports it', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useGeckoCandles({ market: MARKET, timeframe: '1h' }));

    // Three attempts total: the first plus two retries at 1 s and 2 s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });

    expect(result.current.status).toBe('unavailable');
    expect(result.current.reason).toBe('network');
    // Mutation: an unbounded retry loop would keep this climbing.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('refuses an off-grid answer rather than bending the time axis', async () => {
    // A 4h frame whose bars sit on hour boundaries.
    const fetchMock = vi.fn(async () =>
      response(envelope([[0, 1, 1, 1, 1, 1], [HOUR, 1, 1, 1, 1, 1]])),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useGeckoCandles({ market: MARKET, timeframe: '4h' }));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.reason).toBe('off-grid');
    expect(result.current.series).toBeNull();
  });

  it('serves a second mount of the same question from cache, and re-reads on reload()', async () => {
    const fetchMock = vi.fn(async () => response(envelope([[0, 1, 1, 1, 1, 1]])));
    vi.stubGlobal('fetch', fetchMock);

    const first = renderHook(() => useGeckoCandles({ market: MARKET, timeframe: '1h' }));
    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    first.unmount();

    const second = renderHook(() => useGeckoCandles({ market: MARKET, timeframe: '1h' }));
    await waitFor(() => expect(second.result.current.status).toBe('ready'));
    // Mutation: drop the cache and every remount spends another read from a
    // budget shared with every other open island page.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      second.result.current.reload();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('caches per (pool, timeframe) — never one pool\'s candles under another\'s name', async () => {
    const fetchMock = vi.fn(async (url: unknown) =>
      response(
        envelope(
          [[0, String(url).includes('/solana/') ? 99 : 1, 100, 0.5, 50, 1]],
          { base: { symbol: String(url).includes('/solana/') ? 'BAYLA' : 'TOWELI' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result, rerender } = renderHook(
      ({ market }: { market: ChartableMarket }) => useGeckoCandles({ market, timeframe: '1h' }),
      { initialProps: { market: MARKET } },
    );
    await waitFor(() => expect(result.current.baseSymbol).toBe('TOWELI'));

    rerender({ market: OTHER });
    // Mutation: key the cache on the timeframe alone (the bug lib/chart/market.ts
    // records) and the second pool is served the first pool's candles with no
    // error anywhere.
    await waitFor(() => expect(result.current.baseSymbol).toBe('BAYLA'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/networks/solana/pools/');
  });

  it('reports a 404 as this source\'s own coverage, with no series behind it', async () => {
    const fetchMock = vi.fn(async () => response({}, 404));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useGeckoCandles({ market: MARKET, timeframe: '1h' }));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.reason).toBe('not-found');
    expect(result.current.series).toBeNull();
  });

  it('is ready-but-empty when the source returns no bucket — not unavailable', async () => {
    const fetchMock = vi.fn(async () => response(envelope([])));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useGeckoCandles({ market: MARKET, timeframe: '1h' }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    // Mutation: collapse this into 'unavailable' and "the window was empty at
    // the source" becomes indistinguishable from "the source did not answer".
    expect(result.current.series?.candleCount).toBe(0);
    expect(result.current.reason).toBeNull();
  });
});
