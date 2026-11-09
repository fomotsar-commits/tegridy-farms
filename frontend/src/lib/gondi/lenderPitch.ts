// The lender's pitch and the lender's risk, as numbers (owner 2026-11-09, ideas 1, 2 and 4).
//
// 1. A whole-collection offer is a floor bid that earns while it waits: repaid, the lender
//    keeps the interest; unpaid at the deadline, the lender gets the NFT for what they lent.
// 2. Same take-home, cheaper for the borrower. Gondi's own contracts keep 15% (v3.1) and 20%
//    (v3.2) of a lender's interest (getProtocolFee, read 2026-11-09); ours keeps 5%. Gondi's
//    lenders use v3.1: 56,639 loan events there vs 312 on v3.2, and every Gondi loan on our
//    three collections (958, all Nakamigos) is on v3.1 (scripts/gondi-lender-list.mjs). The
//    screen compares with the LOWER of the two live fees, and only when both are read.
// 4. Who buys it: if the lender ends up holding the NFT, the open bids are the way out. They
//    are OpenSea's, read through our own proxy (/api/opensea). Blur's bids are not in it, so
//    the numbers can only UNDER-count buyers, never invent one.
//
// How money moves: nothing here moves money. It only reads.
import { useQuery } from '@tanstack/react-query';
import { openseaGet } from '../../nakamigos/lib/proxy';

/** Gondi's own MultiSourceLoan contracts (not ours): v3.1, where its lenders are, and v3.2. */
export const GONDI_OWN_LOAN_ADDRESSES = [
  '0xf41B389E0C1950dc0B16C9498eaE77131CC08A56',
  '0xE365fF3cad44d19cb7aBa81df8ffd6818A66Ac0a',
] as const;

/**
 * The fee to compare with: the LOWER of Gondi's live fees, so the comparison never flatters
 * us. Null unless every read came back as a real fee.
 */
export function lowestOwnFeeBps(reads: readonly ({ status: string; result?: unknown } | undefined)[] | undefined): number | null {
  if (!reads || reads.length !== GONDI_OWN_LOAN_ADDRESSES.length) return null;
  const fees: number[] = [];
  for (const r of reads) {
    const fraction = r?.status === 'success' ? (r.result as { fraction?: unknown } | undefined)?.fraction : undefined;
    if (typeof fraction !== 'bigint') return null;
    fees.push(Number(fraction));
  }
  return Math.min(...fees);
}

/** Gondi's fee denominator: getProtocolFee().fraction of 500 = 5% of the interest. */
export const FEE_PRECISION = 10_000;

/**
 * The APR a lender would have to charge on the other contract to keep the same interest
 * after that contract's fee. Interest is linear in the APR and both fees are a share of the
 * interest, so: other = ours x (1 - ourFee) / (1 - theirFee), to the nearest bps.
 * Null when any input is not a real fee or rate: an unread fee is unknown, not zero.
 */
export function sameTakeHomeAprBps(aprBps: number, ourFeeBps: number | null, theirFeeBps: number | null): number | null {
  if (ourFeeBps === null || theirFeeBps === null) return null;
  const ok = (fee: number) => Number.isInteger(fee) && fee >= 0 && fee < FEE_PRECISION;
  if (!ok(ourFeeBps) || !ok(theirFeeBps) || !Number.isFinite(aprBps) || aprBps <= 0) return null;
  return Math.round((aprBps * (FEE_PRECISION - ourFeeBps)) / (FEE_PRECISION - theirFeeBps));
}

/* ─── Who buys it ──────────────────────────────────────────────── */

/** One OpenSea collection offer after api-offers.js normalizeCollectionOffer: price PER ITEM. */
export interface CollectionBidLike {
  price: number | null;
  quantity: number;
  quantityKnown: boolean;
  currency?: string | null;
  criteria?: {
    trait?: unknown;
    traits?: unknown[] | null;
    numericTraits?: unknown[] | null;
    encoded_token_ids?: string | null;
  } | null;
}

export interface BidBook {
  /** The highest open bid that would buy ANY NFT of the collection; null = none open. */
  bestBid: number | null;
  /** How many NFTs open bids would buy at 90% of the floor or more; null = floor unknown. */
  nearFloor: number | null;
}

/** "Near the floor" = within 10% of it. */
export const NEAR_FLOOR = 0.9;

// A defaulted lender holds the borrower's cheapest NFT, so only a bid that buys ANY token of
// the collection is a way out. Trait and token-list bids buy some tokens only.
function buysAnyToken(c: CollectionBidLike['criteria']): boolean {
  if (!c) return true;
  if (c.trait != null) return false;
  if (Array.isArray(c.traits) && c.traits.length > 0) return false;
  if (Array.isArray(c.numericTraits) && c.numericTraits.length > 0) return false;
  if (typeof c.encoded_token_ids === 'string' && c.encoded_token_ids !== '' && c.encoded_token_ids !== '*') return false;
  return true;
}

export function bidBook(bids: readonly CollectionBidLike[], floor: number | null): BidBook {
  const usable = bids.filter(
    (b) =>
      typeof b.price === 'number' &&
      Number.isFinite(b.price) &&
      b.price > 0 &&
      // Without the order's quantity the price is the whole order's, not one token's.
      b.quantityKnown &&
      Number.isFinite(b.quantity) &&
      b.quantity >= 1 &&
      String(b.currency ?? '').toUpperCase() === 'WETH' &&
      buysAnyToken(b.criteria),
  );
  const bestBid = usable.length ? Math.max(...usable.map((b) => b.price as number)) : null;
  const floorOk = typeof floor === 'number' && Number.isFinite(floor) && floor > 0;
  const nearFloor = floorOk
    ? usable.filter((b) => (b.price as number) >= floor * NEAR_FLOOR).reduce((n, b) => n + Math.floor(b.quantity), 0)
    : null;
  return { bestBid, nearFloor };
}

export type ExitCheck =
  | { kind: 'no-bids' }
  | { kind: 'covered'; bestBid: number }
  | { kind: 'short'; bestBid: number; gap: number };

/**
 * If the borrower never repays, can the lender sell the NFT today for what they lent?
 * Null when the bids could not be read: unknown, not "no buyers".
 */
export function exitCheck(principalEth: number, bids: BidBook | null): ExitCheck | null {
  if (!bids || !Number.isFinite(principalEth) || principalEth <= 0) return null;
  if (bids.bestBid === null) return { kind: 'no-bids' };
  if (principalEth <= bids.bestBid) return { kind: 'covered', bestBid: bids.bestBid };
  return { kind: 'short', bestBid: bids.bestBid, gap: principalEth - bids.bestBid };
}

/** How far the lent amount sits under (+) or over (-) the floor, in whole percent. */
export function underFloorPct(principalEth: number, floor: number | null): number | null {
  if (typeof floor !== 'number' || !Number.isFinite(floor) || floor <= 0) return null;
  if (!Number.isFinite(principalEth) || principalEth <= 0) return null;
  return Math.round(((floor - principalEth) / floor) * 100);
}

/* ─── The read ─────────────────────────────────────────────────── */

/** OpenSea slugs of the lending collections (lib/gondi/loanOffer.js), keyed by address. */
export const LENDING_OPENSEA_SLUGS: Readonly<Record<string, string>> = Object.freeze({
  '0xd37264c71e9af940e49795f0d3a8336afaafdda9': 'junglebay', // JBAC
  '0xd774557b647330c91bf44cfeab205095f7e6c367': 'nakamigos', // NAKA
  '0xa1de9f93c56c290c48849b1393b09eb616d55dbb': 'gnssart', // GNSS
});

export interface LendingMarket {
  /** OpenSea floor in ETH; null = not read, or OpenSea has none. */
  floor: number | null;
  /** Sales in the last 30 days; null = not read. */
  sales30d: number | null;
  /** Null = the bids could not be read: unknown, never shown as "no buyers". */
  bids: BidBook | null;
}

interface StatsJson {
  total?: { floor_price?: unknown } | null;
  intervals?: { interval?: unknown; sales?: unknown }[] | null;
}

export function readStats(json: unknown): Pick<LendingMarket, 'floor' | 'sales30d'> {
  const s = (json ?? {}) as StatsJson;
  const f = s.total?.floor_price;
  const floor = typeof f === 'number' && Number.isFinite(f) && f > 0 ? f : null;
  const month = Array.isArray(s.intervals) ? s.intervals.find((i) => i?.interval === 'thirty_day') : undefined;
  const n = month?.sales;
  const sales30d = typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
  return { floor, sales30d };
}

export async function fetchLendingMarket(collection: string): Promise<LendingMarket> {
  const slug = LENDING_OPENSEA_SLUGS[collection.toLowerCase()];
  if (!slug) return { floor: null, sales30d: null, bids: null };
  // The marketplace's own normalizer (price per item); loaded only when this panel asks.
  const [statsRes, offersRes, offersLib] = await Promise.allSettled([
    openseaGet(`collections/${slug}/stats`),
    openseaGet(`offers/collection/${slug}/all`),
    import('../../nakamigos/api-offers.js'),
  ]);
  const stats = statsRes.status === 'fulfilled' ? readStats(statsRes.value) : { floor: null, sales30d: null };
  let bids: BidBook | null = null;
  if (offersRes.status === 'fulfilled' && offersLib.status === 'fulfilled') {
    const raw = (offersRes.value as { offers?: unknown }).offers;
    if (Array.isArray(raw)) {
      bids = bidBook(raw.map((o) => offersLib.value.normalizeCollectionOffer(o) as CollectionBidLike), stats.floor);
    }
  }
  return { ...stats, bids };
}

/** One read per collection a minute: the proxy caches stats for 60 s anyway. */
export function useLendingMarket(collection: string, enabled = true) {
  return useQuery({
    queryKey: ['lending-market', collection.toLowerCase()],
    queryFn: () => fetchLendingMarket(collection),
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
