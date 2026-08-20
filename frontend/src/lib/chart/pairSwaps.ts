// Indexed TegridyPair swaps → priced trades.
//
// GROUND TRUTH is indexer/ponder.schema.ts `pair_event`. There is no price
// column anywhere in the indexer and there is no OHLC table: a price here is
// DERIVED, per swap, from the four amount legs of a constant-product trade. So
// this module is the one place on the chart path where the number is computed
// rather than read, and it is deliberately the smallest possible
// amount of arithmetic — one division per row, no smoothing, no VWAP, no
// mid-price fill.
//
// DECIMALS ARE AN INPUT, NOT A GUESS. `pair_event` stores raw uint256 legs and
// `indexed_pair` stores only the two token addresses, so nothing indexed says
// how many decimals either side has. The caller supplies them; get them wrong
// and every price is off by a power of ten. They are required arguments rather
// than defaulted to 18 for exactly that reason — a default would make a wrong
// axis the quiet outcome. lib/chart/pairTokens.ts is the resolver that refuses
// a pair whose legs this build cannot identify.
//
// The indexer only tracks pairs with a canonical protocol token on one leg
// (the poisoning allowlist in ponder.schema.ts), which is what makes a
// quote-per-base price meaningful at all here.

import { z } from 'zod';
import {
  INDEXER_META_SELECTION,
  addressSchema,
  bigIntStringSchema,
  clampPageLimit,
  pageInfoSchema,
} from '../indexer/client';
import type { Trade } from './candles';

const PAGE_TAIL = 'pageInfo { hasNextPage endCursor }';

/**
 * Mint and burn rows carry `amount0In`/`amount0Out` as null — the columns are
 * nullable and only populated for swaps. Nullable here rather than filtered in
 * the schema so a mis-typed `where` clause surfaces as unpriceable rows the UI
 * counts, not as a shorter series nobody notices.
 */
export const pairSwapRowSchema = z.object({
  id: z.string(),
  type: z.string(),
  pair: addressSchema,
  amount0In: bigIntStringSchema.nullable(),
  amount1In: bigIntStringSchema.nullable(),
  amount0Out: bigIntStringSchema.nullable(),
  amount1Out: bigIntStringSchema.nullable(),
  timestamp: bigIntStringSchema,
});

export type PairSwapRow = z.infer<typeof pairSwapRowSchema>;

export const pairSwapsDataSchema = z.object({
  pairEvents: z.object({
    items: z.array(pairSwapRowSchema),
    pageInfo: pageInfoSchema,
  }),
});

export type PairSwapsData = z.infer<typeof pairSwapsDataSchema>;

export const PAIR_SWAPS_QUERY = `query PairSwaps($limit: Int!, $where: pairEventFilter!) {
  pairEvents(where: $where, orderBy: "timestamp", orderDirection: "desc", limit: $limit) {
    items { id type pair amount0In amount1In amount0Out amount1Out timestamp }
    ${PAGE_TAIL}
  }
  ${INDEXER_META_SELECTION}
}`;

export interface PairSwapsVariables {
  limit: number;
  where: Record<string, unknown>;
}

/**
 * `where` is `{}`-shaped and never null — Ponder's where-builder iterates the
 * object after an `=== undefined` guard, so an explicit null 500s inside the
 * server and reaches the UI as an outage. Same rule as lib/terminal/feed.ts.
 */
export function pairSwapsVariables(pair: string, limit: number): PairSwapsVariables {
  return {
    limit: clampPageLimit(limit),
    // `t.hex()` columns are stored lowercased. A checksummed filter that failed
    // to match would come back as an empty page, which on a chart reads as "this
    // pool has never traded" — a false claim about a market, produced by casing.
    where: { pair: pair.toLowerCase(), type: 'swap' },
  };
}

/**
 * Raw uint256 → decimal number, without routing the whole value through
 * `Number()` first.
 *
 * `Number(10n ** 30n) / 1e18` loses the low digits before the division ever
 * happens. Splitting integer and fractional parts keeps full precision on
 * everything below 2^53 base units, which covers every amount a chart axis can
 * distinguish; above that the integer part alone dominates the ratio anyway.
 */
export function scaleAmount(raw: bigint, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new RangeError('decimals must be a whole number in [0, 77]');
  }
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const frac = abs - whole * unit;
  const value = Number(whole) + Number(frac) / Number(unit);
  return negative ? -value : value;
}

/**
 * Log position within the block, read off the indexed row's primary key.
 *
 * `pair_event.id` is written as Ponder's own log id, which is
 * `${blockHash}-${logIndex}` (indexer/src/index.ts). That suffix is the only
 * intra-block ordering signal anywhere on this query: `timestamp` is the block's
 * and is therefore identical for every swap in it, and the id as a WHOLE sorts
 * by block hash — an effectively random key — so ordering rows by it would be
 * worse than not ordering them. Only the suffix is meaningful, so only the
 * suffix is read.
 *
 * Null for any id that is not that shape. Callers must treat null as "unknown
 * order", never as position zero: a default of 0 would collapse every swap in a
 * block to the same rank and quietly reintroduce the tie this exists to break.
 *
 * The match is deliberately strict about the WHOLE id rather than just scraping
 * trailing digits. If the indexer's id format ever changes, a strict pattern
 * fails and the caller reports the order as unestablished; a lenient one would
 * keep returning plausible ranks parsed out of a string that no longer means
 * what this function thinks it means.
 */
const LOG_ID = /^0x[0-9a-fA-F]+-(\d+)$/;

export function logIndexOf(id: string): number | null {
  const match = LOG_ID.exec(id);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export interface PairPricing {
  /**
   * Which leg the price is quoted PER. The other leg is the quote.
   *
   * Ponder sorts nothing here — token0/token1 are whatever the pool's own
   * ordering made them, which for a UniswapV2-shaped factory is address order.
   * So "which side is the money" is a caller decision, and getting it backwards
   * silently produces the reciprocal of the real price: still a plausible-looking
   * chart, off by a reciprocal.
   */
  base: 'token0' | 'token1';
  token0Decimals: number;
  token1Decimals: number;
}

/**
 * One swap row → one trade priced in quote per base, or null.
 *
 * Null is returned for every row this module declines to price: a non-swap row,
 * a row missing a leg, and — the one that matters — a row whose base leg is
 * zero. A zero base leg makes the division undefined, and the tempting repairs
 * (carry the previous price, use the pool's other side) both put a number on a
 * trade whose price was never observed. The caller counts these.
 */
export function priceSwapRow(row: PairSwapRow, pricing: PairPricing): Trade | null {
  if (row.type !== 'swap') return null;

  const zeroIn = row.amount0In ?? 0n;
  const oneIn = row.amount1In ?? 0n;
  const zeroOut = row.amount0Out ?? 0n;
  const oneOut = row.amount1Out ?? 0n;

  const baseIsZero = pricing.base === 'token0';
  const baseIn = baseIsZero ? zeroIn : oneIn;
  const baseOut = baseIsZero ? zeroOut : oneOut;
  const quoteIn = baseIsZero ? oneIn : zeroIn;
  const quoteOut = baseIsZero ? oneOut : zeroOut;
  const baseDecimals = baseIsZero ? pricing.token0Decimals : pricing.token1Decimals;
  const quoteDecimals = baseIsZero ? pricing.token1Decimals : pricing.token0Decimals;

  // A TegridyPair swap moves one token in and the other out. Which direction it
  // went does not change the price — only which pair of legs carries it.
  let baseRaw: bigint;
  let quoteRaw: bigint;
  if (baseOut > 0n && quoteIn > 0n) {
    baseRaw = baseOut;
    quoteRaw = quoteIn;
  } else if (baseIn > 0n && quoteOut > 0n) {
    baseRaw = baseIn;
    quoteRaw = quoteOut;
  } else {
    return null;
  }

  const baseAmount = scaleAmount(baseRaw, baseDecimals);
  const quoteAmount = scaleAmount(quoteRaw, quoteDecimals);
  if (!(baseAmount > 0) || !Number.isFinite(quoteAmount)) return null;

  const price = quoteAmount / baseAmount;
  if (!Number.isFinite(price) || price <= 0) return null;

  const timeSec = Number(row.timestamp);
  if (!Number.isFinite(timeSec) || timeSec <= 0) return null;

  const sequence = logIndexOf(row.id);
  return sequence === null
    ? { timeSec, price, volume: baseAmount }
    : { timeSec, price, volume: baseAmount, sequence };
}

export interface PricedPage {
  trades: Trade[];
  /** Rows that could not be priced. Reported, never silently dropped. */
  unpriceable: number;
  /** More swap rows exist older than this page. */
  truncated: boolean;
}

export function priceSwapPage(data: PairSwapsData, pricing: PairPricing): PricedPage {
  const trades: Trade[] = [];
  let unpriceable = 0;
  for (const row of data.pairEvents.items) {
    const trade = priceSwapRow(row, pricing);
    if (trade) trades.push(trade);
    else unpriceable += 1;
  }
  return { trades, unpriceable, truncated: data.pairEvents.pageInfo.hasNextPage };
}
