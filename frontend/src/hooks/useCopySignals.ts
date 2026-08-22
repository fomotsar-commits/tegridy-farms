import { useEffect, useMemo, useState } from 'react';
import { clampPageLimit } from '../lib/indexer/client';
import { INDEXED_SWAPS_QUERY, indexedSwapsDataSchema, type IndexedSwap } from '../lib/indexer/queries';
import type { FollowConfig } from '../lib/copytrade/follows';
import { planMirrors, type MirrorCandidate } from '../lib/copytrade/mirror';
import { leaderSignalsWhere } from '../lib/copytrade/queries';
import { useIndexedQuery, type IndexedStatus } from './useIndexedQuery';

// Recent trades by the followed wallets, each already turned into a sized mirror
// plan or into the reason there is none.
//
// ─── WHY THIS HOOK RUNS A CLOCK ──────────────────────────────────────────────
//
// The one refusal that matters most — `stale-signal` — is a function of the
// current time, so a `now` captured at mount would keep a two-hour-old trade
// labelled "3 minutes ago" for anyone who left the tab open. That is not a
// cosmetic staleness: it is the page telling a user they are about to copy
// something they are not. The ticker re-plans on a fixed cadence so the age
// shown is the age, and it deliberately does NOT re-issue the query — the window
// the rows were read over is anchored once, and only the judgement about them
// moves.
//
// THE INDEXER IS NOT HOSTED, so with VITE_INDEXER_URL unset this parks in
// `unavailable` and there are no candidates. That is "we could not read what
// this wallet did", never "this wallet has not traded".

export type { IndexedStatus };

export const DEFAULT_SIGNAL_WINDOW_SECONDS = 6 * 60 * 60;
export const DEFAULT_SIGNAL_LIMIT = 50;
export const SIGNAL_CLOCK_INTERVAL_MS = 30_000;

export interface UseCopySignalsOptions {
  follows: readonly FollowConfig[];
  windowSeconds?: number;
  limit?: number;
}

export interface CopySignalsState {
  status: IndexedStatus;
  /** Every read row paired with its plan or refusal. Empty unless `ready`/`backfilling`. */
  candidates: MirrorCandidate[];
  /** The clock the plans were judged against, as unix seconds. */
  now: number;
  since: number;
  syncedAt: number | null;
  detail: string | null;
  reload: () => void;
}

function selectSwaps(data: { swaps: { items: IndexedSwap[]; pageInfo: { hasNextPage: boolean } } }) {
  return { items: data.swaps.items, hasNextPage: data.swaps.pageInfo.hasNextPage };
}

export function useCopySignals(opts: UseCopySignalsOptions): CopySignalsState {
  const { follows, windowSeconds = DEFAULT_SIGNAL_WINDOW_SECONDS, limit = DEFAULT_SIGNAL_LIMIT } = opts;

  const [anchor] = useState(() => Math.floor(Date.now() / 1000));
  const [now, setNow] = useState(anchor);
  const since = anchor - windowSeconds;

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), SIGNAL_CLOCK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const leaderKey = [...new Set(follows.map((f) => f.leader))].sort().join(',');

  const where = useMemo(
    () => leaderSignalsWhere(leaderKey ? leaderKey.split(',') : [], since),
    [leaderKey, since],
  );

  const variables = useMemo(
    () => ({ limit: clampPageLimit(limit), where: where ?? {} }),
    [limit, where],
  );

  const query = useIndexedQuery({
    query: INDEXED_SWAPS_QUERY,
    variables,
    schema: indexedSwapsDataSchema,
    select: selectSwaps,
    // No follows means no leaders to name, and an unfiltered read would be the
    // whole venue's swap feed presented as "wallets you follow".
    enabled: where !== null,
  });

  const candidates = useMemo(
    () => planMirrors(query.items, follows, now),
    [query.items, follows, now],
  );

  return {
    status: query.status,
    candidates,
    now,
    since,
    syncedAt: query.syncedAt,
    detail: query.detail,
    reload: query.reload,
  };
}
