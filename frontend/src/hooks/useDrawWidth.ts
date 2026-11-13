// How wide an instrument's picture really is, so it is drawn one unit to one pixel.
//
// The drag instruments (FloorBar, LoanTimeline, RangeDrag, RangeHoldingsDial, PoolTradeDial,
// PriceMoveDial) used to draw on a fixed 320-wide viewBox stretched to the card: on a wide
// desktop card that scaled everything about five times, a 9-unit label to 56 px and a 58-unit
// bar to 311 px (owner, 2026-11-12). Each now draws on a viewBox as wide as the box it sits in
// and as tall as its own height in pixels, so text, track and handles keep one size on a phone
// and on a desktop, and only the length of the axis changes.
//
// Until the box is measured (and wherever nothing can measure it, as in jsdom), the width is
// `fallback`, which is the 320 every instrument was designed at.
import { useLayoutEffect, useState } from 'react';

export const DRAW_WIDTH = 320;

/** A callback ref for the box the picture fills, and that box's width in whole pixels. */
export function useDrawWidth(fallback: number = DRAW_WIDTH): [(el: Element | null) => void, number] {
  const [el, setEl] = useState<Element | null>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    if (!el) return;
    const read = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      // A box that is not laid out (a closed fold, a hidden tab) reads 0: keep the last width.
      if (w > 0) setWidth((prev) => (prev === w ? prev : w));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, [el]);
  return [setEl, width];
}
