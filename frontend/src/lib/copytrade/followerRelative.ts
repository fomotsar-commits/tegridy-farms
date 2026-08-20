// The only follower-relative thing this venue can actually measure: how late you
// were, and whether the mirror happened at all.
//
// The leaderboard cannot rank by return because no indexed row carries an output
// amount (see leaderboard.ts). That absence applies to the follower too, so this
// module does NOT produce a follower return, a slippage cost or an
// underperformance figure — those would each need a price, and there is no price
// anywhere in this data path.
//
// What it produces instead is realised and is the thing the copy-trading pitch
// actually hides: the gap between the leader's trade and yours, measured on real
// rows rather than assumed to be zero, plus the count of confirmations that never
// became a trade. Both are outcomes. Neither is a return, and every export here
// is named so that it cannot be read as one.
//
// ─── THE MATCH IS AN ASSOCIATION, NOT A RECEIPT ──────────────────────────────
//
// A mirror is a transaction the user signs in their own wallet. Nothing marks it
// on chain as a mirror, and this repo holds no key and submits nothing, so the
// only way to connect a confirmation to a fill is to look for a swap by the same
// wallet, on the same token pair, inside a window after the confirmation. A user
// who happened to make that exact trade for their own reasons would be matched
// too. `MATCH_BASIS` states that wherever a lag is shown; a measurement whose
// method is hidden is a measurement nobody can check.

import type { IndexedSwap } from '../indexer/queries';
import type { MirrorIntent } from './follows';

export const MATCH_BASIS =
  'A confirmation is matched to a fill by wallet, token pair and time — nothing marks a swap on chain as a mirror. A trade you made for your own reasons on the same pair inside the window would be counted as one.';

export const FOLLOWER_RETURN_UNMEASURABLE =
  'No profit or loss is shown for a mirror. Indexed swaps record what was spent and never what came back, so neither your return nor the leader’s can be computed — and a comparison of the two is the number a copy-trading board is expected to show and the one nobody here can honestly produce.';

/**
 * How long after a confirmation a matching swap is still credited to it.
 *
 * Long enough for a user to read the plan, open a wallet and wait for inclusion;
 * short enough that an unrelated trade made an hour later is not swept in. Past
 * it a confirmation is reported as not filled, which is a real outcome and the
 * one a copy-trading surface is most tempted to leave out.
 */
export const FILL_MATCH_WINDOW_SECONDS = 1800;

export type MirrorFillState =
  /** A swap on the same pair landed inside the window. */
  | 'filled'
  /** The window is still open, so nothing is concluded yet. */
  | 'awaiting'
  /** The window closed with no matching swap. The mirror did not happen. */
  | 'not-filled';

export interface MirrorOutcomeRow {
  intent: MirrorIntent;
  state: MirrorFillState;
  /**
   * Seconds between the LEADER's trade and the follower's matching swap. The
   * number the whole feature turns on, and it is only ever set on `filled`.
   */
  entryLagSeconds: number | null;
  /** What the follower actually spent, in the quote token's smallest unit. */
  filledAmountIn: bigint | null;
  /** The matched swap's transaction hash, so a reader can check the association. */
  fillTxHash: string | null;
}

/**
 * Pair every confirmation with its fill, or with the reason it has none.
 *
 * Greedy, oldest confirmation first, and each follower swap is consumed by at
 * most one confirmation. Without that, two confirmations minutes apart would
 * both claim the same swap and the surface would report two fills from one
 * trade — a doubled success rate produced by a matching bug.
 */
export function reconcileMirrors(
  intents: readonly MirrorIntent[],
  followerSwaps: readonly IndexedSwap[],
  now: number,
): MirrorOutcomeRow[] {
  const ordered = [...intents].sort((a, b) => a.confirmedAt - b.confirmedAt);
  const candidates = [...followerSwaps].sort((a, b) => Number(a.timestamp - b.timestamp));
  const consumed = new Set<string>();

  const rows: MirrorOutcomeRow[] = ordered.map((intent) => {
    const deadline = intent.confirmedAt + FILL_MATCH_WINDOW_SECONDS;

    const hit = candidates.find((swap) => {
      if (consumed.has(swap.id)) return false;
      if (swap.user.toLowerCase() !== intent.follower) return false;
      if (swap.tokenIn.toLowerCase() !== intent.quoteToken) return false;
      if (swap.tokenOut.toLowerCase() !== intent.tokenOut) return false;
      const ts = Number(swap.timestamp);
      return ts >= intent.confirmedAt && ts <= deadline;
    });

    if (hit) {
      consumed.add(hit.id);
      return {
        intent,
        state: 'filled',
        entryLagSeconds: Number(hit.timestamp) - intent.leaderTimestamp,
        filledAmountIn: hit.amountIn,
        fillTxHash: hit.txHash,
      };
    }

    return {
      intent,
      state: now <= deadline ? 'awaiting' : 'not-filled',
      entryLagSeconds: null,
      filledAmountIn: null,
      fillTxHash: null,
    };
  });

  return rows.sort((a, b) => b.intent.confirmedAt - a.intent.confirmedAt);
}

export interface FollowerRelativeSummary {
  leader: string;
  confirmed: number;
  filled: number;
  awaiting: number;
  notFilled: number;
  /** Null when nothing filled — an unmeasured lag is never reported as zero. */
  medianEntryLagSeconds: number | null;
  worstEntryLagSeconds: number | null;
}

/**
 * Per-leader realised record for ONE follower.
 *
 * A leader the user has never mirrored gets no entry here at all, rather than an
 * entry full of zeroes. Zero confirmations and zero fills are the same digits as
 * "confirmed ten and filled none", and only one of those is a bad leader.
 */
export function summariseByLeader(rows: readonly MirrorOutcomeRow[]): FollowerRelativeSummary[] {
  const byLeader = new Map<string, { lags: number[]; summary: FollowerRelativeSummary }>();

  for (const row of rows) {
    const leader = row.intent.leader;
    let entry = byLeader.get(leader);
    if (!entry) {
      entry = {
        lags: [],
        summary: {
          leader,
          confirmed: 0,
          filled: 0,
          awaiting: 0,
          notFilled: 0,
          medianEntryLagSeconds: null,
          worstEntryLagSeconds: null,
        },
      };
      byLeader.set(leader, entry);
    }
    entry.summary.confirmed += 1;
    if (row.state === 'filled') {
      entry.summary.filled += 1;
      if (row.entryLagSeconds !== null) entry.lags.push(row.entryLagSeconds);
    } else if (row.state === 'awaiting') {
      entry.summary.awaiting += 1;
    } else {
      entry.summary.notFilled += 1;
    }
  }

  const out: FollowerRelativeSummary[] = [];
  for (const { lags, summary } of byLeader.values()) {
    if (lags.length > 0) {
      summary.medianEntryLagSeconds = median(lags);
      summary.worstEntryLagSeconds = Math.max(...lags);
    }
    out.push(summary);
  }
  return out.sort((a, b) => b.confirmed - a.confirmed || (a.leader < b.leader ? -1 : 1));
}

/**
 * Upper median on an even count.
 *
 * Not the average of the middle two, and not the lower one: a bigger lag is a
 * worse outcome for the follower, so rounding the tie downward would round this
 * figure toward the flattering side of its own subject.
 */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
