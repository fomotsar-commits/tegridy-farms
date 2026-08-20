import { useMemo } from 'react';
import { useIndexedSwaps } from './useIndexedSwaps';
import { useIndexedStakingHistory } from './useIndexedStakingHistory';
import type { IndexedStatus } from './useIndexedQuery';
import { mergeEventSets, stakingToEvents, swapsToEvents, type AdapterOptions, type IncomeEvent } from '../lib/tax/events';
import type { TaxLotEvent } from '../lib/tax/lots';
import type { CostBasisMethod } from '../lib/tax/methods';
import { buildTaxReport, type TaxReport } from '../lib/tax/report';

// The wallet's own indexed history, turned into a tax report.
//
// TWO READS, ONE COVERAGE STATEMENT. Swaps and staking actions are separate
// tables and each can be in a different state, so the report's coverage takes
// the WORST of the two. If the staking read is fine and the swap read failed,
// the period is not covered — a report that quietly narrowed itself to the half
// that loaded would be the six-weeks-silently-dropped failure with a different
// cause.
//
// THE INDEXER IS NOT HOSTED. With VITE_INDEXER_URL unset both reads park in
// `unavailable`, the whole period is a gap, and the report is a header block
// with no rows. That is the correct output — see lib/tax/coverage.ts — and the
// export says so in its own body rather than relying on the page to have
// mentioned it.
//
// NOTHING HERE PRICES ANYTHING. There is no historical price source on this
// deployment, so every figure that needs one arrives null and stays null. The
// filer supplies those through lib/tax/import.ts.

/**
 * Rows per read, per table.
 *
 * The client clamps to MAX_PAGE_LIMIT (100). A year of trading exceeds that
 * easily, which is exactly why the cap is not hidden: `truncated` becomes a
 * `page-truncated` gap on the export naming the stretch that was never looked
 * at. A silently paged background loop would produce a report that looks whole.
 */
export const TAX_PAGE_LIMIT = 100;

/**
 * Worst of two read states.
 *
 * Ordering is by how much a caller may believe: `unavailable` beats everything,
 * then `backfilling`, then the two states in which nothing was asked, and only
 * two `ready` reads produce a `ready` report.
 */
export function worstStatus(a: IndexedStatus, b: IndexedStatus): IndexedStatus {
  const rank: Record<IndexedStatus, number> = {
    unavailable: 4,
    backfilling: 3,
    loading: 2,
    idle: 1,
    ready: 0,
  };
  return rank[a] >= rank[b] ? a : b;
}

export interface UseTaxReportOptions {
  account: `0x${string}` | null;
  /** Unix seconds, inclusive. */
  periodStart: number;
  periodEnd: number;
  method: CostBasisMethod;
  /** Quote currency the supplied values are denominated in. */
  quoteCurrency?: string;
  /** Rows the filer pasted. Merged in and marked `supplied` on the export. */
  supplied?: { lotEvents: TaxLotEvent[]; income: IncomeEvent[] };
  /** Address → symbol / decimals, so an export is not a wall of hex. */
  assets?: AdapterOptions;
  /**
   * Earliest timestamp this deployment's indexer covers, when the operator has
   * declared one. Left undefined it is null, and the pre-genesis gap simply is
   * not claimed — an invented start date would be a coverage promise nobody made.
   */
  indexedFrom?: number | null;
  enabled?: boolean;
}

export interface UseTaxReportState {
  status: IndexedStatus;
  report: TaxReport;
  /** Reason from whichever read is the reason. Null when both are fine. */
  detail: string | null;
  reload: () => void;
}

export function useTaxReport(opts: UseTaxReportOptions): UseTaxReportState {
  const {
    account,
    periodStart,
    periodEnd,
    method,
    quoteCurrency = 'USD',
    supplied,
    assets,
    indexedFrom = null,
    enabled = true,
  } = opts;

  const active = enabled && account !== null;

  const swaps = useIndexedSwaps({ user: account ?? undefined, limit: TAX_PAGE_LIMIT, enabled: active });
  const staking = useIndexedStakingHistory({
    user: account ?? undefined,
    limit: TAX_PAGE_LIMIT,
    enabled: active,
  });

  const status = worstStatus(swaps.status, staking.status);
  const detail = swaps.status === status ? swaps.detail : staking.detail;

  const report = useMemo(() => {
    const indexed = mergeEventSets(
      swapsToEvents(swaps.items, assets),
      stakingToEvents(staking.items, assets),
    );

    const timestamps = [
      ...swaps.items.map((s) => Number(s.timestamp)),
      ...staking.items.map((a) => Number(a.timestamp)),
    ];

    return buildTaxReport({
      periodStart,
      periodEnd,
      method,
      quoteCurrency,
      indexed,
      supplied,
      coverage: {
        status,
        // Both reads must have reported a head for the report to claim one.
        // Taking the higher of two heads would overstate how far the LAGGING
        // table has been indexed, which is the direction that hides a gap.
        syncedAt:
          swaps.syncedAt === null || staking.syncedAt === null
            ? null
            : Math.min(swaps.syncedAt, staking.syncedAt),
        oldestRowAt: timestamps.length > 0 ? Math.min(...timestamps) : null,
        truncated: swaps.hasMore || staking.hasMore,
        indexedFrom,
      },
      generatedAt: Math.floor(Date.now() / 1000),
      account,
    });
    // `assets` and `supplied` are memoised by the caller; keying on them here
    // would rebuild the whole report on every render of a page that inlines
    // either literal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    swaps.items,
    staking.items,
    swaps.syncedAt,
    staking.syncedAt,
    swaps.hasMore,
    staking.hasMore,
    status,
    periodStart,
    periodEnd,
    method,
    quoteCurrency,
    account,
    indexedFrom,
    supplied,
  ]);

  return {
    status,
    report,
    detail,
    reload: () => {
      swaps.reload();
      staking.reload();
    },
  };
}
