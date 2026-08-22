import { useMemo } from 'react';
import { clampPageLimit } from '../lib/indexer/client';
import { INDEXED_SWAPS_QUERY, indexedSwapsDataSchema, type IndexedSwap } from '../lib/indexer/queries';
import { scoreSeason, type Standings } from '../lib/competitions/scoring';
import { seasonWhere, type Season } from '../lib/competitions/season';
import { useIndexedQuery, type IndexedStatus } from './useIndexedQuery';

// Season standings, scored from indexed swaps at read time.
//
// THERE IS NO STORED STANDING AND NO KEEPER THAT WRITES ONE. Every figure here
// is recomputed from the indexed window on each read, which is why an "ended"
// season is not a settled one — see lib/competitions/season.ts.
//
// THE INDEXER IS NOT HOSTED. With VITE_INDEXER_URL unset this parks in
// `unavailable` and `standings` is null, and the page must say the board could
// not be read. An empty leaderboard under a season name asserts that nobody
// entered, and on a competition page that is the most damaging fabricated zero
// available: it is a statement about every competitor at once.

export type { IndexedStatus };

/**
 * Rows per read.
 *
 * The client clamps to MAX_PAGE_LIMIT (100), which is far smaller than a real
 * season's swap count. That is not hidden by paging quietly in the background —
 * `standings.truncated` carries it to the surface, because a partial page ranked
 * as a full season is a wrong winner, not a slow one.
 */
export const DEFAULT_STANDINGS_LIMIT = 100;

export interface UseCompetitionStandingsOptions {
  /**
   * Null when this build declares no season. The hook parks in `idle` rather
   * than being handed a stand-in: a placeholder season would produce a real
   * query over invented dates and a board nobody could trace to a rule.
   */
  season: Season | null;
  limit?: number;
  enabled?: boolean;
}

export interface CompetitionStandingsState {
  status: IndexedStatus;
  /** Null in every state but `ready` and `backfilling`. */
  standings: Standings | null;
  syncedAt: number | null;
  detail: string | null;
  reload: () => void;
}

interface StandingsPage {
  swaps: IndexedSwap[];
  hasNextPage: boolean;
}

function selectSwaps(data: { swaps: { items: IndexedSwap[]; pageInfo: { hasNextPage: boolean } } }) {
  return {
    items: [{ swaps: data.swaps.items, hasNextPage: data.swaps.pageInfo.hasNextPage }],
    hasNextPage: data.swaps.pageInfo.hasNextPage,
  };
}

export function useCompetitionStandings(
  opts: UseCompetitionStandingsOptions,
): CompetitionStandingsState {
  const { season, limit = DEFAULT_STANDINGS_LIMIT, enabled = true } = opts;

  const variables = useMemo(
    () => ({ limit: clampPageLimit(limit), where: season ? seasonWhere(season) : {} }),
    [limit, season],
  );

  const query = useIndexedQuery({
    query: INDEXED_SWAPS_QUERY,
    variables,
    schema: indexedSwapsDataSchema,
    select: selectSwaps,
    enabled: enabled && season !== null,
  });

  const page: StandingsPage | undefined = query.items[0];

  const standings = useMemo(
    () => (page && season ? scoreSeason(page.swaps, { season, truncated: page.hasNextPage }) : null),
    [page, season],
  );

  return {
    status: query.status,
    standings,
    syncedAt: query.syncedAt,
    detail: query.detail,
    reload: query.reload,
  };
}
