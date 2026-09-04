// R080 at the boundary it was written for.
//
// The OHLCV schema shipped months ago and was applied at zero call sites, so the
// sparkline was assembled by walking `json?.data?.attributes?.ohlcv_list` with
// optional chaining — any shape that happened to survive the walk became a price
// chart. These cases pin the opposite behaviour: a response that does not match
// the schema produces the explicit "unavailable" state, never a partial series.
//
// A truncated or hostile series rendering as a plausible-looking chart is the
// failure mode that matters here; an empty chart with an error line is not.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('../lib/storage', () => ({
  safeSetItem: vi.fn(),
  safeGetItem: vi.fn().mockReturnValue(null),
  safeJsonParse: <T,>(_str: unknown, fallback: T) => fallback,
}));

import { usePriceHistory } from './usePriceHistory';

/** A GeckoTerminal OHLCV candle: [ts, open, high, low, close, volume]. */
function candle(ts: number, close: number): [number, number, number, number, number, number] {
  return [ts, close, close, close, close, 1000];
}

function stubFetch(body: unknown, ok = true): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
}

describe('usePriceHistory', () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a well-formed series oldest-first', async () => {
    stubFetch({
      data: { attributes: { ohlcv_list: [candle(300, 3), candle(200, 2), candle(100, 1)] } },
    });
    const { result } = renderHook(() => usePriceHistory());
    await waitFor(() => expect(result.current.history.length).toBe(3));
    // GeckoTerminal returns newest-first; the sparkline draws left-to-right.
    expect(result.current.history).toEqual([1, 2, 3]);
    expect(result.current.error).toBeNull();
  });

  it('refuses a series whose candles are strings, rather than coercing them', async () => {
    // The pre-R080 walk ran Number() over each entry, so "0.0001" charted fine —
    // and so did anything else that coerced. The type is the contract now.
    stubFetch({
      data: { attributes: { ohlcv_list: [[300, '3', '3', '3', '3', '0'], [200, '2', '2', '2', '2', '0']] } },
    });
    const { result } = renderHook(() => usePriceHistory());
    await waitFor(() => expect(result.current.error).toBe('Price data unavailable'), { timeout: 8000 });
    expect(result.current.history).toEqual([]);
  }, 12000);

  it('refuses a response with the wrong envelope instead of charting an empty one', async () => {
    stubFetch({ ohlcv_list: [candle(300, 3), candle(200, 2)] });
    const { result } = renderHook(() => usePriceHistory());
    await waitFor(() => expect(result.current.error).toBe('Price data unavailable'), { timeout: 8000 });
    expect(result.current.history).toEqual([]);
  }, 12000);

  it('drops a negative close rather than plotting it — the schema checks type, not sign', async () => {
    stubFetch({
      data: {
        attributes: {
          ohlcv_list: [candle(400, 4), [300, 3, 3, 3, -3, 0], candle(200, 2), candle(100, 1)],
        },
      },
    });
    const { result } = renderHook(() => usePriceHistory());
    await waitFor(() => expect(result.current.history.length).toBe(3));
    expect(result.current.history).toEqual([1, 2, 4]);
  });

  it('does not re-ask a refused read — a 429 is spent budget, not a hiccup', async () => {
    // Migrated onto lib/chart/ohlcv.ts's single reader (2026-09-02). Before that
    // this hook retried EVERY failure twice with backoff, 429 included, against
    // a keyless limit shared with every other GeckoTerminal reader in the tab.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: () => Promise.resolve({ status: { error_code: 429 } }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => usePriceHistory());
    await waitFor(() => expect(result.current.error).toBe('Price data unavailable'));
    expect(result.current.history).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses the whole response when any candle carries a non-finite number', async () => {
    // Infinity is where zod stops, so this is an envelope rejection, not a
    // dropped candle — the series is never partially rebuilt from a bad payload.
    stubFetch({
      data: {
        attributes: { ohlcv_list: [candle(400, 4), [300, 3, 3, 3, Infinity, 0], candle(200, 2)] },
      },
    });
    const { result } = renderHook(() => usePriceHistory());
    await waitFor(() => expect(result.current.error).toBe('Price data unavailable'), { timeout: 8000 });
    expect(result.current.history).toEqual([]);
  }, 12000);
});
