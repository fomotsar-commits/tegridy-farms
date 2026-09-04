import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GECKO_TIMEFRAMES,
  barsToSeries,
  ohlcvUrlFor,
  readOhlcvBars,
  type GeckoSeries,
  type GeckoTimeframeId,
  type OhlcvUnreadReason,
} from '../lib/chart/ohlcv';
import { marketKey, type ChartableMarket } from '../lib/chart/markets';

// Candles for ONE registry pool from GeckoTerminal. The React shell around
// lib/chart/ohlcv.ts, which owns every rule about the data itself.
//
// `series` is null in every state but `ready`. That is the load-bearing part: an
// empty series and a refused read both draw as a blank chart, and only one of
// them is a statement about the market. A caller that reads `series` without
// reading `status` cannot make that mistake here, because there is nothing to
// read until the answer is real.
//
// ONE FETCH PER (market, timeframe), and DELIBERATELY NO RETRY ON 429.
// GeckoTerminal's keyless limit is per-client and shared with every other island
// page open in the same browser — the bungalow price chart retries a refusal
// five times with escalating sleeps, which is exactly how a rate limit turns
// into a longer one. A refusal here is reported and the reader gets a button.
// A `network` reason (the request never completed) is retried twice, because
// that failure is usually a single dropped connection rather than a decision.
//
// NOTHING POLLS. The 60-second module cache exists so switching back to a pool
// does not spend another read from a shared budget, not so the page can refresh
// itself; `reload()` is the only way to ask again inside that window.

export type GeckoCandlesStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

/** Adds the one failure this hook can produce that the reader cannot. */
export type GeckoCandlesReason = OhlcvUnreadReason | 'off-grid';

export interface GeckoCandlesState {
  status: GeckoCandlesStatus;
  /** Null unless `status` is 'unavailable'. */
  reason: GeckoCandlesReason | null;
  /** Null in every state but 'ready'. Never an empty series standing in for an outage. */
  series: GeckoSeries | null;
  baseSymbol: string | null;
  quoteSymbol: string | null;
  /** The base token's address as the SOURCE reported it. Unvalidated here — the caller gates it. */
  baseAddress: string | null;
  /** Bars the source returned, before this page's own sanity check. */
  barsRead: number;
  /** Buckets asked for. `series.capped` compares the two. */
  limit: number;
  httpStatus: number | null;
  detail: string | null;
  reload: () => void;
}

export interface UseGeckoCandlesOptions {
  market: ChartableMarket | null;
  timeframe: GeckoTimeframeId;
  enabled?: boolean;
}

interface CacheEntry {
  readAt: number;
  value: Omit<GeckoCandlesState, 'reload'>;
}

/**
 * Module-scoped so two mounts of the same pool share one read.
 *
 * Keyed by `marketKey(...):tf` — the pool AND the timeframe. A timeframe-only
 * key is a cross-pool cache the moment a second market exists, and the symptom
 * is one pool's candles rendered under another's ticker with no error anywhere
 * (the mistake lib/chart/market.ts records having made).
 */
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 16;

/** Test seam. The cache outlives a component, so a suite must be able to empty it. */
export function __resetGeckoCandlesCacheForTests(): void {
  cache.clear();
}

const IDLE: Omit<GeckoCandlesState, 'reload'> = {
  status: 'idle',
  reason: null,
  series: null,
  baseSymbol: null,
  quoteSymbol: null,
  baseAddress: null,
  barsRead: 0,
  limit: 0,
  httpStatus: null,
  detail: null,
};

/** Retry delays for a request that never completed, in order. Two, then stop. */
const NETWORK_RETRY_DELAYS_MS = [1_000, 2_000];

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/**
 * Indirection so the global `fetch` is resolved at CALL time.
 *
 * Passing the bare global into the reader would capture whatever binding
 * existed at module load, which a test that stubs `fetch` replaces afterwards —
 * the suite would then be exercising the network instead of the stub.
 */
const liveFetch: typeof fetch = (input, init) => fetch(input, init);

export function useGeckoCandles(opts: UseGeckoCandlesOptions): GeckoCandlesState {
  const { market, timeframe, enabled = true } = opts;
  const [state, setState] = useState<Omit<GeckoCandlesState, 'reload'>>(IDLE);
  const [nonce, setNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  // Which cache key the reader asked to bypass. A bare "nonce > 0" test would
  // keep bypassing the cache for every LATER pool too, quietly turning the
  // shared-budget guard off for the rest of the session after one retry.
  const bypassRef = useRef<string | null>(null);

  // Primitives, not the object: `market` is a fresh identity on most renders,
  // and an effect keyed on it would re-read on every parent re-render.
  const network = market?.network ?? null;
  const pool = market?.pool ?? null;
  const key = network && pool ? `${marketKey(network, pool)}:${timeframe}` : null;

  // Depends on `key` rather than reading a ref during render: a reload has to
  // name the question it is re-asking, and a ref read at render time is exactly
  // the value React cannot promise is the one this render is about.
  const reload = useCallback(() => {
    bypassRef.current = key;
    setNonce((n) => n + 1);
  }, [key]);

  useEffect(() => {
    let cancelled = false;

    if (!enabled || !network || !pool || !key) {
      // R007 Pattern C, same as the read below: the state change is deferred out
      // of the effect body so the lint rule does not flag a cascading render.
      queueMicrotask(() => {
        if (!cancelled) setState(IDLE);
      });
      return () => {
        cancelled = true;
      };
    }

    // A reload must reach the source. Everything else is served from the cache
    // inside its window, including a REFUSAL: re-reading a 429 the moment the
    // reader switches back to the pool is how a shared rate limit gets worse.
    const bypass = bypassRef.current === key;
    bypassRef.current = null;
    if (!bypass) {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.readAt < CACHE_TTL_MS) {
        const cached = hit.value;
        queueMicrotask(() => {
          if (!cancelled) setState(cached);
        });
        return () => {
          cancelled = true;
        };
      }
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const cfg = GECKO_TIMEFRAMES[timeframe];
    const url = ohlcvUrlFor({ network, pool }, timeframe);

    // R007 Pattern C — the synchronous setState is deferred out of the effect
    // body so the lint rule does not flag a cascading render.
    queueMicrotask(async () => {
      if (cancelled) return;
      setState({ ...IDLE, status: 'loading', limit: cfg.limit });

      try {
        for (let attempt = 0; ; attempt += 1) {
          const read = await readOhlcvBars(url, liveFetch, controller.signal);
          if (cancelled) return;

          if (!read.ok) {
            const delay = read.reason === 'network' ? NETWORK_RETRY_DELAYS_MS[attempt] : undefined;
            if (delay !== undefined) {
              await sleep(delay, controller.signal);
              if (cancelled) return;
              continue;
            }
            const failed = {
              ...IDLE,
              status: 'unavailable' as const,
              reason: read.reason,
              httpStatus: read.httpStatus,
              detail: read.detail,
              limit: cfg.limit,
            };
            cache.set(key, { readAt: Date.now(), value: failed });
            setState(failed);
            return;
          }

          const built = barsToSeries(read.bars, cfg.bucketSeconds, {
            capped: read.bars.length >= cfg.limit,
            duplicates: read.duplicates,
            rejected: read.rejected,
          });

          const value: Omit<GeckoCandlesState, 'reload'> = built.ok
            ? {
                status: 'ready',
                reason: null,
                series: built.series,
                baseSymbol: read.meta.baseSymbol,
                quoteSymbol: read.meta.quoteSymbol,
                baseAddress: read.meta.baseAddress,
                barsRead: read.bars.length,
                limit: cfg.limit,
                httpStatus: read.httpStatus,
                detail: null,
              }
            : {
                ...IDLE,
                status: 'unavailable',
                reason: 'off-grid',
                httpStatus: read.httpStatus,
                detail: built.detail,
                limit: cfg.limit,
              };

          if (cache.size >= CACHE_MAX) cache.clear();
          cache.set(key, { readAt: Date.now(), value });
          setState(value);
          return;
        }
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        setState({
          ...IDLE,
          status: 'unavailable',
          reason: 'network',
          detail: 'The request did not complete.',
          limit: cfg.limit,
        });
      }
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [key, network, pool, timeframe, enabled, nonce]);

  return useMemo(() => ({ ...state, reload }), [state, reload]);
}
