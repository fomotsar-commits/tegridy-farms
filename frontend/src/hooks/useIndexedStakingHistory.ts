import { useMemo } from 'react';
import {
  INDEXED_STAKING_HISTORY_QUERY,
  indexedStakingHistoryDataSchema,
  indexedStakingHistoryVariables,
  type IndexedStakingAction,
  type IndexedStakingHistoryFilter,
} from '../lib/indexer/queries';
import { useIndexedQuery, type IndexedQueryState } from './useIndexedQuery';

// TegridyStaking position lifecycle, newest first, from the F1 indexer.
//
// One row per stake / withdraw / earlyWithdraw / transfer / claim / extend /
// increase. Two properties of the data a caller has to carry:
//
//   `penalty` is non-null ONLY on earlyWithdraw rows. It is the slashing
//   penalty actually charged, and a surface that shows an early withdrawal
//   without it understates what the position cost.
//
//   `transfer` rows carry amount 0 — the position NFT changed wallets. They
//   belong in a history but not in a sum, and `user` on them is the RECIPIENT.
//
// Ready to mount, wired to no page.

export const DEFAULT_STAKING_HISTORY_LIMIT = 50;

export interface UseIndexedStakingHistoryOptions extends IndexedStakingHistoryFilter {
  /** Rows per page. Clamped to MAX_PAGE_LIMIT by the client. */
  limit?: number;
  /** False parks the hook in `idle` — e.g. before a wallet is connected. */
  enabled?: boolean;
}

export type IndexedStakingHistoryState = IndexedQueryState<IndexedStakingAction>;

export function useIndexedStakingHistory(
  opts: UseIndexedStakingHistoryOptions = {},
): IndexedStakingHistoryState {
  const { user, tokenId, limit = DEFAULT_STAKING_HISTORY_LIMIT, enabled = true } = opts;

  const variables = useMemo(
    () => indexedStakingHistoryVariables({ user, tokenId }, limit),
    [user, tokenId, limit],
  );

  return useIndexedQuery({
    query: INDEXED_STAKING_HISTORY_QUERY,
    variables,
    schema: indexedStakingHistoryDataSchema,
    select: selectStakingActions,
    enabled,
  });
}

function selectStakingActions(data: {
  stakingActions: { items: IndexedStakingAction[]; pageInfo: { hasNextPage: boolean } };
}) {
  return {
    items: data.stakingActions.items,
    hasNextPage: data.stakingActions.pageInfo.hasNextPage,
  };
}
