// The axis under the draggable range (components/solana/range/RangeDrag.tsx).
//
// A fixed log axis around the price the range starts from: a "stop" is a hundredth of a
// doubling, so stop 0 is that price, +100 is double, -100 is half. Fixed, unlike the strip's
// own axis (rangeStrip.ts), which re-fits itself to what is drawn: a handle cannot be dragged
// along an axis that moves under the finger.

/** How far each way the handles reach: 4 doublings, a sixteenth to 16 times. */
export const DRAG_STOPS = 400;
/** One arrow-key press: a twentieth of a doubling, about 3.5%. */
export const DRAG_STEP = 5;
/** The two handles never come closer than this, so the lowest stays below the highest. */
export const DRAG_GAP = 10;

const usable = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

/** The price at a stop. */
export function priceAtStop(now: number, stop: number): number {
  return now * 2 ** (stop / 100);
}

/** The stop nearest a price, held to the axis and to whole steps. Null for a price or a
 *  starting price that is not a positive number. */
export function stopAtPrice(now: number, price: number | null | undefined): number | null {
  if (!usable(now) || !usable(price)) return null;
  const raw = Math.log2(price / now) * 100;
  const stepped = Math.round(raw / DRAG_STEP) * DRAG_STEP;
  return Math.max(-DRAG_STOPS, Math.min(DRAG_STOPS, stepped));
}

/** Where a stop sits on the axis, 0 to 1. */
export function stopFraction(stop: number): number {
  return (stop + DRAG_STOPS) / (2 * DRAG_STOPS);
}

/** The stop under a point `fraction` of the way along the axis. */
export function stopAtFraction(fraction: number): number {
  const f = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
  return Math.round((f * 2 * DRAG_STOPS - DRAG_STOPS) / DRAG_STEP) * DRAG_STEP;
}

/**
 * Move one handle to `to`, keeping both on the axis and the lowest at least DRAG_GAP below
 * the highest. The moved handle stops at the other one; it never pushes it.
 */
export function moveHandle(pair: { lo: number; hi: number }, which: 'lo' | 'hi', to: number): { lo: number; hi: number } {
  const t = Math.max(-DRAG_STOPS, Math.min(DRAG_STOPS, Math.round(to / DRAG_STEP) * DRAG_STEP));
  return which === 'lo' ? { lo: Math.min(t, pair.hi - DRAG_GAP), hi: pair.hi } : { lo: pair.lo, hi: Math.max(t, pair.lo + DRAG_GAP) };
}

/** Which handle a press at `stop` should take: the nearer one; on a tie, the one on its side. */
export function nearerHandle(pair: { lo: number; hi: number }, stop: number): 'lo' | 'hi' {
  const dLo = Math.abs(stop - pair.lo);
  const dHi = Math.abs(stop - pair.hi);
  if (dLo === dHi) return stop <= pair.lo ? 'lo' : 'hi';
  return dLo < dHi ? 'lo' : 'hi';
}

/** "half", "the same", "2 times", "1.41 times": a stop as a multiple of the starting price. */
export function stopTimes(stop: number): string {
  if (stop === 0) return 'the same';
  const r = 2 ** (stop / 100);
  if (stop === -100) return 'half';
  if (stop === -200) return 'a quarter';
  const text = r >= 10 ? r.toFixed(0) : r >= 1 ? r.toFixed(2).replace(/\.?0+$/, '') : r.toFixed(3).replace(/0+$/, '');
  return `${text} times`;
}
