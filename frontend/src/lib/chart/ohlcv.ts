// THE ONE OHLCV READER for /chart. Pure: no React, no clock, injected fetch.
//
// GeckoTerminal answers with pre-aggregated buckets, one per timeframe step,
// and OMITS the buckets in which nothing traded. That omission is the whole
// reason this page can be honest: an absent bucket is a fact the source stated
// by leaving it out, and it becomes a hatched Gap column of true width through
// the SAME walk the indexed path uses (candles.ts `interleaveGaps`). Nothing
// here forward-fills, joins across empty time, or asks for
// `include_empty_intervals` — a synthetic bucket carrying the previous close is
// a price nobody paid.
//
// WHAT THIS FILE REFUSES TO DO:
//  - it never repairs a bar. A bar whose high sits below its close is
//    internally inconsistent, and clamping it (what PriceChart.tsx does for
//    lightweight-charts' benefit) invents an OHLC nobody sent. It is counted in
//    `rejected` and dropped, and the count is printed;
//  - it never turns a refused read into an empty series. Every failure is a
//    tagged reason, and the caller has nothing to draw in any of them;
//  - it never retries a 429. GeckoTerminal's keyless limit is shared by every
//    open island page, and hammering a refusal is how a rate limit becomes a
//    ban. The reader reports it and the reader is offered a manual retry;
//  - it never drops the oldest bucket. GeckoTerminal returns whole server-side
//    buckets, so the oldest one is complete — the candles.ts truncation rule is
//    for a swaps page cut mid-bucket and does not apply. A read that came back
//    at the limit records `capped`, which says older buckets MAY exist behind
//    the left edge, not that this one was cut.

import { z } from 'zod';
import { geckoTerminalOhlcvSchema, parseOrNull } from '../schemas/geckoTerminal';
import { interleaveGaps, type Candle, type CandleSeries } from './candles';
import type { ChartableMarket } from './markets';

export const GECKO_TIMEFRAME_IDS = ['5m', '15m', '1h', '4h', '1d'] as const;

export type GeckoTimeframeId = (typeof GECKO_TIMEFRAME_IDS)[number];

export interface GeckoTimeframe {
  id: GeckoTimeframeId;
  label: string;
  /** GeckoTerminal's own path segment. */
  apiTf: 'minute' | 'hour' | 'day';
  /** How many of those units one bucket spans, as GeckoTerminal aggregates it. */
  aggregate: number;
  /** The same span in seconds — the grid every bar must sit on. */
  bucketSeconds: number;
  /** Buckets asked for in one read. There is no paging: see `capped`. */
  limit: number;
}

/**
 * The frames offered, and why the set stops where it does.
 *
 * Each `bucketSeconds` is `aggregate` × the unit, and BOTH are load-bearing:
 * the first builds the URL, the second is the grid the returned timestamps are
 * checked against. They are written out rather than derived so a wrong pair is
 * a visible edit, and ohlcv.test.ts pins that they agree.
 */
export const GECKO_TIMEFRAMES: Record<GeckoTimeframeId, GeckoTimeframe> = {
  '5m': { id: '5m', label: '5M', apiTf: 'minute', aggregate: 5, bucketSeconds: 300, limit: 240 },
  '15m': { id: '15m', label: '15M', apiTf: 'minute', aggregate: 15, bucketSeconds: 900, limit: 240 },
  '1h': { id: '1h', label: '1H', apiTf: 'hour', aggregate: 1, bucketSeconds: 3600, limit: 240 },
  '4h': { id: '4h', label: '4H', apiTf: 'hour', aggregate: 4, bucketSeconds: 14400, limit: 240 },
  '1d': { id: '1d', label: '1D', apiTf: 'day', aggregate: 1, bucketSeconds: 86400, limit: 240 },
};

export const DEFAULT_GECKO_TIMEFRAME: GeckoTimeframeId = '1h';

export function isGeckoTimeframeId(value: unknown): value is GeckoTimeframeId {
  return typeof value === 'string' && (GECKO_TIMEFRAME_IDS as readonly string[]).includes(value);
}

/** GeckoTerminal's documented ceiling for `limit` on this endpoint. */
const MAX_LIMIT = 1000;

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';

/**
 * The URL for one (market, timeframe).
 *
 * Both path segments go through `encodeURIComponent` even though a registry
 * market can only hold a slug and a pool id. That is the point: the encoding is
 * the last line of a defence whose first line is that only registry markets and
 * strict-regex-matched addresses ever reach this function, and a defence with
 * one line is a defence that fails the first time the caller set changes. A
 * pool value shaped like `../../search` therefore cannot climb out of the path.
 *
 * `currency=usd` is fixed here. A native-quoted read is a different UNIT on the
 * volume field and no live read in this repo has established what that unit is,
 * so offering the toggle would put an unlabelled number on screen.
 * `before_timestamp` is absent because there is no paging, and
 * `include_empty_intervals` is absent DELIBERATELY — see the header.
 */
export function ohlcvUrlFor(
  market: Pick<ChartableMarket, 'network' | 'pool'>,
  tf: GeckoTimeframeId,
  // A caller asking a NARROWER question — the 24-bucket sparkline in
  // usePriceHistory reads one day, not the chart's ten — overrides the window
  // rather than getting its own URL builder. Clamped either way, so an override
  // can only ever ask for something the endpoint will serve.
  opts?: { limit?: number },
): string {
  const cfg = GECKO_TIMEFRAMES[tf];
  const requested = opts?.limit ?? cfg.limit;
  const limit = Math.min(Math.max(Math.floor(Number.isFinite(requested) ? requested : cfg.limit), 1), MAX_LIMIT);
  const net = encodeURIComponent(market.network);
  const pool = encodeURIComponent(market.pool);
  return `${GECKO_BASE}/networks/${net}/pools/${pool}/ohlcv/${cfg.apiTf}?aggregate=${cfg.aggregate}&limit=${limit}&currency=usd`;
}

/** One bucket exactly as the source reported it — nothing derived, nothing repaired. */
export interface OhlcvBar {
  /** Bucket start, unix seconds. */
  timeSec: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Base/quote identity, when the source volunteered it. Absent stays null. */
export interface OhlcvMeta {
  baseSymbol: string | null;
  quoteSymbol: string | null;
  baseAddress: string | null;
}

export type OhlcvUnreadReason =
  /** HTTP 429. The read was refused, not answered with nothing. */
  | 'rate-limited'
  /** HTTP 404. This SOURCE has no pool there — not a claim about the chain. */
  | 'not-found'
  /** Any other non-2xx. */
  | 'http'
  /** 2xx whose body does not match the envelope this page validates. */
  | 'off-schema'
  /** The request never completed: DNS, CORS, offline, blocked. */
  | 'network';

export type OhlcvRead =
  | {
      ok: true;
      bars: OhlcvBar[];
      meta: OhlcvMeta;
      httpStatus: number;
      /** Bars sharing a timestamp with a later one; the later bar was kept. */
      duplicates: number;
      /** Bars that failed this file's own sanity check. Dropped, never repaired. */
      rejected: number;
    }
  | { ok: false; reason: OhlcvUnreadReason; httpStatus: number | null; detail: string };

/**
 * The `meta` block, parsed on its own.
 *
 * It is read with a LOCAL schema rather than by extending the shared R080
 * envelope because the shared schema is owned elsewhere and the symbols are not
 * load-bearing: every field here degrades to null, and the axis then says
 * "quote token (unnamed upstream)" instead of assuming WETH or SOL. The bars —
 * the part that is load-bearing — go through the shared envelope below, so the
 * one thing that reaches the plot is validated by the one schema the repo pins.
 */
const ohlcvMetaSchema = z.object({
  meta: z
    .object({
      base: z
        .object({ symbol: z.string().nullish(), address: z.string().nullish() })
        .partial()
        .nullish(),
      quote: z
        .object({ symbol: z.string().nullish(), address: z.string().nullish() })
        .partial()
        .nullish(),
    })
    .partial()
    .nullish(),
});

const EMPTY_META: OhlcvMeta = { baseSymbol: null, quoteSymbol: null, baseAddress: null };

function readMeta(raw: unknown): OhlcvMeta {
  const parsed = ohlcvMetaSchema.safeParse(raw);
  if (!parsed.success) return EMPTY_META;
  const m = parsed.data.meta;
  return {
    baseSymbol: m?.base?.symbol ?? null,
    quoteSymbol: m?.quote?.symbol ?? null,
    baseAddress: m?.base?.address ?? null,
  };
}

/**
 * Is this bar internally consistent?
 *
 * A price of zero or below is not a cheap token, it is a broken row: the axis is
 * logarithmic in spirit and a zero would flatten every real price against it.
 * The high/low ordering checks catch the shape that the retry-and-clamp reader
 * silently repairs — if high < close then one of the two numbers is wrong and
 * there is no way to tell which, so the bar is dropped and counted rather than
 * bent into a shape that draws.
 */
function isSaneBar(b: OhlcvBar): boolean {
  const prices = [b.open, b.high, b.low, b.close];
  if (!Number.isFinite(b.timeSec) || b.timeSec < 0) return false;
  if (!prices.every((p) => Number.isFinite(p) && p > 0)) return false;
  if (b.high < Math.max(b.open, b.close, b.low)) return false;
  if (b.low > Math.min(b.open, b.close, b.high)) return false;
  if (!Number.isFinite(b.volume) || b.volume < 0) return false;
  return true;
}

/**
 * One read. One fetch. No retry, no cache, no clock — the hook owns all three.
 *
 * `fetchFn` is injected so the tests exercise this function rather than the
 * environment's networking, and so a caller can never accidentally reach a
 * different host than the one `ohlcvUrlFor` built.
 */
export async function readOhlcvBars(
  url: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<OhlcvRead> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) });
  } catch (err) {
    // An abort is the caller's own decision and is re-thrown so the hook can
    // ignore it; anything else is a read that did not happen.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return { ok: false, reason: 'network', httpStatus: null, detail: 'The request did not complete.' };
  }

  // STATUS BEFORE SCHEMA. A 429 body is `{"status":{"error_code":429,…}}` with
  // no `data` key: parsed first it would read as off-schema, and a reader who
  // treated an off-schema answer as "nothing came back" would draw a refusal as
  // an empty market. The code is checked before the body is even read.
  if (res.status === 429) {
    return { ok: false, reason: 'rate-limited', httpStatus: 429, detail: 'The read was refused.' };
  }
  if (res.status === 404) {
    return { ok: false, reason: 'not-found', httpStatus: 404, detail: 'The source has no pool at this address.' };
  }
  if (!res.ok) {
    return { ok: false, reason: 'http', httpStatus: res.status, detail: `HTTP ${res.status}.` };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: 'off-schema', httpStatus: res.status, detail: 'The body was not JSON.' };
  }

  const parsed = parseOrNull(geckoTerminalOhlcvSchema, json);
  if (!parsed) {
    return { ok: false, reason: 'off-schema', httpStatus: res.status, detail: 'The body did not match the OHLCV envelope.' };
  }

  let rejected = 0;
  const sane: OhlcvBar[] = [];
  for (const row of parsed.data.attributes.ohlcv_list) {
    const bar: OhlcvBar = {
      timeSec: Math.floor(row[0]),
      open: row[1],
      high: row[2],
      low: row[3],
      close: row[4],
      volume: row[5],
    };
    if (isSaneBar(bar)) sane.push(bar);
    else rejected += 1;
  }

  // GeckoTerminal answers newest-first. Sorted ascending here so every consumer
  // downstream can assume chronological order; the sort is stable, so bars that
  // tie on a timestamp keep the order the source sent them in and "keep the
  // last" below has a defined meaning.
  sane.sort((a, b) => a.timeSec - b.timeSec);

  let duplicates = 0;
  const bars: OhlcvBar[] = [];
  for (const bar of sane) {
    const last = bars[bars.length - 1];
    if (last && last.timeSec === bar.timeSec) {
      // Later wins: two rows for one bucket means the aggregator restated it,
      // and the restatement is the one it stands behind.
      bars[bars.length - 1] = bar;
      duplicates += 1;
      continue;
    }
    bars.push(bar);
  }

  return { ok: true, bars, meta: readMeta(json), httpStatus: res.status, duplicates, rejected };
}

/**
 * A GeckoTerminal series, and the four things a reader needs to bound it.
 *
 * `capped` is NOT `droppedOldestBucket` wearing a different hat. Dropping says
 * "this bucket was cut and removed"; capping says "the read stopped at N and
 * older buckets may exist behind the left edge". Only the second is ever true
 * here, and conflating them would let the page claim a pool started trading
 * where the read happened to stop.
 */
export type GeckoSeries = CandleSeries & {
  /** Buckets the source returned with a price and a reported volume of zero. */
  zeroVolumeBars: number;
  duplicates: number;
  /** The newest kept bar's OWN timestamp. The as-of, never this page's clock. */
  newestStartSec: number | null;
  capped: boolean;
};

export interface BarsToSeriesOptions {
  /** The read came back at the limit — see `capped`. */
  capped: boolean;
  duplicates: number;
  rejected: number;
}

export type BarsToSeriesResult =
  | { ok: true; series: GeckoSeries }
  | { ok: false; reason: 'off-grid'; detail: string };

/**
 * Bars → the same slot series the indexed path draws.
 *
 * THE GRID CHECK RUNS FIRST and is strict: every bar must satisfy
 * `timeSec % bucketSeconds === 0`. The gap walk divides a time difference by
 * `bucketSeconds` (candles.ts) and the layout sums bucket counts into column
 * widths (geometry.ts); a bar half a bucket out of phase produces a fractional
 * gap width and bends the time axis by an amount nothing on screen discloses. A
 * bent axis is a chart lying about WHEN, which is worse than no chart, so the
 * whole read is refused with its own sentence instead.
 */
export function barsToSeries(
  bars: readonly OhlcvBar[],
  bucketSeconds: number,
  opts: BarsToSeriesOptions,
): BarsToSeriesResult {
  if (!Number.isFinite(bucketSeconds) || bucketSeconds <= 0 || Math.floor(bucketSeconds) !== bucketSeconds) {
    throw new RangeError('bucketSeconds must be a positive whole number of seconds');
  }

  for (const bar of bars) {
    if (bar.timeSec % bucketSeconds !== 0) {
      return {
        ok: false,
        reason: 'off-grid',
        detail: `A bucket opened at ${bar.timeSec}, which is not a multiple of ${bucketSeconds} seconds.`,
      };
    }
  }

  let zeroVolumeBars = 0;
  const candles: Candle[] = bars.map((bar) => {
    // A returned bucket with zero reported volume STAYS A CANDLE. The source
    // gave four prices for it; that it also reported no volume is a known
    // upstream shape, not a statement that nothing traded. Reclassifying it as
    // a gap would delete a price the source did in fact publish, so it is
    // drawn and counted, and the counter is what the banner reports.
    if (bar.volume === 0) zeroVolumeBars += 1;
    return {
      kind: 'candle',
      startSec: bar.timeSec,
      endSec: bar.timeSec + bucketSeconds,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      // The source reports no trade count for a bucket. Null, never 0.
      trades: null,
    };
  });

  const walked = interleaveGaps(candles, bucketSeconds);
  const newest = candles[candles.length - 1];

  return {
    ok: true,
    series: {
      slots: walked.slots,
      candleCount: candles.length,
      emptyBuckets: walked.emptyBuckets,
      // Always false: whole server-side buckets, so nothing was cut. See header.
      droppedOldestBucket: false,
      rejected: opts.rejected,
      // No same-block ordering question exists for a pre-aggregated bucket.
      unsequenced: 0,
      from: walked.from,
      to: walked.to,
      zeroVolumeBars,
      duplicates: opts.duplicates,
      newestStartSec: newest ? newest.startSec : null,
      capped: opts.capped,
    },
  };
}
