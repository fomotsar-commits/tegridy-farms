import { describe, it, expect } from 'vitest';
import { buildCandleSeries, type Slot } from './candles';
import {
  DEFAULT_VIEWPORT,
  buildLayout,
  formatAxisPrice,
  plotArea,
  priceBand,
  priceTicks,
} from './geometry';

const HOUR = 3600;

function trade(hourOffset: number, price: number, volume = 1) {
  return { timeSec: hourOffset * HOUR, price, volume };
}

describe('priceBand', () => {
  it('pads a real range symmetrically so candles do not touch the frame', () => {
    const band = priceBand(buildCandleSeries([trade(0, 100), trade(1, 200)], HOUR, { truncated: false }).slots)!;
    expect(band.min).toBeLessThan(100);
    expect(band.max).toBeGreaterThan(200);
    expect(100 - band.min).toBeCloseTo(band.max - 200, 10);
  });

  it('survives a series where every trade printed at one price', () => {
    // The degenerate domain: max === min divides by zero if it reaches a scale
    // untouched, and the chart blanks. A flat market and an absent one are
    // different facts and must not render identically.
    const band = priceBand(buildCandleSeries([trade(0, 42), trade(1, 42)], HOUR, { truncated: false }).slots)!;
    expect(band.max).toBeGreaterThan(band.min);
    expect((band.min + band.max) / 2).toBeCloseTo(42, 10);
  });

  it('is null when nothing traded', () => {
    expect(priceBand([])).toBeNull();
  });
});

describe('buildLayout — the time axis is linear in time', () => {
  const series = buildCandleSeries([trade(0, 10), trade(4, 20)], HOUR, { truncated: false });
  const layout = buildLayout(series.slots)!;
  const area = plotArea(DEFAULT_VIEWPORT);

  it('lays out five columns for a five-bucket span, not two for two candles', () => {
    expect(layout.columnWidth).toBeCloseTo(area.width / 5, 10);
  });

  it('gives the gap the width of the three buckets it covers', () => {
    const gap = layout.boxes.find((b) => b.kind === 'gap');
    expect(gap).toBeTruthy();
    if (!gap || gap.kind !== 'gap') throw new Error('unreachable');
    expect(gap.width).toBeCloseTo(layout.columnWidth * 3, 10);
  });

  it('places the second candle after the gap, not adjacent to the first', () => {
    const candles = layout.boxes.filter((b) => b.kind === 'candle');
    expect(candles).toHaveLength(2);
    if (candles[0].kind !== 'candle' || candles[1].kind !== 'candle') throw new Error('unreachable');
    // Four columns of separation. One column would mean the empty time was
    // deleted from the axis, which draws a continuous market that never existed.
    expect(candles[1].x - candles[0].x).toBeCloseTo(layout.columnWidth * 4, 10);
  });

  it('keeps every box inside the plot area', () => {
    for (const box of layout.boxes) {
      const right = box.kind === 'gap' ? box.x + box.width : box.x + box.columnWidth;
      expect(box.x).toBeGreaterThanOrEqual(area.x - 1e-9);
      expect(right).toBeLessThanOrEqual(area.x + area.width + 1e-9);
    }
  });
});

describe('buildLayout — candle geometry', () => {
  it('puts a higher close above a lower open (y grows downward in SVG)', () => {
    const series = buildCandleSeries(
      [
        { timeSec: 0, price: 10, volume: 1 },
        { timeSec: 60, price: 20, volume: 1 },
      ],
      HOUR,
      { truncated: false },
    );
    const box = buildLayout(series.slots)!.boxes[0];
    if (box.kind !== 'candle') throw new Error('unreachable');
    expect(box.direction).toBe('up');
    expect(box.wickTop).toBeLessThan(box.wickBottom);
  });

  it('gives a doji a visible body so it does not read as an empty bucket', () => {
    const series = buildCandleSeries([trade(0, 5), trade(2, 5)], HOUR, { truncated: false });
    for (const box of buildLayout(series.slots)!.boxes) {
      if (box.kind !== 'candle') continue;
      expect(box.direction).toBe('flat');
      expect(box.bodyHeight).toBeGreaterThanOrEqual(1);
    }
  });

  it('centres the wick in its column and insets the body', () => {
    const series = buildCandleSeries([trade(0, 10), trade(1, 12)], HOUR, { truncated: false });
    const layout = buildLayout(series.slots)!;
    for (const box of layout.boxes) {
      if (box.kind !== 'candle') continue;
      expect(box.wickX).toBeCloseTo(box.x + box.columnWidth / 2, 10);
      expect(box.bodyX).toBeGreaterThanOrEqual(box.x);
      expect(box.bodyX + box.bodyWidth).toBeLessThanOrEqual(box.x + box.columnWidth + 1e-9);
    }
  });

  it('is null when there is nothing to draw, rather than an empty axis', () => {
    expect(buildLayout([])).toBeNull();
    const onlyGap: Slot[] = [{ kind: 'gap', startSec: 0, endSec: HOUR, buckets: 1 }];
    expect(buildLayout(onlyGap)).toBeNull();
  });
});

describe('priceTicks', () => {
  it('spans the band and maps through the same scale the candles use', () => {
    const series = buildCandleSeries([trade(0, 10), trade(1, 30)], HOUR, { truncated: false });
    const layout = buildLayout(series.slots)!;
    const ticks = priceTicks(layout, 4);
    expect(ticks).toHaveLength(5);
    expect(ticks[0].price).toBeCloseTo(layout.band.min, 10);
    expect(ticks[4].price).toBeCloseTo(layout.band.max, 10);
    for (const tick of ticks) expect(tick.y).toBeCloseTo(layout.yOf(tick.price), 10);
  });
});

describe('formatAxisPrice', () => {
  it('keeps a sub-cent token distinguishable instead of printing five identical zeros', () => {
    const labels = [0.00004052, 0.00004061, 0.00004073].map(formatAxisPrice);
    expect(new Set(labels).size).toBe(3);
  });

  it('falls back to exponent notation below what fixed notation can show', () => {
    expect(formatAxisPrice(1.2e-11)).toBe('1.20e-11');
  });

  it('says so rather than printing NaN', () => {
    expect(formatAxisPrice(Number.NaN)).toBe('—');
  });
});
