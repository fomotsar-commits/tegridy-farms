// The terminal's discovery feed — GraphQL document, response schema, and the
// assembly that turns two indexed tables into rows.
//
// GROUND TRUTH is indexer/ponder.schema.ts. Two tables back this feed and
// neither is a pair-creation log:
//
//   indexedPair — the factory-poisoning allowlist cache (id = pair address,
//                 token0, token1, allowed). It has NO created-at column.
//   pairEvent   — swap / mint / burn rows with timestamps.
//
// So this module CANNOT report a pair's age, and does not pretend to. What it
// reports is activity inside a stated window, and it says "window" everywhere a
// less careful surface would say "ever". The distinction is load-bearing: the
// query reads one page ordered newest-first, so the oldest row in that page is
// not any pair's first event, and a pair absent from the page has not been shown
// to be quiet — it has been shown to be outside the window.
//
// The allowlist is applied here rather than in the `where` clause so the count of
// what was excluded survives into the UI. A silently shorter list is the same
// failure as a fabricated one, seen from the other side.

import { z } from 'zod';
import {
  INDEXER_META_SELECTION,
  addressSchema,
  bigIntStringSchema,
  clampPageLimit,
  pageInfoSchema,
} from '../indexer/client';

const PAGE_TAIL = 'pageInfo { hasNextPage endCursor }';

export const indexedPairRowSchema = z.object({
  id: addressSchema,
  token0: addressSchema,
  token1: addressSchema,
  allowed: z.boolean(),
});

export type IndexedPairRow = z.infer<typeof indexedPairRowSchema>;

export const pairEventRowSchema = z.object({
  id: z.string(),
  type: z.string(),
  pair: addressSchema,
  timestamp: bigIntStringSchema,
});

export type PairEventRow = z.infer<typeof pairEventRowSchema>;

export const terminalFeedDataSchema = z.object({
  indexedPairs: z.object({
    items: z.array(indexedPairRowSchema),
    pageInfo: pageInfoSchema,
  }),
  pairEvents: z.object({
    items: z.array(pairEventRowSchema),
    pageInfo: pageInfoSchema,
  }),
});

export type TerminalFeedData = z.infer<typeof terminalFeedDataSchema>;

/**
 * One document, two selections, one round trip.
 *
 * Splitting these into two requests would let one succeed and one fail, and the
 * half that succeeded would render as a complete feed. `indexerQuery` refuses a
 * response carrying any error, so a single document keeps the two halves
 * atomic — either both are shown or neither is.
 */
export const TERMINAL_FEED_QUERY = `query TerminalFeed($pairLimit: Int!, $eventLimit: Int!, $pairWhere: indexedPairFilter!, $eventWhere: pairEventFilter!) {
  indexedPairs(where: $pairWhere, limit: $pairLimit) {
    items { id token0 token1 allowed }
    ${PAGE_TAIL}
  }
  pairEvents(where: $eventWhere, orderBy: "timestamp", orderDirection: "desc", limit: $eventLimit) {
    items { id type pair timestamp }
    ${PAGE_TAIL}
  }
  ${INDEXER_META_SELECTION}
}`;

export interface TerminalFeedVariables {
  pairLimit: number;
  eventLimit: number;
  pairWhere: Record<string, unknown>;
  eventWhere: Record<string, unknown>;
}

/**
 * `where` is `{}` and never `null` — Ponder's where-builder iterates the object
 * after an `=== undefined` guard, so an explicit null 500s inside the server and
 * surfaces as an outage of the whole feed. Same rule as lib/indexer/queries.ts.
 */
export function terminalFeedVariables(pairLimit: number, eventLimit: number): TerminalFeedVariables {
  return {
    pairLimit: clampPageLimit(pairLimit),
    eventLimit: clampPageLimit(eventLimit),
    pairWhere: {},
    eventWhere: {},
  };
}

/**
 * Activity for one pair inside the fetched window.
 *
 * `unknown` is NOT "zero trades". It is what a pair with no row in a TRUNCATED
 * event page gets: the page ran out before reaching this pair's rows, so its
 * activity was never looked at. Rendering that as 0 would put a false quiet on a
 * pair that may be the busiest on the venue.
 */
export type PairActivity =
  | {
      state: 'measured';
      events: number;
      /** Oldest row for this pair IN THE WINDOW. Not a creation time. */
      earliestInWindow: bigint;
      latestInWindow: bigint;
    }
  | { state: 'unknown'; reason: string };

export interface TerminalPairRow {
  /** Pair contract address, lowercased by the indexer's `t.hex()` column. */
  pair: string;
  token0: string;
  token1: string;
  activity: PairActivity;
}

export interface TerminalFeed {
  rows: TerminalPairRow[];
  /**
   * Pairs the indexer's own allowlist marked `allowed: false` — junk pairs the
   * factory created that reference no canonical protocol token. Counted rather
   * than dropped silently so the page can state what it withheld.
   */
  excludedPairs: number;
  /** More pairs exist past this page. */
  hasMorePairs: boolean;
  /**
   * The event page was truncated, so every activity figure below is a FLOOR and
   * the earliest timestamp in any row is not a first-seen.
   */
  eventWindowTruncated: boolean;
  /** Bounds of the event page actually read, or null when it came back empty. */
  eventWindow: { from: bigint; to: bigint } | null;
}

const TRUNCATED_REASON =
  'The event page filled before reaching this pair, so its recent activity was not read. This is a gap, not a quiet market.';

export function assembleFeed(data: TerminalFeedData): TerminalFeed {
  const events = data.pairEvents.items;
  const eventWindowTruncated = data.pairEvents.pageInfo.hasNextPage;

  const byPair = new Map<string, { events: number; earliest: bigint; latest: bigint }>();
  for (const ev of events) {
    const key = ev.pair.toLowerCase();
    const existing = byPair.get(key);
    if (!existing) {
      byPair.set(key, { events: 1, earliest: ev.timestamp, latest: ev.timestamp });
      continue;
    }
    existing.events += 1;
    if (ev.timestamp < existing.earliest) existing.earliest = ev.timestamp;
    if (ev.timestamp > existing.latest) existing.latest = ev.timestamp;
  }

  let windowFrom: bigint | null = null;
  let windowTo: bigint | null = null;
  for (const ev of events) {
    if (windowFrom === null || ev.timestamp < windowFrom) windowFrom = ev.timestamp;
    if (windowTo === null || ev.timestamp > windowTo) windowTo = ev.timestamp;
  }

  const allowed = data.indexedPairs.items.filter((p) => p.allowed);
  const excludedPairs = data.indexedPairs.items.length - allowed.length;

  const rows: TerminalPairRow[] = allowed.map((p) => {
    const hit = byPair.get(p.id.toLowerCase());
    if (hit) {
      return {
        pair: p.id,
        token0: p.token0,
        token1: p.token1,
        activity: {
          state: 'measured',
          events: hit.events,
          earliestInWindow: hit.earliest,
          latestInWindow: hit.latest,
        },
      };
    }
    // A complete window that did not mention this pair IS a measurement: zero
    // events between the window's bounds. A truncated one is not.
    if (eventWindowTruncated || windowFrom === null) {
      return {
        pair: p.id,
        token0: p.token0,
        token1: p.token1,
        activity: {
          state: 'unknown',
          reason:
            windowFrom === null
              ? 'No indexed events came back at all, so nothing is known about this pair’s recent activity.'
              : TRUNCATED_REASON,
        },
      };
    }
    return {
      pair: p.id,
      token0: p.token0,
      token1: p.token1,
      activity: { state: 'measured', events: 0, earliestInWindow: windowFrom, latestInWindow: windowTo! },
    };
  });

  return {
    rows,
    excludedPairs,
    hasMorePairs: data.indexedPairs.pageInfo.hasNextPage,
    eventWindowTruncated,
    eventWindow: windowFrom !== null && windowTo !== null ? { from: windowFrom, to: windowTo } : null,
  };
}

/**
 * The non-venue token of a pair, given the venue side.
 *
 * Returns null when neither leg matches — the caller must then show both legs
 * rather than guessing which one a trader meant to buy.
 */
export function counterToken(row: TerminalPairRow, venueTokens: readonly string[]): string | null {
  const venue = new Set(venueTokens.map((t) => t.toLowerCase()));
  const zero = venue.has(row.token0.toLowerCase());
  const one = venue.has(row.token1.toLowerCase());
  if (zero === one) return null;
  return zero ? row.token1 : row.token0;
}
