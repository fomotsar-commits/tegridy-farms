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
// The venue's own bidder (lib/house/houseRegistry.json) is never one of those buyers here:
// a house bid would make a loan look safer only because the venue itself bids, so it counts
// in no number on the card. And "near the floor" counts only what each bidder's WETH can
// actually pay for (2026-11-16): a bid is a signature, and an unfunded one buys nothing.
//
// How money moves: nothing here moves money. It only reads.
import { useQuery } from '@tanstack/react-query';
import { openseaGet } from '../../nakamigos/lib/proxy';
import { buysAnyTokenOrder } from '../../nakamigos/lib/offerScope.js';
import { normalizeCollectionOffer } from '../../nakamigos/lib/offerNormalize.js';
import { isHouseWallet } from '../house/houseRegistry.js';

export { buysAnyTokenOrder };

/**
 * OpenSea's conduit and the key an order names to use it (the marketplace's CONDUIT_ADDRESS
 * and CONDUIT_KEY, nakamigos/constants.js; a test holds them equal). An OpenSea bid's WETH
 * is pulled through this conduit, so the bidder's allowance to it is what pays.
 */
export const OPENSEA_CONDUIT = '0x1E0049783F008A0085193E00003D00cd54003c71' as const;
export const OPENSEA_CONDUIT_KEY = '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000' as const;

/** At most this many bidders' WETH is read for the near-floor count, in one multicall. */
export const MAX_FUNDING_READS = 50;

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
  /** Who bids (the order's offerer). */
  maker?: string | null;
  /** The WETH one NFT costs the bidder, in wei; null = not read from the order. */
  unitWei?: bigint | null;
  /** The order pulls its WETH through OpenSea's conduit, so that allowance is what pays. */
  viaOpenSeaConduit?: boolean;
}

/** A bid at 90% of the floor or more, still to be checked against its bidder's WETH. */
export interface NearFloorBid {
  /** The bidder, lowercase. */
  maker: string;
  /** WETH per NFT, in wei. */
  unitWei: bigint;
  /** NFTs the bid still buys. */
  units: number;
}

export interface BidBook {
  /** The highest open bid that would buy ANY NFT of the collection; null = none open. */
  bestBid: number | null;
  /**
   * The bids that would buy at 90% of the floor or more, before anyone's WETH is read;
   * null = floor unknown. Only bids whose WETH can be checked are here (see bidBook).
   */
  nearFloorBids: NearFloorBid[] | null;
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

const MAKER = /^0x[0-9a-fA-F]{40}$/;

/**
 * The best bid and the near-floor bids, from outside bidders only: a bid by the venue's own
 * wallet counts in neither (and so in no exit check and no "covered" stretch of the floor
 * bar). A near-floor bid whose bidder or per-NFT WETH cannot be read, or whose WETH does not
 * move through OpenSea's conduit, cannot be checked for funds and is not counted.
 */
export function bidBook(
  bids: readonly CollectionBidLike[],
  floor: number | null,
  { isHouse = isHouseWallet }: { isHouse?: (address: string | null | undefined) => boolean } = {},
): BidBook {
  const usable = bids.filter(
    (b) =>
      !isHouse(b.maker) &&
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
  const nearFloorBids = floorOk
    ? usable
        .filter((b) => (b.price as number) >= floor * NEAR_FLOOR)
        .flatMap((b): NearFloorBid[] =>
          typeof b.maker === 'string' && MAKER.test(b.maker) && typeof b.unitWei === 'bigint' && b.unitWei > 0n && b.viaOpenSeaConduit === true
            ? [{ maker: b.maker.toLowerCase(), unitWei: b.unitWei, units: Math.floor(b.quantity) }]
            : [],
        )
    : null;
  return { bestBid, nearFloorBids };
}

/**
 * The bidders whose WETH the near-floor count reads: each once, the highest bid first, at
 * most MAX_FUNDING_READS. A bidder past that cut is not read and counts nothing.
 */
export function fundingMakers(book: BidBook | null): string[] {
  const best = new Map<string, bigint>();
  for (const b of book?.nearFloorBids ?? []) {
    const seen = best.get(b.maker);
    if (seen === undefined || b.unitWei > seen) best.set(b.maker, b.unitWei);
  }
  return [...best.entries()]
    .sort(([ma, a], [mb, b]) => (a === b ? (ma < mb ? -1 : 1) : a > b ? -1 : 1))
    .slice(0, MAX_FUNDING_READS)
    .map(([maker]) => maker);
}

/** One answer of a multicall read, as wagmi's useReadContracts hands it back. */
export type FundingRead = { status: string; result?: unknown } | undefined;

const amount = (r: FundingRead): bigint | null =>
  r?.status === 'success' && typeof r.result === 'bigint' && r.result >= 0n ? r.result : null;

/**
 * How many NFTs the near-floor bids would really buy. `reads` are two per bidder, in
 * `makers` order: WETH balanceOf, then allowance to OpenSea's conduit. A bidder can spend the
 * lower of the two, and spends it on its highest bid first; no bid counts for more NFTs than
 * it still asks for, and none for more than the WETH left after the bidder's higher bids.
 *
 * A bidder whose read failed, or who was past the read cut, counts 0: never invent a buyer.
 * Null when the floor is unknown, the reads are not in yet, or not one read answered (that is
 * no answer, not "no buyers").
 */
export function fundedNearFloor(book: BidBook | null, makers: readonly string[], reads: readonly FundingRead[] | undefined): number | null {
  if (!book || book.nearFloorBids === null) return null;
  if (book.nearFloorBids.length === 0) return 0;
  if (!reads || reads.length !== makers.length * 2 || reads.length === 0) return null;
  if (reads.every((r) => r?.status !== 'success')) return null;
  const spendable = new Map<string, bigint>();
  makers.forEach((maker, i) => {
    const balance = amount(reads[2 * i]);
    const allowance = amount(reads[2 * i + 1]);
    spendable.set(maker, balance === null || allowance === null ? 0n : balance < allowance ? balance : allowance);
  });
  const byMaker = new Map<string, NearFloorBid[]>();
  for (const b of book.nearFloorBids) byMaker.set(b.maker, [...(byMaker.get(b.maker) ?? []), b]);
  let units = 0;
  for (const [maker, bids] of byMaker) {
    let left = spendable.get(maker) ?? 0n;
    for (const b of [...bids].sort((x, y) => (x.unitWei === y.unitWei ? 0 : x.unitWei > y.unitWei ? -1 : 1))) {
      const fundable = left / b.unitWei;
      const take = fundable < BigInt(b.units) ? Number(fundable) : b.units;
      units += take;
      left -= BigInt(take) * b.unitWei;
    }
  }
  return units;
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

interface RawSeaportOffer {
  remaining_quantity?: unknown;
  protocol_data?: {
    parameters?: {
      conduitKey?: unknown;
      offer?: { startAmount?: unknown }[];
      consideration?: { itemType?: unknown; identifierOrCriteria?: unknown; startAmount?: unknown }[];
    };
  };
}

/**
 * The WETH one NFT costs the bidder, in wei: the order's WETH over the NFTs it was made for
 * (a part-filled order keeps both totals, so the price per NFT is unchanged). Null when the
 * order does not say.
 */
function unitWeiOf(o: RawSeaportOffer, quantity: number): bigint | null {
  const total = o.protocol_data?.parameters?.offer?.[0]?.startAmount;
  if (!/^[0-9]+$/.test(String(total ?? '')) || !Number.isInteger(quantity) || quantity < 1) return null;
  const unit = BigInt(String(total)) / BigInt(quantity);
  return unit > 0n ? unit : null;
}

export async function fetchLendingMarket(collection: string): Promise<LendingMarket> {
  const slug = LENDING_OPENSEA_SLUGS[collection.toLowerCase()];
  if (!slug) return { floor: null, sales30d: null, bids: null };
  // `offers/collection/{slug}` = collection-wide offers, best per item first (the `/all`
  // route mixes in single-token offers: see buysAnyTokenOrder). The marketplace's own
  // normalizer (price per item) comes from its own small file, not the marketplace's whole client.
  const [statsRes, offersRes] = await Promise.allSettled([
    openseaGet(`collections/${slug}/stats`),
    openseaGet(`offers/collection/${slug}`),
  ]);
  const stats = statsRes.status === 'fulfilled' ? readStats(statsRes.value) : { floor: null, sales30d: null };
  let bids: BidBook | null = null;
  if (offersRes.status === 'fulfilled') {
    const raw = (offersRes.value as { offers?: unknown }).offers;
    if (Array.isArray(raw)) {
      const normalize = normalizeCollectionOffer as (o: unknown) => CollectionBidLike;
      const usable = raw.filter(buysAnyTokenOrder).map((o): CollectionBidLike => {
        const r = o as RawSeaportOffer;
        const b = normalize(o);
        const priced = {
          ...b,
          unitWei: b.quantityKnown ? unitWeiOf(r, b.quantity) : null,
          viaOpenSeaConduit: String(r.protocol_data?.parameters?.conduitKey ?? '').toLowerCase() === OPENSEA_CONDUIT_KEY,
        };
        // A part-filled bid buys only what is left of it.
        const left = Number(r.remaining_quantity);
        return Number.isInteger(left) && left >= 0 && left < b.quantity ? { ...priced, quantity: left } : priced;
      });
      bids = bidBook(usable, stats.floor);
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
