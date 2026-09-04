// The reader's own mirrors, judged against the tape's OWN coverage.
//
// followerRelative.ts reconciles against the indexer, where "the window closed
// and nothing matched" is a fair verdict because the indexer is asked for a
// window and answers for that window. The island tape is not like that: it
// returns whatever GeckoTerminal chose to return for each pool at the moment it
// was read. So the wall clock is the WRONG judge here, and this module never
// consults one — there is no `now` in the verdict path at all.
//
// ─── THREE VERDICTS THAT MUST NOT COLLAPSE INTO ONE ──────────────────────────
//
//   filled        a buy by the reader's own address landed in the same pool
//                 inside the match window.
//   awaiting      the match window extends past the newest fill the tape holds
//                 for that pool. The answer has not been read yet — refresh.
//   unverifiable  the mirror is outside what the tape can see at all: an unread
//                 pool, a pool that returned no fills, or a confirmation older
//                 than the oldest fill the read reached back to.
//   not-filled    the window sits entirely INSIDE coverage and no matching fill
//                 is there. This is the only one that says the mirror did not
//                 happen, and it is the one a copy-trading surface is most
//                 tempted to hand out for free.
//
// Folding 'unverifiable' or 'awaiting' into 'not-filled' would report a personal
// failure rate manufactured by the limits of a third-party feed.
//
// AND STILL NO RETURN. `FOLLOWER_RETURN_UNMEASURABLE` applies here word for word:
// a matched fill gives an entry LAG and a spent amount, never a profit, because
// the exit is not in this data.

import {
  FILL_MATCH_WINDOW_SECONDS,
  type MirrorFillState,
  type FollowerRelativeSummary,
} from './followerRelative';
import type { MirrorIntent } from './follows';
import { poolKeyOf, type IslandTape, type PoolTapeRead, type TapeFill } from './tape';

export const TAPE_MATCH_LIMIT =
  'The tape reaches only as far back as GeckoTerminal returned for each pool, so a mirror older than that can be neither confirmed nor called missed — it is shown as unverifiable.';

export const TAPE_AWAITING =
  'The tape has not been re-read since this mirror was logged — refresh to check.';

/** The indexer's three states plus the one a partial feed makes necessary. */
export type TapeFillState = MirrorFillState | 'unverifiable';

export interface TapeOutcomeRow {
  intent: MirrorIntent;
  state: TapeFillState;
  /**
   * Seconds between the LEADER's fill and the reader's matching fill. The number
   * the whole feature turns on, and it is only ever set on `filled`.
   */
  entryLagSeconds: number | null;
  /** The matched fill's transaction hash, so a reader can check the association. */
  fillTxHash: string | null;
  /** GeckoTerminal's USD valuation of the matched fill, when it gave one. */
  fillUsd: number | null;
  /** Why a row is unverifiable, in one phrase. Null on every other state. */
  unverifiableBecause: string | null;
}

/**
 * What one pool read can actually speak about, in unix seconds.
 *
 * NULL for an unread pool AND for a pool that returned no fills. The second is
 * the conservative half: a zero-fill read proves nothing about a specific
 * transaction, so every mirror on that pool is unverifiable rather than missed.
 *
 * The bounds are the source's OWN block timestamps. `fetchedAt` is deliberately
 * not used to widen them: the feed's documented "last 24 hours" is upstream's
 * claim, not this app's measurement, and treating it as coverage would let a
 * short read call a real mirror missed.
 */
export function coverageOf(read: PoolTapeRead | undefined): { from: number; to: number } | null {
  if (!read || read.status !== 'read') return null;
  if (read.newestAt === null || read.oldestAt === null) return null;
  return { from: read.oldestAt, to: read.newestAt };
}

/** Venue-correct address comparison: hex is case-insensitive, base58 is not. */
function sameAddress(fill: TapeFill, address: string): boolean {
  if (fill.wallet === null) return false;
  return fill.pool.family === 'solana'
    ? fill.wallet === address.trim()
    : fill.wallet === address.trim().toLowerCase();
}

/**
 * Pair every confirmation with its fill, or with the reason it has none.
 *
 * Greedy, oldest confirmation first, and each tape fill is consumed by at most
 * one confirmation. Without that, two confirmations minutes apart would both
 * claim the same fill and the surface would report two mirrors from one trade —
 * a doubled success rate produced by a matching bug.
 */
export function reconcileTapeMirrors(
  intents: readonly MirrorIntent[],
  tape: IslandTape,
): TapeOutcomeRow[] {
  const byPool = new Map<string, PoolTapeRead>();
  for (const read of tape.reads) byPool.set(poolKeyOf(read.pool), read);

  const ordered = [...intents].sort((a, b) => a.confirmedAt - b.confirmedAt);
  const consumed = new Set<string>();

  const rows: TapeOutcomeRow[] = ordered.map((intent) => {
    const unverifiable = (because: string): TapeOutcomeRow => ({
      intent,
      state: 'unverifiable',
      entryLagSeconds: null,
      fillTxHash: null,
      fillUsd: null,
      unverifiableBecause: because,
    });

    if (intent.poolKey === null) {
      return unverifiable('This mirror was logged from the venue router, which the island tape does not read.');
    }
    const read = byPool.get(intent.poolKey);
    if (!read) {
      return unverifiable('This mirror’s pool is not on the island tape any more, so nothing here can judge it.');
    }
    if (read.status !== 'read') {
      return unverifiable('This mirror’s pool could not be read on this pass.');
    }
    const coverage = coverageOf(read);
    if (coverage === null) {
      return unverifiable('This pool returned no fills at all, so it says nothing about this mirror either way.');
    }

    const deadline = intent.confirmedAt + FILL_MATCH_WINDOW_SECONDS;

    // Oldest first so the greedy consume is deterministic, and buys only: a sell
    // by the reader inside the window is not the mirror they logged.
    const ordered_fills = [...read.fills].sort((a, b) => a.at - b.at);
    const hit = ordered_fills.find((fill, i) => {
      const id = `${intent.poolKey}:${i}`;
      if (consumed.has(id)) return false;
      if (fill.side !== 'buy') return false;
      if (!sameAddress(fill, intent.follower)) return false;
      if (fill.pool.baseToken !== intent.tokenOut) return false;
      return fill.at >= intent.confirmedAt && fill.at <= deadline;
    });

    if (hit) {
      consumed.add(`${intent.poolKey}:${ordered_fills.indexOf(hit)}`);
      return {
        intent,
        state: 'filled',
        entryLagSeconds: hit.at - intent.leaderTimestamp,
        fillTxHash: hit.txHash,
        fillUsd: hit.usd,
        unverifiableBecause: null,
      };
    }

    // NO CLOCK HERE. "Still open" means the tape has not been read far enough
    // forward yet, which is a fact about the read and not about the time of day.
    if (deadline > coverage.to) {
      return {
        intent,
        state: 'awaiting',
        entryLagSeconds: null,
        fillTxHash: null,
        fillUsd: null,
        unverifiableBecause: null,
      };
    }
    if (intent.confirmedAt < coverage.from) {
      return unverifiable('This mirror is older than the oldest fill the tape reached back to for this pool.');
    }

    return {
      intent,
      state: 'not-filled',
      entryLagSeconds: null,
      fillTxHash: null,
      fillUsd: null,
      unverifiableBecause: null,
    };
  });

  return rows.sort((a, b) => b.intent.confirmedAt - a.intent.confirmedAt);
}

export interface TapeFollowerSummary extends FollowerRelativeSummary {
  /** Counted on its own line. NEVER added into `notFilled`. */
  unverifiable: number;
}

/**
 * Per-leader realised record for ONE reader.
 *
 * A leader the reader has never mirrored gets no entry at all, rather than an
 * entry full of zeroes. Zero confirmations and zero fills are the same digits as
 * "confirmed ten and filled none", and only one of those is a bad leader.
 */
export function summariseTapeByLeader(rows: readonly TapeOutcomeRow[]): TapeFollowerSummary[] {
  const byLeader = new Map<string, { lags: number[]; summary: TapeFollowerSummary }>();

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
          unverifiable: 0,
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
    } else if (row.state === 'unverifiable') {
      entry.summary.unverifiable += 1;
    } else {
      entry.summary.notFilled += 1;
    }
  }

  const out: TapeFollowerSummary[] = [];
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
