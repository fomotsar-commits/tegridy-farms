import { useMemo } from 'react';
import {
  INDEXED_SWAPS_QUERY,
  indexedSwapsDataSchema,
  indexedSwapsVariables,
  type IndexedSwap,
  type IndexedSwapsFilter,
} from '../lib/indexer/queries';
import { useIndexedQuery, type IndexedQueryState } from './useIndexedQuery';

// SwapFeeRouter.SwapExecuted history, newest first, from the F1 indexer.
//
// NOT a substitute for the wallet's own transaction list: this table only holds
// swaps that went through the venue's SwapFeeRouter (indexer/ponder.config.ts).
// A trader who routed around it has no rows here, and the correct reading of an
// empty `ready` result is "no venue-routed swaps", never "no trading".
//
// Ready to mount, wired to no page. Every state it can be in is named in
// IndexedQueryState — a caller that renders `items` without reading `status`
// will present an outage as an empty history, which is the one thing this hook
// is built to stop.

export const DEFAULT_SWAPS_LIMIT = 25;

export interface UseIndexedSwapsOptions extends IndexedSwapsFilter {
  /** Rows per page. Clamped to MAX_PAGE_LIMIT by the client. */
  limit?: number;
  /** False parks the hook in `idle` — e.g. before a wallet is connected. */
  enabled?: boolean;
}

export type IndexedSwapsState = IndexedQueryState<IndexedSwap>;

export function useIndexedSwaps(opts: UseIndexedSwapsOptions = {}): IndexedSwapsState {
  const { user, limit = DEFAULT_SWAPS_LIMIT, enabled = true } = opts;

  const variables = useMemo(
    () => indexedSwapsVariables({ user }, limit),
    [user, limit],
  );

  return useIndexedQuery({
    query: INDEXED_SWAPS_QUERY,
    variables,
    schema: indexedSwapsDataSchema,
    select: selectSwaps,
    enabled,
  });
}

function selectSwaps(data: { swaps: { items: IndexedSwap[]; pageInfo: { hasNextPage: boolean } } }) {
  return { items: data.swaps.items, hasNextPage: data.swaps.pageInfo.hasNextPage };
}
