// Trades → candles. Pure: no React, no network, no clock.
//
// THE RULE THIS FILE EXISTS FOR: a bucket with no trades in it is a GAP, and a
// gap is drawn as a gap. Not forward-filled from the previous close, not closed
// over by joining neighbouring candles, not collapsed so the axis skips the
// empty time. Every one of those three is the same lie in different clothing —
// an invented candle is a price that never traded, and on a thin venue token
// most buckets are empty, so the lie would be the majority of the chart.
//
// The second rule is about the EDGE of the read window rather than its middle.
// The indexer answers one page, newest-first, capped at MAX_PAGE_LIMIT. When
// that page is truncated the oldest bucket in it is cut through: some of its
// trades were never read, so its open (and possibly its high or low) would be
// wrong. A wrong open is not a smaller truth, it is a fabricated one, so the
// oldest bucket is DROPPED and the drop is reported. Nothing about the time
// before the window is a gap either — it is unread, which the caller states
// separately.

/** One priced trade. `price` is quote-per-base, already decimal-scaled. */
export interface Trade {
  /** Unix seconds. */
  timeSec: number;
  price: number;
  /** Base-token amount that changed hands, decimal-scaled. */
  volume: number;
}

export interface Candle {
  kind: 'candle';
  /** Bucket start, unix seconds, aligned to a multiple of `bucketSeconds`. */
  startSec: number;
  /** Exclusive end. */
  endSec: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
}

/**
 * A run of consecutive empty buckets.
 *
 * It carries `buckets` so the renderer can give it width proportional to the
 * time it covers. A gap rendered one column wide regardless of length is a time
 * axis that lies at a different scale in different places.
 */
export interface Gap {
  kind: 'gap';
  startSec: number;
  endSec: number;
  buckets: number;
}

export type Slot = Candle | Gap;

export interface CandleSeries {
  /** Chronological, oldest first. Candles and gaps interleaved, never merged. */
  slots: Slot[];
  candleCount: number;
  /** Empty buckets inside the covered span. Drawn, never filled. */
  emptyBuckets: number;
  /**
   * The oldest bucket was cut by the read window and removed rather than shown
   * with an open nobody measured.
   */
  droppedOldestBucket: boolean;
  /**
   * Inputs that were not usable as trades (non-finite or non-positive price,
   * non-finite timestamp). Counted, never quietly skipped — a silently shorter
   * series is a fabricated one seen from the other side.
   */
  rejected: number;
  /** Covered span, or null when nothing survived. */
  from: number | null;
  to: number | null;
}

/** Epoch-aligned bucket start containing `timeSec`. */
export function bucketStart(timeSec: number, bucketSeconds: number): number {
  return Math.floor(timeSec / bucketSeconds) * bucketSeconds;
}

function isUsable(t: Trade): boolean {
  return (
    Number.isFinite(t.timeSec) &&
    t.timeSec >= 0 &&
    Number.isFinite(t.price) &&
    t.price > 0 &&
    Number.isFinite(t.volume) &&
    t.volume >= 0
  );
}

export interface BuildCandleSeriesOptions {
  /**
   * The trade page had more rows behind it. Drops the oldest bucket, because
   * the unread rows belong inside it.
   */
  truncated: boolean;
}

export function buildCandleSeries(
  trades: readonly Trade[],
  bucketSeconds: number,
  opts: BuildCandleSeriesOptions,
): CandleSeries {
  if (!Number.isFinite(bucketSeconds) || bucketSeconds <= 0 || Math.floor(bucketSeconds) !== bucketSeconds) {
    throw new RangeError('bucketSeconds must be a positive whole number of seconds');
  }

  const usable: Trade[] = [];
  let rejected = 0;
  for (const t of trades) {
    if (isUsable(t)) usable.push(t);
    else rejected += 1;
  }

  if (usable.length === 0) {
    return {
      slots: [],
      candleCount: 0,
      emptyBuckets: 0,
      droppedOldestBucket: false,
      rejected,
      from: null,
      to: null,
    };
  }

  // Ascending by time. The sort must be stable on ties so that two trades in the
  // same block (identical timestamps) keep the order the indexer returned them
  // in — otherwise open and close could swap between renders of the same data.
  const sorted = [...usable].sort((a, b) => a.timeSec - b.timeSec);

  const byBucket = new Map<number, Candle>();
  for (const t of sorted) {
    const start = bucketStart(t.timeSec, bucketSeconds);
    const existing = byBucket.get(start);
    if (!existing) {
      byBucket.set(start, {
        kind: 'candle',
        startSec: start,
        endSec: start + bucketSeconds,
        open: t.price,
        high: t.price,
        low: t.price,
        close: t.price,
        volume: t.volume,
        trades: 1,
      });
      continue;
    }
    // `open` is the first trade IN THIS BUCKET, never the previous bucket's
    // close. Carrying a close forward across a gap would put a price on a
    // bucket where nothing traded, which is the whole thing this module refuses.
    if (t.price > existing.high) existing.high = t.price;
    if (t.price < existing.low) existing.low = t.price;
    existing.close = t.price;
    existing.volume += t.volume;
    existing.trades += 1;
  }

  const starts = [...byBucket.keys()].sort((a, b) => a - b);

  let droppedOldestBucket = false;
  if (opts.truncated && starts.length > 0) {
    byBucket.delete(starts[0]);
    starts.shift();
    droppedOldestBucket = true;
  }

  if (starts.length === 0) {
    return {
      slots: [],
      candleCount: 0,
      emptyBuckets: 0,
      droppedOldestBucket,
      rejected,
      from: null,
      to: null,
    };
  }

  const slots: Slot[] = [];
  let emptyBuckets = 0;
  for (let i = 0; i < starts.length; i += 1) {
    if (i > 0) {
      const prevEnd = starts[i - 1] + bucketSeconds;
      const missing = (starts[i] - prevEnd) / bucketSeconds;
      if (missing > 0) {
        emptyBuckets += missing;
        slots.push({ kind: 'gap', startSec: prevEnd, endSec: starts[i], buckets: missing });
      }
    }
    slots.push(byBucket.get(starts[i])!);
  }

  return {
    slots,
    candleCount: starts.length,
    emptyBuckets,
    droppedOldestBucket,
    rejected,
    from: starts[0],
    to: starts[starts.length - 1] + bucketSeconds,
  };
}

/** Candles only — the price extent has nothing to say about empty buckets. */
export function priceExtent(slots: readonly Slot[]): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const s of slots) {
    if (s.kind !== 'candle') continue;
    if (s.low < min) min = s.low;
    if (s.high > max) max = s.high;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

/** Total buckets a series occupies on the time axis, gaps included at full width. */
export function totalBuckets(slots: readonly Slot[]): number {
  let n = 0;
  for (const s of slots) n += s.kind === 'candle' ? 1 : s.buckets;
  return n;
}
