// Season scoring, and the wash-trade rule stated in full.
//
// ─── THE RULE ────────────────────────────────────────────────────────────────
//
// A competitor who trades with themselves must not climb. Concretely, and this
// is the whole of it:
//
//   1. Only swaps that SPEND the season's quote token add to volume. A swap
//      spending anything else is counted as a trade and contributes nothing to
//      the total, because the indexer stores no rate and a cross-token sum would
//      be a number with no unit that still looked like money.
//
//   2. If a wallet reverses one of its own swaps on the same token pair inside
//      WASH_WINDOW_SECONDS — buys X with the quote token, then spends X back for
//      the quote token — BOTH legs are discarded. Not netted, not halved:
//      removed. A round trip moves no position and its only effect on a
//      volume board is the one the board must not reward.
//
// ─── AND WHAT THE RULE DOES NOT CATCH ────────────────────────────────────────
//
// Saying "wash-trade resistant" without saying where the resistance ends is the
// same failure as a fabricated figure, one level up. Two things get through, and
// `RESISTANCE_LIMITS` puts both on the page:
//
//   · TWO WALLETS. An indexed swap row records the trader and the router, never
//     a counterparty (indexer/ponder.schema.ts). One person operating two
//     addresses that trade against each other is invisible here, and no rule
//     written over this table can see them.
//   · SLOW ROUND TRIPS. A reversal outside the window is indistinguishable from
//     a position that was genuinely held and later exited, so it is left alone.
//     Widening the window would start erasing real trading instead.

import type { IndexedSwap } from '../indexer/queries';
import type { Season } from './season';

/**
 * How long a reversal still counts as the same round trip, in seconds.
 *
 * One hour. Short enough that a position held across a session and exited later
 * is treated as trading rather than as a wash; long enough that the obvious
 * pattern — buy and sell back within a few blocks, repeated — is removed on both
 * legs. There is no value here that separates the two cases perfectly, which is
 * why the limit is disclosed rather than tuned quietly.
 */
export const WASH_WINDOW_SECONDS = 3600;

export const RESISTANCE_RULE =
  'A swap and its reversal by the same wallet on the same token pair within one hour are both struck from the score. Selling back what you just bought moves no position, so it earns nothing here.';

export const RESISTANCE_LIMITS =
  'Two limits, stated because a resistance claim without them is worse than none. One person using two wallets to trade against each other is not detectable from this data — an indexed swap records the trader and the router, never a counterparty. And a round trip slower than an hour is left alone, because it cannot be told apart from a position that was genuinely held.';

export const PNL_SCORING =
  'No profit-and-loss board is offered. Indexed swaps record what was spent and never what came back, so a season return cannot be computed for anybody — and a volume rank presented as a performance rank is the claim this page exists not to make.';

export interface CompetitorRow {
  wallet: string;
  /** Quote token spent, in its smallest unit, after the round-trip rule. */
  countedVolume: bigint;
  /** Swaps that survived the rule and spent the quote token. */
  countedTrades: number;
  /** Legs struck by the round-trip rule. Shown, never hidden. */
  washedLegs: number;
  /** Swaps spending something other than the quote token. Counted, never summed. */
  offQuoteTrades: number;
  lastTradeAt: bigint;
}

export interface Standings {
  season: Season;
  rows: CompetitorRow[];
  /** Rows read before scoring. */
  swapsRead: number;
  /** Legs struck across every competitor. */
  washedLegs: number;
  /**
   * The read filled its page, so the window was not fully covered. Totals are
   * floors and the ORDER is provisional — the wallet in first place is first
   * inside one page, which is not the same statement.
   */
  truncated: boolean;
  window: { from: bigint; to: bigint } | null;
}

export const TRUNCATED_NOTICE =
  'The read filled its page before covering the whole season, so these are partial totals over the newest slice of it. The ranking is provisional and a competitor missing from it has not been shown to be absent.';

/**
 * Indices of the swaps struck by the round-trip rule.
 *
 * Separated from the aggregation so the rule can be tested on its own: the
 * question "would this wallet's self-reversal climb the board" has one answer
 * and it must not depend on how a total is later summed.
 *
 * Greedy and oldest-first per wallet. Each leg is consumed once, so three buys
 * followed by one sell strike exactly one buy — the other two are open positions
 * and remain real volume.
 */
export function washedIndices(swaps: readonly IndexedSwap[]): Set<number> {
  const ordered = swaps
    .map((swap, index) => ({ swap, index }))
    .sort((a, b) => Number(a.swap.timestamp - b.swap.timestamp) || a.index - b.index);

  const struck = new Set<number>();
  // wallet → "tokenIn>tokenOut" → indices of legs still open, oldest first.
  const open = new Map<string, Map<string, { index: number; at: number }[]>>();

  for (const { swap, index } of ordered) {
    const wallet = swap.user.toLowerCase();
    const tokenIn = swap.tokenIn.toLowerCase();
    const tokenOut = swap.tokenOut.toLowerCase();
    const at = Number(swap.timestamp);

    let byPair = open.get(wallet);
    if (!byPair) {
      byPair = new Map();
      open.set(wallet, byPair);
    }

    const reverseKey = `${tokenOut}>${tokenIn}`;
    const queue = byPair.get(reverseKey);
    let matched = false;
    if (queue) {
      // Oldest first: entries older than the window can never match anything
      // later either, so they are dropped as they are passed rather than
      // re-scanned on every subsequent swap.
      while (queue.length > 0 && at - queue[0]!.at > WASH_WINDOW_SECONDS) queue.shift();
      const partner = queue.shift();
      if (partner) {
        struck.add(partner.index);
        struck.add(index);
        matched = true;
      }
    }

    if (!matched) {
      const ownKey = `${tokenIn}>${tokenOut}`;
      const ownQueue = byPair.get(ownKey) ?? [];
      ownQueue.push({ index, at });
      byPair.set(ownKey, ownQueue);
    }
  }

  return struck;
}

export interface ScoreOptions {
  season: Season;
  truncated: boolean;
}

export function scoreSeason(swaps: readonly IndexedSwap[], opts: ScoreOptions): Standings {
  const quoteToken = opts.season.quoteToken.toLowerCase();
  const struck = washedIndices(swaps);

  const byWallet = new Map<string, CompetitorRow>();
  let from: bigint | null = null;
  let to: bigint | null = null;

  swaps.forEach((swap, index) => {
    const wallet = swap.user.toLowerCase();
    if (from === null || swap.timestamp < from) from = swap.timestamp;
    if (to === null || swap.timestamp > to) to = swap.timestamp;

    let row = byWallet.get(wallet);
    if (!row) {
      row = {
        wallet,
        countedVolume: 0n,
        countedTrades: 0,
        washedLegs: 0,
        offQuoteTrades: 0,
        lastTradeAt: swap.timestamp,
      };
      byWallet.set(wallet, row);
    }
    if (swap.timestamp > row.lastTradeAt) row.lastTradeAt = swap.timestamp;

    if (struck.has(index)) {
      row.washedLegs += 1;
      return;
    }
    if (swap.tokenIn.toLowerCase() === quoteToken) {
      row.countedVolume += swap.amountIn;
      row.countedTrades += 1;
    } else {
      row.offQuoteTrades += 1;
    }
  });

  const rows = [...byWallet.values()].sort((a, b) => {
    if (a.countedVolume !== b.countedVolume) return a.countedVolume > b.countedVolume ? -1 : 1;
    if (a.countedTrades !== b.countedTrades) return b.countedTrades - a.countedTrades;
    return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
  });

  return {
    season: opts.season,
    rows,
    swapsRead: swaps.length,
    washedLegs: struck.size,
    truncated: opts.truncated,
    window: from !== null && to !== null ? { from, to } : null,
  };
}
