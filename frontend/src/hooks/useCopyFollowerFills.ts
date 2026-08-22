import { useMemo, useState } from 'react';
import { clampPageLimit } from '../lib/indexer/client';
import { INDEXED_SWAPS_QUERY, indexedSwapsDataSchema, type IndexedSwap } from '../lib/indexer/queries';
import type { MirrorIntent } from '../lib/copytrade/follows';
import {
  reconcileMirrors,
  summariseByLeader,
  type FollowerRelativeSummary,
  type MirrorOutcomeRow,
} from '../lib/copytrade/followerRelative';
import { followerFillsWhere } from '../lib/copytrade/queries';
import { useIndexedQuery, type IndexedStatus } from './useIndexedQuery';

// The follower's own venue swaps, reconciled against the mirrors they confirmed.
//
// This is the only surface in the copy-trading slice that reports a REALISED
// follower-relative number, and the number is a lag, not a return — see
// lib/copytrade/followerRelative.ts for why no return exists in this data at all.
//
// THE UNAVAILABLE STATE IS THE DANGEROUS ONE HERE, and in a different direction
// from the rest of the slice: with no indexer, no confirmed mirror can be shown
// to have filled, and a naive reading of that is "none of your mirrors worked".
// So `outcomes` is empty in every state but `ready`/`backfilling`, and the caller
// renders the status rather than the counts. Unread is not unfilled.

export type { IndexedStatus };

export const DEFAULT_FILLS_LIMIT = 100;

/**
 * How far back the follower's own swaps are read.
 *
 * Wider than the mirror-match window because the intents being reconciled can be
 * days old; the match rule itself still only credits a swap inside
 * FILL_MATCH_WINDOW_SECONDS of its confirmation.
 */
export const DEFAULT_FILLS_WINDOW_SECONDS = 30 * 24 * 60 * 60;

export interface UseCopyFollowerFillsOptions {
  /** The connected wallet, or null/undefined when there is none. */
  follower?: string | null;
  intents: readonly MirrorIntent[];
  windowSeconds?: number;
  limit?: number;
}

export interface CopyFollowerFillsState {
  status: IndexedStatus;
  /** One row per confirmed mirror. Empty unless `ready`/`backfilling`. */
  outcomes: MirrorOutcomeRow[];
  /** Per-leader realised record for this wallet. */
  byLeader: FollowerRelativeSummary[];
  syncedAt: number | null;
  detail: string | null;
  reload: () => void;
}

function selectSwaps(data: { swaps: { items: IndexedSwap[]; pageInfo: { hasNextPage: boolean } } }) {
  return { items: data.swaps.items, hasNextPage: data.swaps.pageInfo.hasNextPage };
}

export function useCopyFollowerFills(opts: UseCopyFollowerFillsOptions): CopyFollowerFillsState {
  const {
    follower,
    intents,
    windowSeconds = DEFAULT_FILLS_WINDOW_SECONDS,
    limit = DEFAULT_FILLS_LIMIT,
  } = opts;

  const [anchor] = useState(() => Math.floor(Date.now() / 1000));
  const since = anchor - windowSeconds;
  const account = follower ? follower.toLowerCase() : null;

  const variables = useMemo(
    () => ({
      limit: clampPageLimit(limit),
      where: account ? followerFillsWhere(account, since) : {},
    }),
    [account, limit, since],
  );

  const query = useIndexedQuery({
    query: INDEXED_SWAPS_QUERY,
    variables,
    schema: indexedSwapsDataSchema,
    select: selectSwaps,
    // With no wallet there is no `user` to filter on, and an unfiltered read
    // would be the whole venue's swaps reconciled against this browser's
    // intents — every mirror would "fill" against a stranger's trade.
    enabled: account !== null && intents.length > 0,
  });

  const mine = useMemo(
    () => (account ? intents.filter((i) => i.follower === account) : []),
    [account, intents],
  );

  const outcomes = useMemo(
    () => reconcileMirrors(mine, query.items, anchor),
    [mine, query.items, anchor],
  );

  const byLeader = useMemo(() => summariseByLeader(outcomes), [outcomes]);

  return {
    status: query.status,
    outcomes: query.status === 'ready' || query.status === 'backfilling' ? outcomes : [],
    byLeader: query.status === 'ready' || query.status === 'backfilling' ? byLeader : [],
    syncedAt: query.syncedAt,
    detail: query.detail,
    reload: query.reload,
  };
}
