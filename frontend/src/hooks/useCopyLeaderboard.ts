import { useMemo, useState } from 'react';
import { clampPageLimit } from '../lib/indexer/client';
import { INDEXED_SWAPS_QUERY, indexedSwapsDataSchema, type IndexedSwap } from '../lib/indexer/queries';
import {
  DEFAULT_LEADERBOARD_WINDOW_SECONDS,
  buildLeaderboard,
  type Leaderboard,
} from '../lib/copytrade/leaderboard';
import { leaderboardWhere } from '../lib/copytrade/queries';
import { useIndexedQuery, type IndexedStatus } from './useIndexedQuery';

// The follow board, over the F1 indexer.
//
// THE INDEXER IS NOT HOSTED. With VITE_INDEXER_URL unset this parks in
// `unavailable` and emits no request, and the page must render that as "we could
// not read who has been trading" — never as an empty board. An empty
// copy-trading board is a claim that nobody is trading the venue, which is a
// statement about every wallet on the chain produced by a missing environment
// variable.
//
// `board` is null in every state but `ready` and `backfilling`, so a caller that
// draws rows without reading `status` gets nothing to draw.

/** Re-exported so components depend on this hook, not on the shared machine. */
export type { IndexedStatus };

export const DEFAULT_LEADERBOARD_LIMIT = 100;

export interface UseCopyLeaderboardOptions {
  /** The single token amounts are summed in. */
  quoteToken: string;
  /** Left off the board — the viewer's own wallet, when connected. */
  exclude?: readonly string[];
  windowSeconds?: number;
  limit?: number;
  enabled?: boolean;
}

export interface CopyLeaderboardState {
  status: IndexedStatus;
  board: Leaderboard | null;
  /** Start of the window this board covers, as unix seconds. */
  since: number;
  syncedAt: number | null;
  detail: string | null;
  reload: () => void;
}

interface BoardPage {
  swaps: IndexedSwap[];
  hasNextPage: boolean;
}

function selectSwaps(data: { swaps: { items: IndexedSwap[]; pageInfo: { hasNextPage: boolean } } }) {
  return {
    items: [{ swaps: data.swaps.items, hasNextPage: data.swaps.pageInfo.hasNextPage }],
    hasNextPage: data.swaps.pageInfo.hasNextPage,
  };
}

export function useCopyLeaderboard(opts: UseCopyLeaderboardOptions): CopyLeaderboardState {
  const {
    quoteToken,
    exclude,
    windowSeconds = DEFAULT_LEADERBOARD_WINDOW_SECONDS,
    limit = DEFAULT_LEADERBOARD_LIMIT,
    enabled = true,
  } = opts;

  // Anchored ONCE per mount, not read from the clock on every render. The
  // variables object is this effect's dependency key, so a moving `since` would
  // re-issue the query on every render and never settle.
  const [anchor] = useState(() => Math.floor(Date.now() / 1000));
  const since = anchor - windowSeconds;

  const variables = useMemo(
    () => ({ limit: clampPageLimit(limit), where: leaderboardWhere(since) }),
    [limit, since],
  );

  const query = useIndexedQuery({
    query: INDEXED_SWAPS_QUERY,
    variables,
    schema: indexedSwapsDataSchema,
    select: selectSwaps,
    enabled,
  });

  const page: BoardPage | undefined = query.items[0];
  const excludeKey = (exclude ?? []).join(',');

  const board = useMemo(() => {
    if (!page) return null;
    return buildLeaderboard(page.swaps, {
      quoteToken,
      truncated: page.hasNextPage,
      exclude: excludeKey ? excludeKey.split(',') : [],
    });
    // `page` is a fresh object each fetch; `excludeKey` is the structural form of
    // the exclusion list, so a caller rebuilding the array literal each render
    // does not force a re-group.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, quoteToken, excludeKey]);

  return {
    status: query.status,
    board,
    since,
    syncedAt: query.syncedAt,
    detail: query.detail,
    reload: query.reload,
  };
}
