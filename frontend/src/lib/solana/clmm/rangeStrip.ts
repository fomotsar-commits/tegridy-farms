/** Where the range strip draws each price, as a percent of its width, on a log scale. */
export interface StripLayout {
  now: number;
  market: number | null;
  band: { from: number; to: number } | null;
  /** This pool's price against the range: inside it, below it (the range holds the token only), or above it. */
  where: 'inside' | 'below' | 'above' | null;
}

const usable = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

/**
 * Lays the pool's price, the market's and the picked range on one axis. Log, so a range
 * twice the price and one half of it sit the same distance from it. The axis spans what is
 * drawn, padded so no mark sits on an edge. A price that is not a positive number is left
 * off; with no usable pool price there is nothing to draw.
 */
export function stripLayout(o: { now: number; market?: number | null; lo?: number | null; hi?: number | null }): StripLayout | null {
  if (!usable(o.now)) return null;
  const range = usable(o.lo) && usable(o.hi) && o.lo < o.hi ? { lo: o.lo, hi: o.hi } : null;
  const market = usable(o.market) ? o.market : null;
  const logs = [o.now, market, range?.lo, range?.hi].filter(usable).map(Math.log);
  const min = Math.min(...logs);
  const max = Math.max(...logs);
  const pad = Math.max((max - min) * 0.18, Math.log(1.15));
  const from = min - pad;
  const span = max + pad - from;
  const at = (x: number) => ((Math.log(x) - from) / span) * 100;
  return {
    now: at(o.now),
    market: market === null ? null : at(market),
    band: range ? { from: at(range.lo), to: at(range.hi) } : null,
    where: range ? (o.now < range.lo ? 'below' : o.now > range.hi ? 'above' : 'inside') : null,
  };
}
