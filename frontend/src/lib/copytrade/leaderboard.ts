// The follow board: which wallets traded the venue lately, ranked by something
// that is actually measurable — and explicitly NOT by return.
//
// ─── THE PRODUCT CLAIM THIS FILE REFUSES TO MAKE ─────────────────────────────
//
// A copy-trading leaderboard ranked by the leaders' own returns is a promise
// made to somebody who will not receive them. The follower sees the trade after
// it happened, buys after the leader bought, and sells after the leader sold; a
// figure earned without that delay describes a trade nobody downstream can take.
// Printing it beside a "Follow" button converts a historical fact about one
// wallet into a forecast about a different one.
//
// So this build does not print it, and the reason it does not is stronger than
// editorial caution — THE NUMBER DOES NOT EXIST HERE. An indexed swap row is
// (user, tokenIn, tokenOut, amountIn, fee, timestamp, txHash); see
// indexer/ponder.schema.ts. There is no output amount and no price on any row,
// so a round trip's proceeds cannot be reconstructed and no realised return can
// be computed for anybody, leader or follower. `RETURN_RANKING` says exactly
// that, in the words the surface renders.
//
// What IS measurable from those columns is how much of one named quote token a
// wallet put through the venue, how often, and when. That is activity. It is
// ranked, and it is labelled activity everywhere it appears.
//
// ─── AND THE WINDOW IS A FLOOR ───────────────────────────────────────────────
//
// The indexer client caps a page at MAX_PAGE_LIMIT rows. When the page fills,
// the wallets below the cut are not quieter — they are unread, and the ordering
// itself is provisional. `truncated` carries that up to the surface rather than
// letting a partial read render as a complete ranking.

import type { IndexedSwap } from '../indexer/queries';

export interface ReturnRankingVerdict {
  /**
   * Constant `false` in this build, and it is not a placeholder for a value that
   * is coming. See the header: the inputs a return needs are not columns on the
   * indexed row, so there is nothing to switch on. When the indexer starts
   * recording an output amount this becomes a real decision and this type is
   * where it goes.
   */
  ranked: false;
  reason: string;
  rankedInstead: string;
}

export const RETURN_RANKING: ReturnRankingVerdict = {
  ranked: false,
  reason:
    'No wallet on this board is ranked by profit. Indexed swaps record what was spent, never what came back, so no realised return can be computed — and a leader’s return would not be yours in any case: you would enter after them and exit after them.',
  rankedInstead:
    'Ranked by quote-token spent through the venue inside the window below. That is a measure of activity, not of skill and not of outcome.',
};

/** Default lookback for the board, in seconds. */
export const DEFAULT_LEADERBOARD_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export interface LeaderRow {
  /** Lowercased wallet address. */
  leader: string;
  /** Venue-routed swaps by this wallet inside the rows that were read. */
  trades: number;
  /**
   * Sum of `amountIn` over swaps whose `tokenIn` IS the quote token, in that
   * token's smallest unit. Legs denominated in anything else are not added in:
   * the indexer stores no rate, so summing across tokens would produce a number
   * with no unit that still looked like money.
   */
  quoteDeployed: bigint;
  /** Swaps by this wallet spending something other than the quote token. */
  offQuoteTrades: number;
  /** Distinct `tokenOut` values bought with the quote token. */
  tokensBought: number;
  /** Unix seconds of the oldest / newest row read for this wallet. */
  firstSeen: bigint;
  lastSeen: bigint;
}

export interface Leaderboard {
  quoteToken: string;
  rows: LeaderRow[];
  /** Bounds of the rows actually read, or null when none came back. */
  window: { from: bigint; to: bigint } | null;
  /** Total rows read, before grouping. */
  swapsRead: number;
  /**
   * The page filled. Wallets outside it were not measured and not ranked, so
   * every figure below is a floor and the ORDER is provisional too.
   */
  truncated: boolean;
}

export const TRUNCATED_NOTICE =
  'The read filled its page, so wallets below the cut were never looked at. Every figure here is a floor and the order is provisional — this is not the venue’s busiest wallets, it is the busiest inside one page.';

export interface BuildLeaderboardOptions {
  /** The one token amounts are summed in. Lowercased internally. */
  quoteToken: string;
  /** True when the underlying page reported more rows past it. */
  truncated: boolean;
  /** Wallets to leave off — the viewer's own, so the board is other people. */
  exclude?: readonly string[];
}

/**
 * Group swap rows into board rows.
 *
 * Deterministic ordering, including the tie-breaks: two wallets with the same
 * deployed amount would otherwise swap places between renders of identical data,
 * which reads as movement on a board where movement is supposed to mean
 * something.
 */
export function buildLeaderboard(
  swaps: readonly IndexedSwap[],
  opts: BuildLeaderboardOptions,
): Leaderboard {
  const quoteToken = opts.quoteToken.toLowerCase();
  const excluded = new Set((opts.exclude ?? []).map((a) => a.toLowerCase()));

  const byLeader = new Map<string, { row: LeaderRow; tokens: Set<string> }>();
  let from: bigint | null = null;
  let to: bigint | null = null;
  let read = 0;

  for (const swap of swaps) {
    const leader = swap.user.toLowerCase();
    read += 1;
    if (from === null || swap.timestamp < from) from = swap.timestamp;
    if (to === null || swap.timestamp > to) to = swap.timestamp;
    if (excluded.has(leader)) continue;

    let entry = byLeader.get(leader);
    if (!entry) {
      entry = {
        row: {
          leader,
          trades: 0,
          quoteDeployed: 0n,
          offQuoteTrades: 0,
          tokensBought: 0,
          firstSeen: swap.timestamp,
          lastSeen: swap.timestamp,
        },
        tokens: new Set<string>(),
      };
      byLeader.set(leader, entry);
    }

    entry.row.trades += 1;
    if (swap.timestamp < entry.row.firstSeen) entry.row.firstSeen = swap.timestamp;
    if (swap.timestamp > entry.row.lastSeen) entry.row.lastSeen = swap.timestamp;

    if (swap.tokenIn.toLowerCase() === quoteToken) {
      entry.row.quoteDeployed += swap.amountIn;
      entry.tokens.add(swap.tokenOut.toLowerCase());
    } else {
      entry.row.offQuoteTrades += 1;
    }
  }

  const rows = [...byLeader.values()].map(({ row, tokens }) => ({ ...row, tokensBought: tokens.size }));
  rows.sort((a, b) => {
    if (a.quoteDeployed !== b.quoteDeployed) return a.quoteDeployed > b.quoteDeployed ? -1 : 1;
    if (a.trades !== b.trades) return b.trades - a.trades;
    return a.leader < b.leader ? -1 : a.leader > b.leader ? 1 : 0;
  });

  return {
    quoteToken,
    rows,
    window: from !== null && to !== null ? { from, to } : null,
    swapsRead: read,
    truncated: opts.truncated,
  };
}
