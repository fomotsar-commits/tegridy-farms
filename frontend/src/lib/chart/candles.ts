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
//
// The third rule is about ORDER WITHIN a bucket. Open and close are the only
// two OHLC values that depend on the order trades are read in (high and low do
// not), and a block timestamp is shared by every swap in that block — so the
// order of same-block trades, not the clock, decides which way the candle
// closed. See `Trade.sequence`.

/** One priced trade. `price` is quote-per-base, already decimal-scaled. */
export interface Trade {
  /** Unix seconds. */
  timeSec: number;
  price: number;
  /** Base-token amount that changed hands, decimal-scaled. */
  volume: number;
  /**
   * Position of this swap's log inside its block, when it could be established.
   *
   * A block timestamp is the ONLY clock the indexer stores, and every swap in a
   * block shares it. Two swaps in one block therefore tie on `timeSec`, and a
   * tie decides which price is the bucket's open and which is its close — a
   * sandwich prints both legs in one block, so the tie is exactly where the
   * candle's direction is decided. Ordering it by anything other than execution
   * order produces a candle that closed the opposite way from the market.
   *
   * `undefined` means the log position could not be read. The builder then
   * leaves those trades in the order the caller supplied and counts them in
   * `unsequenced`, rather than picking an order and presenting it as measured.
   */
  sequence?: number;
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
  /**
   * How many trades landed in this bucket, or null when the SOURCE does not
   * report a count.
   *
   * Null is not zero and must never be rendered as one. The indexer path counts
   * swaps it read one by one, so it writes a number. GeckoTerminal answers with
   * a pre-aggregated bucket and no trade count at all — writing 0 there would
   * turn "nobody told us" into "nothing traded", which is the exact substitution
   * this whole module exists to refuse. Renderers omit the clause on null.
   */
  trades: number | null;
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
  /**
   * Trades whose position within their block could not be established.
   *
   * Non-zero means some bucket's open and close may be the wrong way round: see
   * `Trade.sequence`. It is all-or-nothing in practice — the log position comes
   * from a field every indexed row carries — so a non-zero count here is a
   * signal that the indexer's row shape changed, not a per-trade quirk.
   */
  unsequenced: number;
  /** Covered span, or null when nothing survived. */
  from: number | null;
  to: number | null;
}

/** Epoch-aligned bucket start containing `timeSec`. */
export function bucketStart(timeSec: number, bucketSeconds: number): number {
  return Math.floor(timeSec / bucketSeconds) * bucketSeconds;
}

/** What the gap walk produced: the interleaved slots plus the span they cover. */
export interface InterleavedSlots {
  slots: Slot[];
  emptyBuckets: number;
  from: number | null;
  to: number | null;
}

/**
 * Chronological candles → candles with a Gap slot wherever a bucket is missing.
 *
 * Extracted from `buildCandleSeries` so the GeckoTerminal reader
 * (lib/chart/ohlcv.ts) can reach the identical walk instead of copying it. THE
 * GAP RULE IS THE PRODUCT, and a copied gap rule is a gap rule that drifts:
 * whichever copy was not updated would start joining candles across empty time
 * on one of the two sources, and the two would look the same on screen.
 *
 * The input must already be sorted ascending and deduplicated by bucket start;
 * both callers do that with their own source's ordering rules, which differ
 * (block sequence for indexed swaps, timestamp only for server-side buckets).
 */
export function interleaveGaps(ordered: readonly Candle[], bucketSeconds: number): InterleavedSlots {
  const oldest = ordered[0];
  if (oldest === undefined) return { slots: [], emptyBuckets: 0, from: null, to: null };

  const slots: Slot[] = [oldest];
  let emptyBuckets = 0;
  // Also the running end of the series: every branch below advances it to the
  // candle it just pushed, so `to` is the last candle's own end rather than an
  // end recomputed from an index.
  let prevEndSec = oldest.endSec;
  for (const candle of ordered.slice(1)) {
    const missing = (candle.startSec - prevEndSec) / bucketSeconds;
    if (missing > 0) {
      emptyBuckets += missing;
      slots.push({ kind: 'gap', startSec: prevEndSec, endSec: candle.startSec, buckets: missing });
    }
    slots.push(candle);
    prevEndSec = candle.endSec;
  }

  return { slots, emptyBuckets, from: oldest.startSec, to: prevEndSec };
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
  let unsequenced = 0;
  for (const t of trades) {
    if (!isUsable(t)) {
      rejected += 1;
      continue;
    }
    usable.push(t);
    if (!Number.isFinite(t.sequence)) unsequenced += 1;
  }

  if (usable.length === 0) {
    return {
      slots: [],
      candleCount: 0,
      emptyBuckets: 0,
      droppedOldestBucket: false,
      rejected,
      unsequenced,
      from: null,
      to: null,
    };
  }

  // Ascending by block time, then by position within the block.
  //
  // The second key is the load-bearing one. Sorting on `timeSec` alone leaves
  // every same-block trade tied, and a stable sort then freezes whatever order
  // the caller happened to pass — which for a newest-first indexer page is
  // backwards, making the bucket's open its LAST trade and its close its first.
  // The candle would be drawn closing the opposite way from the block it
  // describes. Where `sequence` is absent on either side the comparator returns
  // 0, so the caller's order stands and `unsequenced` says so.
  const sorted = [...usable].sort((a, b) => {
    if (a.timeSec !== b.timeSec) return a.timeSec - b.timeSec;
    if (!Number.isFinite(a.sequence) || !Number.isFinite(b.sequence)) return 0;
    return (a.sequence as number) - (b.sequence as number);
  });

  // The value type narrows `trades` back to a plain number: on THIS path every
  // trade was read individually, so the count is measured rather than absent,
  // and `+= 1` below stays arithmetic on a number instead of on `number | null`.
  const byBucket = new Map<number, Candle & { trades: number }>();
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

  // The candles themselves, chronological — not their keys. Walking the values
  // means every slot pushed below is a candle that demonstrably exists, rather
  // than a key looked back up in the map and assumed to still be there.
  const ordered = [...byBucket.values()].sort((a, b) => a.startSec - b.startSec);

  // `shift()` on an empty list removes nothing and reports it by returning
  // undefined, so a truncated page that yielded no buckets drops nothing and
  // says so — the flag follows what was actually removed.
  const droppedOldestBucket = opts.truncated ? ordered.shift() !== undefined : false;

  const oldest = ordered[0];
  if (oldest === undefined) {
    return {
      slots: [],
      candleCount: 0,
      emptyBuckets: 0,
      droppedOldestBucket,
      rejected,
      unsequenced,
      from: null,
      to: null,
    };
  }

  const walked = interleaveGaps(ordered, bucketSeconds);

  return {
    slots: walked.slots,
    candleCount: ordered.length,
    emptyBuckets: walked.emptyBuckets,
    droppedOldestBucket,
    rejected,
    unsequenced,
    from: walked.from,
    to: walked.to,
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
