import { useMemo } from 'react';
import {
  PAIR_SWAPS_QUERY,
  pairSwapsDataSchema,
  pairSwapsVariables,
  priceSwapRow,
  type PairPricing,
  type PairSwapRow,
  type PairSwapsData,
} from '../lib/chart/pairSwaps';
import { buildCandleSeries, type CandleSeries, type Trade } from '../lib/chart/candles';
import { timeframeOf, type TimeframeId } from '../lib/chart/timeframes';
import { useIndexedQuery, type IndexedStatus } from './useIndexedQuery';

// Candles for one TegridyPair, over the F1 indexer.
//
// THE INDEXER IS NOT HOSTED. With VITE_INDEXER_URL unset this hook parks in
// `unavailable` and never emits a request, and `series` stays null in that state
// — not an empty series. The difference is the whole feature: an empty candle
// series and an unreachable indexer both draw as a blank chart, and only one of
// them is a statement about the market. A caller that reads `series` without
// reading `status` cannot make that mistake here, because there is nothing to
// read until the answer is real.
//
// The window is ONE page of swaps, newest first — there is no cursor walk. So
// the chart covers "the last N indexed swaps", never "all history", and
// `series.droppedOldestBucket` records the bucket the page cut through. See
// lib/chart/candles.ts for why that bucket is removed rather than drawn short.
//
// BUCKETING HAPPENS HERE, NOT IN `select`. useIndexedQuery deliberately keeps
// `select` out of its effect dependencies, so a select that closed over the
// timeframe would keep re-running the OLD bucket size after a timeframe switch —
// the chart would relabel itself without recomputing, which is a chart claiming
// a resolution it does not have. The fetch depends on the pair; the maths
// depends on the timeframe; they are separated so each re-runs on its own input.

/** Re-exported so chart components depend on this hook, not on the shared machine. */
export type { IndexedStatus };

/**
 * One page of swaps per chart.
 *
 * `clampPageLimit` caps it at MAX_PAGE_LIMIT anyway; asking for the cap makes
 * the covered window as wide as a single round trip can make it, which is the
 * only lever available without pagination.
 */
export const DEFAULT_SWAP_PAGE = 100;

export interface UseChartCandlesOptions {
  /** TegridyPair address. Empty or absent parks the hook in `idle`. */
  pair?: string | null;
  /** Which leg is the quote, and both legs' decimals. Resolved by lib/chart/pairTokens.ts. */
  pricing: PairPricing;
  timeframe: TimeframeId;
  limit?: number;
  enabled?: boolean;
}

export interface ChartCandlesState {
  status: IndexedStatus;
  /** Null in every state but `ready` and `backfilling`. */
  series: CandleSeries | null;
  /** Swap rows in the page this series was built from. */
  swapsRead: number;
  /** Rows the pricing step declined. Surfaced so a shorter series is explained. */
  unpriceable: number;
  /** Older swaps exist behind this page: the chart's left edge is a cut, not a start. */
  truncated: boolean;
  syncedBlock: number | null;
  syncedAt: number | null;
  detail: string | null;
  reload: () => void;
}

/** Module-level and stable — see the note above about `select` and the effect. */
function selectRows(data: PairSwapsData): { items: PairSwapRow[]; hasNextPage: boolean } {
  return { items: data.pairEvents.items, hasNextPage: data.pairEvents.pageInfo.hasNextPage };
}

export function useChartCandles(opts: UseChartCandlesOptions): ChartCandlesState {
  const { pair, pricing, timeframe, limit = DEFAULT_SWAP_PAGE, enabled = true } = opts;

  const hasPair = typeof pair === 'string' && pair.trim().length > 0;

  const variables = useMemo(
    // The placeholder address is never sent: `enabled` is false without a pair,
    // so the hook parks in `idle` before any request is built.
    () => pairSwapsVariables(hasPair ? pair!.trim() : '0x0000000000000000000000000000000000000000', limit),
    [hasPair, pair, limit],
  );

  const query = useIndexedQuery<PairSwapsData, PairSwapRow>({
    query: PAIR_SWAPS_QUERY,
    variables: variables as unknown as Record<string, unknown>,
    schema: pairSwapsDataSchema,
    select: selectRows,
    enabled: enabled && hasPair,
  });

  const bucketSeconds = timeframeOf(timeframe).bucketSeconds;
  const answered = query.status === 'ready' || query.status === 'backfilling';
  const rows = query.items;

  const built = useMemo(() => {
    if (!answered) return null;
    const trades: Trade[] = [];
    let unpriceable = 0;
    for (const row of rows) {
      const trade = priceSwapRow(row, pricing);
      if (trade) trades.push(trade);
      else unpriceable += 1;
    }
    return {
      series: buildCandleSeries(trades, bucketSeconds, { truncated: query.hasMore }),
      unpriceable,
    };
  }, [answered, rows, pricing, bucketSeconds, query.hasMore]);

  return {
    status: query.status,
    series: built?.series ?? null,
    swapsRead: answered ? rows.length : 0,
    unpriceable: built?.unpriceable ?? 0,
    truncated: answered ? query.hasMore : false,
    syncedBlock: query.syncedBlock,
    syncedAt: query.syncedAt,
    detail: query.detail,
    reload: query.reload,
  };
}
