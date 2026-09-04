// The chart used to be hardcoded to TOWELI/WETH on Ethereum, and its in-memory
// OHLCV cache was keyed by TIMEFRAME ALONE. That was harmless while exactly one
// pool existed and becomes a cross-pool cache the moment a second one does: the
// Bayla bungalow would have been served TOWELI's candles under her own ticker,
// with no error anywhere. Both halves of the fix are pinned here.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CHART_CANDLES_CACHE_MAX,
  __resetChartCandleCacheForTests,
  ohlcvCacheKey,
  ohlcvUrl,
  readChartCandles,
  TOWELI_MARKET,
  type ChartMarket,
} from './market';

const BAYLA: ChartMarket = {
  network: 'solana',
  pool: '8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n',
  label: 'BAYLA',
};

describe('chart market parameterisation', () => {
  it('gives two pools different cache keys at the same timeframe', () => {
    expect(ohlcvCacheKey(BAYLA, '1d')).not.toBe(ohlcvCacheKey(TOWELI_MARKET, '1d'));
  });

  it('still separates timeframes within one pool', () => {
    expect(ohlcvCacheKey(BAYLA, '1h')).not.toBe(ohlcvCacheKey(BAYLA, '1d'));
  });

  it('is stable for the same pool + timeframe, so the cache still hits', () => {
    expect(ohlcvCacheKey(BAYLA, '4h')).toBe(ohlcvCacheKey({ ...BAYLA }, '4h'));
  });

  it('requests the bungalow pool on its own network', () => {
    const url = ohlcvUrl(BAYLA, '1d');
    expect(url).toContain('/networks/solana/');
    expect(url).toContain(BAYLA.pool);
    expect(url).not.toContain('/networks/eth/');
  });

  it('leaves the default TOWELI market on Ethereum, unchanged', () => {
    expect(TOWELI_MARKET.network).toBe('eth');
    const url = ohlcvUrl(TOWELI_MARKET, '1d');
    expect(url).toContain('/networks/eth/');
    expect(url).toContain(TOWELI_MARKET.pool);
  });
});

// `currency` became a parameter (2026-09-02) so a SOL-denominated chart of a SOL
// pair is possible: USD candles fold the quote token's own move into the token's,
// which on a volatile quote is a chart of two things at once. The default is the
// value that was hardcoded, so every pre-existing call site must be untouched —
// that is the half worth pinning, because a defaulted-away parameter lands in the
// URL as `currency=undefined` and GeckoTerminal answers it as a 404, silently.
describe('ohlcv currency', () => {
  it('defaults to usd, byte-identically to the hardcoded form', () => {
    expect(ohlcvUrl(BAYLA, '1d')).toBe(ohlcvUrl(BAYLA, '1d', 'usd'));
    expect(ohlcvUrl(BAYLA, '1d')).toContain('&currency=usd');
    expect(ohlcvUrl(BAYLA, '1d')).not.toContain('undefined');
  });

  it('asks for the quote token when told to', () => {
    expect(ohlcvUrl(BAYLA, '1d', 'token')).toContain('&currency=token');
    expect(ohlcvUrl(BAYLA, '1d', 'token')).not.toContain('currency=usd');
  });
});


// ─── PERF-07 / PERF-12 ───────────────────────────────────────────────────────
//
// The chart's reader used to retry a 429 FIVE times with escalating sleeps
// (1.6s / 3.2s / 4.8s / 6.4s) against GeckoTerminal's keyless budget — which is
// per-CLIENT and shared with every other island surface in the same tab. One
// chart could therefore spend the whole page's quota on a refusal, and the
// visitor waited ~16s to be told nothing. It also had no deadline at all, and it
// evicted its cache by CLEARING IT, so a visitor cycling nine pools paid a fresh
// read on every switch.
//
// These three pin the policy rather than the numbers: what matters is that a
// refusal costs exactly one request, that a hung upstream ends, and that a full
// cache loses one entry rather than all of them.

function envelope(list: number[][]): unknown {
  return { data: { attributes: { ohlcv_list: list } } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const HOUR = 3600;
const OK_BODY = envelope([[HOUR, 1, 1, 1, 1, 1]]);

function poolAt(i: number): ChartMarket {
  return { network: 'eth', pool: `0x${String(i).padStart(40, '0')}`, label: `P${i}` };
}

describe('readChartCandles spends the shared GeckoTerminal budget once', () => {
  beforeEach(() => {
    __resetChartCandleCacheForTests();
  });

  it('reports a 429 instead of retrying it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: { error_code: 429 } }, 429));

    const read = await readChartCandles(TOWELI_MARKET, '1d', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.reason).toBe('rate-limited');
  });

  it('ends a hung upstream at its own deadline rather than spinning forever', async () => {
    // Accepts the connection and never answers — the exact shape a timeout is
    // for, and the one an AbortSignal-for-cancellation-only cannot survive.
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );

    const read = await readChartCandles(TOWELI_MARKET, '4h', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 20,
    });

    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.reason).toBe('timeout');
    // Names the READ, never the market: "no candles" and "we never heard back"
    // are different sentences and must never collapse into one.
    expect(read.detail).toMatch(/not about the market/);
  });

  it('evicts one entry when full, not the whole cache', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(OK_BODY));
    const opts = { fetchImpl: fetchImpl as unknown as typeof fetch };

    for (let i = 0; i < CHART_CANDLES_CACHE_MAX; i += 1) {
      await readChartCandles(poolAt(i), '1d', opts);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(CHART_CANDLES_CACHE_MAX);

    // One past the ceiling. The OLDEST key goes; everything after it stays.
    await readChartCandles(poolAt(CHART_CANDLES_CACHE_MAX), '1d', opts);
    expect(fetchImpl).toHaveBeenCalledTimes(CHART_CANDLES_CACHE_MAX + 1);

    // The second-inserted pool is still cached, so switching back costs nothing.
    // Under the clear-everything policy this was a miss and a fresh read from
    // the shared budget — on every single switch.
    await readChartCandles(poolAt(1), '1d', opts);
    expect(fetchImpl).toHaveBeenCalledTimes(CHART_CANDLES_CACHE_MAX + 1);

    // ...and the one that WAS evicted is re-read, so the cache is really bounded
    // rather than merely never evicting.
    await readChartCandles(poolAt(0), '1d', opts);
    expect(fetchImpl).toHaveBeenCalledTimes(CHART_CANDLES_CACHE_MAX + 2);
  });
});
