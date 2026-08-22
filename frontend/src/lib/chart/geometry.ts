// Slots → SVG coordinates. Pure, and the only place the chart does arithmetic
// on pixels. Same shape as the nakamigos DepthChart: a dependency-free renderer
// whose maths is unit-tested away from the DOM, so a layout change cannot move
// a candle without a test noticing.
//
// The load-bearing property is that the x axis is LINEAR IN TIME. Every column
// is one bucket wide, and a gap of nine empty buckets occupies nine columns.
// Packing candles shoulder-to-shoulder and dropping the empty time is the most
// common way a chart flatters a thin market: it turns four trades spread over a
// week into what looks like a continuous session.

import type { Slot } from './candles';
import { priceExtent, totalBuckets } from './candles';

export interface Viewport {
  width: number;
  height: number;
  padding: { top: number; right: number; bottom: number; left: number };
}

/** Price axis on the right, the convention every trading UI already teaches. */
export const DEFAULT_VIEWPORT: Viewport = {
  width: 720,
  height: 320,
  padding: { top: 14, right: 62, bottom: 26, left: 10 },
};

export function plotArea(v: Viewport): { x: number; y: number; width: number; height: number } {
  return {
    x: v.padding.left,
    y: v.padding.top,
    width: Math.max(v.width - v.padding.left - v.padding.right, 0),
    height: Math.max(v.height - v.padding.top - v.padding.bottom, 0),
  };
}

/**
 * The drawn price band.
 *
 * A series whose every trade printed at the same price has zero extent, which
 * would divide by zero and blank the chart (the degenerate case bookDepth.js
 * hit from the other direction). It is padded symmetrically instead, so a
 * genuinely flat market renders as a flat line rather than as nothing — those
 * are different facts and must not look alike.
 */
export function priceBand(slots: readonly Slot[]): { min: number; max: number } | null {
  const extent = priceExtent(slots);
  if (!extent) return null;
  if (extent.max > extent.min) {
    const headroom = (extent.max - extent.min) * 0.08;
    return { min: extent.min - headroom, max: extent.max + headroom };
  }
  const pad = extent.max > 0 ? extent.max * 0.05 : 1;
  return { min: extent.max - pad, max: extent.max + pad };
}

export interface CandleBox {
  kind: 'candle';
  slot: Extract<Slot, { kind: 'candle' }>;
  /** Left edge of the bucket's column. */
  x: number;
  /** Column width — always exactly one bucket. */
  columnWidth: number;
  /** Body rect, inset from the column so neighbours stay separable. */
  bodyX: number;
  bodyWidth: number;
  bodyY: number;
  bodyHeight: number;
  /** Wick x is the column centre. */
  wickX: number;
  wickTop: number;
  wickBottom: number;
  direction: 'up' | 'down' | 'flat';
}

export interface GapBox {
  kind: 'gap';
  slot: Extract<Slot, { kind: 'gap' }>;
  x: number;
  width: number;
}

export type SlotBox = CandleBox | GapBox;

export interface ChartLayout {
  boxes: SlotBox[];
  band: { min: number; max: number };
  columnWidth: number;
  area: { x: number; y: number; width: number; height: number };
  /** price → y. Exposed so axis ticks and overlays use the same mapping. */
  yOf: (price: number) => number;
}

/**
 * Null when there is nothing to draw.
 *
 * Deliberately not an empty layout: an empty axis with gridlines and no candles
 * looks like a market that traded nothing, and the caller has to be forced to
 * choose its own words for why the chart is absent.
 */
export function buildLayout(slots: readonly Slot[], viewport: Viewport = DEFAULT_VIEWPORT): ChartLayout | null {
  const band = priceBand(slots);
  if (!band) return null;

  const area = plotArea(viewport);
  const columns = totalBuckets(slots);
  if (columns <= 0 || area.width <= 0 || area.height <= 0) return null;

  const columnWidth = area.width / columns;
  const span = band.max - band.min;
  const yOf = (price: number) => area.y + area.height - ((price - band.min) / span) * area.height;

  // A body thinner than a hairline is invisible at any zoom; a body wider than
  // 60% of its column touches its neighbour. Both bounds are cosmetic, but the
  // inset is what keeps two adjacent candles readable as two.
  const bodyWidth = Math.max(Math.min(columnWidth * 0.6, 14), 1);

  const boxes: SlotBox[] = [];
  let column = 0;
  for (const slot of slots) {
    const x = area.x + column * columnWidth;
    if (slot.kind === 'gap') {
      boxes.push({ kind: 'gap', slot, x, width: columnWidth * slot.buckets });
      column += slot.buckets;
      continue;
    }

    const openY = yOf(slot.open);
    const closeY = yOf(slot.close);
    const top = Math.min(openY, closeY);
    const height = Math.abs(closeY - openY);
    boxes.push({
      kind: 'candle',
      slot,
      x,
      columnWidth,
      bodyX: x + (columnWidth - bodyWidth) / 2,
      bodyWidth,
      bodyY: top,
      // A doji (open === close) has zero body height and would vanish. One
      // pixel of body is the mark for "it traded and closed where it opened",
      // which is a real outcome and must not render identically to an empty
      // bucket sitting next to it.
      bodyHeight: Math.max(height, 1),
      wickX: x + columnWidth / 2,
      wickTop: yOf(slot.high),
      wickBottom: yOf(slot.low),
      direction: slot.close > slot.open ? 'up' : slot.close < slot.open ? 'down' : 'flat',
    });
    column += 1;
  }

  return { boxes, band, columnWidth, area, yOf };
}

export interface PriceTick {
  price: number;
  y: number;
}

export function priceTicks(layout: ChartLayout, count = 4): PriceTick[] {
  const ticks: PriceTick[] = [];
  const step = (layout.band.max - layout.band.min) / count;
  for (let i = 0; i <= count; i += 1) {
    const price = layout.band.min + i * step;
    ticks.push({ price, y: layout.yOf(price) });
  }
  return ticks;
}

/**
 * Axis labels for a price scale that can span 1e-9 to 1e4 on the same venue.
 *
 * `toFixed(4)` on a 0.00000004 token prints five identical "0.0000" labels,
 * which is an axis that says nothing while looking like it says something.
 */
export function formatAxisPrice(price: number): string {
  if (!Number.isFinite(price)) return '—';
  const magnitude = Math.abs(price);
  if (magnitude === 0) return '0';
  if (magnitude >= 1000) return price.toFixed(0);
  if (magnitude >= 1) return price.toFixed(3);
  if (magnitude >= 0.001) return price.toFixed(5);
  if (magnitude >= 1e-8) return price.toFixed(9);
  return price.toExponential(2);
}
