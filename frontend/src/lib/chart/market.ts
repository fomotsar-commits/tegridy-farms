import { TOWELI_WETH_LP_ADDRESS } from '../constants';
import type { GeckoNetwork } from '../geckoTerminal/pools';
import { readOhlcvBars, type OhlcvBar, type OhlcvUnreadReason } from './ohlcv';

/**
 * Re-exported so chart code names the network type from the module it already
 * imports. The type is defined once, next to the reader that validates against
 * it; this is a type-only re-export, so nothing from geckoTerminal/ is pulled
 * into the chart's chunk at runtime.
 */
export type { GeckoNetwork };

/**
 * Which pool a price chart draws, and the GeckoTerminal URLs for it.
 *
 * Split out of components/chart/PriceChart.tsx (2026-08-28) so that file only
 * exports components again — exporting these alongside it broke Fast Refresh.
 *
 * The chart was hardcoded to TOWELI/WETH on Ethereum before this, which is why
 * the Bayla bungalow had no chart at all: her pool is BAYLA/SOL on PumpSwap and
 * GeckoTerminal covers Solana perfectly well. The only thing missing was the
 * parameter.
 */
export type ChartMarket = {
  /**
   * GeckoTerminal network slug. CLOSED (2026-09-02): it used to be `string`,
   * which meant 'ethereum' — this app's own word for that chain everywhere else
   * — compiled fine here and 404'd at GeckoTerminal, where a wrong slug returns
   * "not found" rather than an error a chart could report.
   */
  network: GeckoNetwork;
  /** Pool (pair) address on that network. */
  pool: string;
  /** Human label, used for the iframe title. */
  label: string;
};

/** The venue's own pool. Every pre-existing call site resolves to this. */
export const TOWELI_MARKET: ChartMarket = {
  network: 'eth',
  pool: TOWELI_WETH_LP_ADDRESS,
  label: 'TOWELI',
};

export type Timeframe = '1h' | '4h' | '1d' | '1w';

export const TF_CONFIG: Record<Timeframe, { apiTf: string; aggregate: string; label: string; limit: number }> = {
  '1h': { apiTf: 'hour', aggregate: '1', label: '1H', limit: 168 },
  '4h': { apiTf: 'hour', aggregate: '4', label: '4H', limit: 90 },
  '1d': { apiTf: 'day', aggregate: '1', label: '1D', limit: 90 },
  '1w': { apiTf: 'day', aggregate: '7', label: '1W', limit: 52 },
};

export const chartPoolUrl = (m: ChartMarket) =>
  `https://www.geckoterminal.com/${m.network}/pools/${m.pool}`;

export const chartEmbedUrl = (m: ChartMarket) =>
  `${chartPoolUrl(m)}?embed=1&info=0&swaps=0&grayscale=0&light_chart=0`;

/**
 * Cache key for the in-memory OHLCV cache. It MUST include the pool: the key
 * used to be the timeframe alone, which is a cross-pool cache the moment a
 * second market exists — the bungalow chart would have been served TOWELI's
 * candles under its own ticker, with no error anywhere.
 */
export function ohlcvCacheKey(market: ChartMarket, tf: Timeframe): string {
  return `${market.network}:${market.pool}:${tf}`;
}

/**
 * The GeckoTerminal OHLCV endpoint for a market + timeframe.
 *
 * `currency` defaults to 'usd', which is the value that was hardcoded here, so
 * every existing call site produces a byte-identical URL. The parameter exists
 * for the surfaces that need candles in the pool's own quote token — a
 * SOL-denominated chart of a SOL pair — where USD candles fold the quote's own
 * move into the token's.
 */
export function ohlcvUrl(market: ChartMarket, tf: Timeframe, currency: 'usd' | 'token' = 'usd'): string {
  const cfg = TF_CONFIG[tf];
  return `https://api.geckoterminal.com/api/v2/networks/${market.network}/pools/${market.pool}/ohlcv/${cfg.apiTf}?aggregate=${cfg.aggregate}&limit=${cfg.limit}&currency=${currency}`;
}

// ─── The read behind the lightweight-charts price chart ──────────────────────
//
// PERF-07/PERF-12 (2026-09-03). This used to live inside PriceChart.tsx as
// `fetchWithRetry` + `fetchOHLCV`, and it carried a policy that contradicted the
// one lib/chart/ohlcv.ts states in its own header:
//
//   * a 429 was RETRIED five times with escalating sleeps (1.6s, 3.2s, 4.8s,
//     6.4s). GeckoTerminal's keyless budget is per-client and shared with every
//     other surface in the tab — the market feed, the trades table, /chart —
//     so one chart could spend the whole tab's quota answering a refusal, and
//     the visitor waited ~16s to be told nothing. A refusal is reported here and
//     the reader gets the Retry button the component already renders;
//   * there was no deadline at all, so an upstream that accepted the connection
//     and never answered left the chart on "Loading chart..." forever — a
//     spinner with no end, which is the same lie as a fabricated zero told more
//     slowly;
//   * the cache evicted by CLEARING ITSELF once a ninth key arrived, so a
//     visitor cycling ten pools got a cold cache on every single switch and paid
//     a fresh read from that shared budget each time.
//
// The bars themselves are read by `readOhlcvBars`, which already owns this
// venue's rules about the data (status before schema, drop-never-repair, no
// forward fill). Two readers answering the same question with different
// answers is how a page ends up honest on one surface and not on another.

/**
 * Hard ceiling per request, matching GECKO_TIMEOUT_MS in geckoTerminal/pools.ts.
 * A caller's own signal still aborts sooner; this only bounds the wait.
 */
export const CHART_CANDLES_TIMEOUT_MS = 8_000;

/** How long a read stays reusable. Nothing polls; this only spares a re-switch. */
export const CHART_CANDLES_TTL_MS = 60_000;

/**
 * Entries kept. Eviction drops the OLDEST ONE, not the whole map: `Map` iterates
 * in insertion order, so `keys().next()` is the least recently inserted.
 */
export const CHART_CANDLES_CACHE_MAX = 8;

/** Adds the one failure the reader can produce that `readOhlcvBars` cannot. */
export type ChartCandlesReason = OhlcvUnreadReason | 'timeout';

export type ChartCandlesRead =
  | { ok: true; bars: OhlcvBar[] }
  | { ok: false; reason: ChartCandlesReason; detail: string };

interface CandleCacheEntry {
  bars: OhlcvBar[];
  storedAt: number;
}

const candleCache = new Map<string, CandleCacheEntry>();

/** Test seam. A module-level cache that survives between tests is a flake farm. */
export function __resetChartCandleCacheForTests(): void {
  candleCache.clear();
}

export interface ReadChartCandlesOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Overrides CHART_CANDLES_TIMEOUT_MS. Tests pass a small value; nothing else should. */
  timeoutMs?: number;
}

/**
 * One read for one (pool, timeframe). ONE fetch — no retry of any class.
 *
 * Never rejects for a read failure: every one comes back as a tagged reason so
 * the caller cannot mistake "refused" for "this pool has no candles". An abort
 * the CALLER asked for still rejects with AbortError, because that is the
 * caller's own decision and not a fact about the feed.
 */
export async function readChartCandles(
  market: ChartMarket,
  tf: Timeframe,
  opts: ReadChartCandlesOptions = {},
): Promise<ChartCandlesRead> {
  const clock = opts.now ?? Date.now;
  const key = ohlcvCacheKey(market, tf);
  const hit = candleCache.get(key);
  if (hit && clock() - hit.storedAt < CHART_CANDLES_TTL_MS) return { ok: true, bars: hit.bars };

  // The caller's signal and our own deadline both have to be able to abort the
  // request, so they are merged into one controller. `timedOut` tells the two
  // apart afterwards: an abort the READER caused is a fact the visitor should be
  // told, while an abort the CALLER caused (an unmounting chart, a newer
  // timeframe) is not a fact about the feed at all.
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, opts.timeoutMs ?? CHART_CANDLES_TIMEOUT_MS);
  const onCallerAbort = () => ac.abort();
  opts.signal?.addEventListener('abort', onCallerAbort);
  const done = () => {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onCallerAbort);
  };

  let read;
  try {
    read = await readOhlcvBars(ohlcvUrl(market, tf), opts.fetchImpl ?? fetch, ac.signal);
  } catch (err) {
    done();
    if (timedOut) {
      return {
        ok: false,
        reason: 'timeout',
        detail: 'The chart feed did not answer in time. That is a fact about the read, not about the market.',
      };
    }
    throw err;
  }
  done();

  if (!read.ok) return { ok: false, reason: read.reason, detail: read.detail };

  if (candleCache.size >= CHART_CANDLES_CACHE_MAX) {
    const oldest = candleCache.keys().next();
    if (!oldest.done) candleCache.delete(oldest.value);
  }
  candleCache.set(key, { bars: read.bars, storedAt: clock() });
  return { ok: true, bars: read.bars };
}
