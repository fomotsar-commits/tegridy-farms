// Small pure helpers for the Lend form and the Borrow tab's empty state.
import { LENDING_COLLECTIONS } from './loanOffer.js';

/** The shares of the floor the Lend form offers as one-tap amounts. */
export const FLOOR_SHARES = [60, 75, 90] as const;

/** `pct`% of a floor price as a WETH amount to type, rounded DOWN to 4 decimals so a chip
 *  never lends more than the share it names. Null when there is no usable floor, or the
 *  share rounds to nothing. */
export function floorShareAmount(floorEth: number | null | undefined, pct: number): string | null {
  if (typeof floorEth !== 'number' || !Number.isFinite(floorEth) || floorEth <= 0) return null;
  if (!Number.isFinite(pct) || pct <= 0) return null;
  // Work in 1e-4 ETH units; the epsilon keeps 0.3 * 90% at 0.27, not 0.2699.
  const units = Math.floor(floorEth * pct * 100 + 1e-6);
  if (units <= 0) return null;
  return (units / 10_000).toFixed(4);
}

/** Where a new offer's rate would sit among a collection's open offers: borrowers are
 *  shown the cheapest rate first, so rank 1 is the lowest rate. A tie ranks with the best
 *  of the tied offers. */
export function rateRank(myAprBps: bigint, others: readonly { aprBps: string }[]): { rank: number; of: number } {
  let cheaper = 0;
  for (const o of others) {
    try {
      if (BigInt(o.aprBps) < myAprBps) cheaper += 1;
    } catch {
      // An unreadable rate neither helps nor hurts the rank.
    }
  }
  return { rank: cheaper + 1, of: others.length + 1 };
}

/** The link a borrower sends a lender: the Lend tab with the collection picked. */
export function lenderLink(origin: string, symbol: string): string {
  return `${origin}/nft-finance?lend=${encodeURIComponent(symbol)}`;
}

/** The collection a `?lend=SYMBOL` link names, or null. Only the venue's own collections. */
export function lendLinkCollection(search: string): { symbol: string; address: string } | null {
  let wanted: string | null = null;
  try {
    wanted = new URLSearchParams(search).get('lend');
  } catch {
    return null;
  }
  if (!wanted) return null;
  const hit = (LENDING_COLLECTIONS as readonly { symbol: string; address: string }[]).find(
    (c) => c.symbol.toLowerCase() === wanted!.toLowerCase(),
  );
  return hit ? { symbol: hit.symbol, address: hit.address } : null;
}
