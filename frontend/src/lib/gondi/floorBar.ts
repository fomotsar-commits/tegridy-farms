// The axis under the lender's floor bar (components/nftfinance/FloorBar.tsx): the amount lent
// drawn against the collection's floor and the best open bid.

const usable = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

/** The bar runs from nothing to a quarter over the floor, or just past the best bid or the
 *  amount typed if either is further out. Null with no usable floor: there is nothing to
 *  measure the amount against. */
export function barMax(floor: number | null | undefined, bestBid: number | null | undefined, principal: number | null | undefined): number | null {
  if (!usable(floor)) return null;
  return Math.max(floor * 1.25, usable(bestBid) ? bestBid * 1.05 : 0, usable(principal) ? principal * 1.05 : 0);
}

/** One step of the bar: a two-hundredth of the floor, never finer than 0.0001 WETH. */
export function barStep(floor: number): number {
  return Math.max(0.0001, Math.round((floor / 200) * 10_000) / 10_000);
}

/**
 * Where the amount stands:
 *   covered      at or under the best open bid: unrepaid, a buyer already pays this much
 *   under-floor  over the best bid (or no bids read) but at or under the floor
 *   over-floor   more than the cheapest one is listed for
 */
export type BarZone = 'covered' | 'under-floor' | 'over-floor';

export function barZone(principal: number, floor: number, bestBid: number | null | undefined): BarZone {
  if (usable(bestBid) && principal <= bestBid) return 'covered';
  return principal <= floor ? 'under-floor' : 'over-floor';
}

/** A dragged value as the amount box takes it: WETH to 4 decimals, never negative. */
export function barAmount(value: number): string {
  return (Math.max(0, Math.round(value * 10_000)) / 10_000).toFixed(4);
}
