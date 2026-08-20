import { describe, it, expect } from 'vitest';
import { bucketStart, buildCandleSeries, priceExtent, totalBuckets, type Slot } from './candles';

// The assertions that matter here are the NEGATIVE ones: what the builder
// refuses to produce. A candle where nothing traded, an open carried across a
// gap, a series that quietly shortens itself — each is a price the chart would
// state without anyone having paid it.

const HOUR = 3600;

/** t=0 is 1970-01-01T00:00:00Z, so every bucket below is epoch-aligned by hand. */
function trade(hourOffset: number, price: number, volume = 1) {
  return { timeSec: hourOffset * HOUR, price, volume };
}

describe('bucketStart', () => {
  it('floors to the enclosing bucket', () => {
    expect(bucketStart(3599, HOUR)).toBe(0);
    expect(bucketStart(3600, HOUR)).toBe(3600);
    expect(bucketStart(7199, HOUR)).toBe(3600);
  });
});

describe('buildCandleSeries — OHLC', () => {
  it('takes open from the first trade in the bucket and close from the last', () => {
    const series = buildCandleSeries(
      [
        { timeSec: 10, price: 5, volume: 1 },
        { timeSec: 20, price: 9, volume: 2 },
        { timeSec: 30, price: 3, volume: 4 },
        { timeSec: 40, price: 7, volume: 8 },
      ],
      HOUR,
      { truncated: false },
    );
    expect(series.slots).toHaveLength(1);
    const candle = series.slots[0];
    expect(candle.kind).toBe('candle');
    if (candle.kind !== 'candle') throw new Error('unreachable');
    expect(candle).toMatchObject({ open: 5, high: 9, low: 3, close: 7, volume: 15, trades: 4 });
    expect(candle.startSec).toBe(0);
    expect(candle.endSec).toBe(HOUR);
  });

  it('orders trades by time before reading open and close, whatever order they arrived in', () => {
    const series = buildCandleSeries(
      [
        { timeSec: 300, price: 2, volume: 1 },
        { timeSec: 100, price: 1, volume: 1 },
        { timeSec: 200, price: 3, volume: 1 },
      ],
      HOUR,
      { truncated: false },
    );
    const candle = series.slots[0];
    if (candle.kind !== 'candle') throw new Error('unreachable');
    expect(candle.open).toBe(1);
    expect(candle.close).toBe(2);
  });
});

describe('buildCandleSeries — gaps are gaps', () => {
  const series = buildCandleSeries([trade(0, 10), trade(4, 20)], HOUR, { truncated: false });

  it('puts a gap slot between the two candles instead of joining them', () => {
    expect(series.slots.map((s) => s.kind)).toEqual(['candle', 'gap', 'candle']);
  });

  it('gives the gap the true number of empty buckets', () => {
    const gap = series.slots[1];
    if (gap.kind !== 'gap') throw new Error('unreachable');
    expect(gap.buckets).toBe(3);
    expect(gap.startSec).toBe(HOUR);
    expect(gap.endSec).toBe(4 * HOUR);
    expect(series.emptyBuckets).toBe(3);
  });

  it('never invents a candle for an empty bucket', () => {
    // The forward-fill failure: three extra candles at price 10, one per empty
    // hour, each of them a price that nobody paid.
    const candles = series.slots.filter((s): s is Extract<Slot, { kind: 'candle' }> => s.kind === 'candle');
    expect(candles).toHaveLength(2);
    expect(series.candleCount).toBe(2);
    expect(candles.map((c) => c.startSec)).toEqual([0, 4 * HOUR]);
  });

  it('does not carry the previous close into the next candle as its open', () => {
    const second = series.slots[2];
    if (second.kind !== 'candle') throw new Error('unreachable');
    expect(second.open).toBe(20);
    expect(second.open).not.toBe(10);
  });

  it('keeps the time axis honest — gaps occupy their full width in bucket terms', () => {
    // Collapsing the gap would make this 2. Five is the number of buckets the
    // series actually spans, and it is what the renderer lays out against.
    expect(totalBuckets(series.slots)).toBe(5);
  });

  it('emits no gap when buckets are adjacent', () => {
    const dense = buildCandleSeries([trade(0, 1), trade(1, 2), trade(2, 3)], HOUR, { truncated: false });
    expect(dense.slots.map((s) => s.kind)).toEqual(['candle', 'candle', 'candle']);
    expect(dense.emptyBuckets).toBe(0);
  });
});

describe('buildCandleSeries — the cut edge of a truncated page', () => {
  it('drops the oldest bucket and says so', () => {
    const series = buildCandleSeries([trade(0, 10), trade(1, 20), trade(2, 30)], HOUR, { truncated: true });
    expect(series.droppedOldestBucket).toBe(true);
    expect(series.candleCount).toBe(2);
    expect(series.from).toBe(HOUR);
    const first = series.slots[0];
    if (first.kind !== 'candle') throw new Error('unreachable');
    // The dropped bucket's open was measured from a partial read. Keeping it
    // would have put an unmeasured open on the chart's left edge.
    expect(first.open).toBe(20);
  });

  it('keeps the oldest bucket when the page was complete', () => {
    const series = buildCandleSeries([trade(0, 10), trade(1, 20)], HOUR, { truncated: false });
    expect(series.droppedOldestBucket).toBe(false);
    expect(series.candleCount).toBe(2);
    expect(series.from).toBe(0);
  });

  it('yields an empty series rather than a one-candle one when the only bucket was cut', () => {
    const series = buildCandleSeries([trade(0, 10)], HOUR, { truncated: true });
    expect(series.slots).toEqual([]);
    expect(series.droppedOldestBucket).toBe(true);
    expect(series.from).toBeNull();
  });
});

describe('buildCandleSeries — unusable input is counted, never absorbed', () => {
  it('rejects non-positive and non-finite prices and reports the count', () => {
    const series = buildCandleSeries(
      [
        trade(0, 10),
        { timeSec: 60, price: 0, volume: 1 },
        { timeSec: 120, price: -4, volume: 1 },
        { timeSec: 180, price: Number.NaN, volume: 1 },
        { timeSec: 240, price: Number.POSITIVE_INFINITY, volume: 1 },
      ],
      HOUR,
      { truncated: false },
    );
    expect(series.rejected).toBe(4);
    expect(series.candleCount).toBe(1);
    const candle = series.slots[0];
    if (candle.kind !== 'candle') throw new Error('unreachable');
    expect(candle.high).toBe(10);
    expect(candle.low).toBe(10);
  });

  it('returns an explicitly empty series for no input at all', () => {
    const series = buildCandleSeries([], HOUR, { truncated: false });
    expect(series).toMatchObject({ slots: [], candleCount: 0, emptyBuckets: 0, from: null, to: null });
  });

  it('refuses a bucket size that is not a positive whole number of seconds', () => {
    expect(() => buildCandleSeries([trade(0, 1)], 0, { truncated: false })).toThrow(RangeError);
    expect(() => buildCandleSeries([trade(0, 1)], -60, { truncated: false })).toThrow(RangeError);
    expect(() => buildCandleSeries([trade(0, 1)], 1.5, { truncated: false })).toThrow(RangeError);
  });
});

describe('priceExtent', () => {
  it('reads highs and lows from candles only', () => {
    const series = buildCandleSeries([trade(0, 10), trade(4, 25)], HOUR, { truncated: false });
    expect(priceExtent(series.slots)).toEqual({ min: 10, max: 25 });
  });

  it('is null when there is no candle — a gap has no price to contribute', () => {
    expect(priceExtent([{ kind: 'gap', startSec: 0, endSec: HOUR, buckets: 1 }])).toBeNull();
    expect(priceExtent([])).toBeNull();
  });
});
