import { useMemo } from 'react';
import { useIndexedSwaps } from './useIndexedSwaps';
import { useIndexedStakingHistory } from './useIndexedStakingHistory';
import { useWalletLedger, type LedgerRead } from './useWalletLedger';
import type { IndexedStatus } from './useIndexedQuery';
import { isIndexerConfigured } from '../lib/indexer/client';
import { mergeEventSets, stakingToEvents, swapsToEvents, type AdapterOptions, type IncomeEvent } from '../lib/tax/events';
import { ledgerToEvents } from '../lib/tax/ledger';
import type { TaxLotEvent } from '../lib/tax/lots';
import type { CostBasisMethod } from '../lib/tax/methods';
import type { CoverageReadStatus } from '../lib/tax/coverage';
import { buildTaxReport, type ReportCoverageInput, type TaxReport } from '../lib/tax/report';

// The wallet's own history, turned into a tax report.
//
// THE EXPLORER IS THE PRIMARY SOURCE. Ethereum-mainnet history is read through
// /api/etherscan — a same-origin function that ships with every deployment —
// and it returns BOTH legs of a trade in one transaction, so a disposal gets
// real proceeds and an acquisition gets a real cost. See lib/tax/ledger.ts for
// what is classified and, more importantly, for the four things that are
// listed rather than classified.
//
// THE INDEXER IS OPTIONAL ENRICHMENT. With VITE_INDEXER_URL unset it is not
// asked, and a source that was not asked contributes NO coverage gap. That is
// the whole reason coverage is a list here: while the indexer's whole-period
// `unavailable` gap was the only entry, it buried every real finding under a
// permanent "nothing could be read", including on a deployment where the
// explorer read the entire year perfectly.
//
// NOTHING HERE PRICES ANYTHING FROM A FEED. A figure exists when the
// counter-leg was in the same transaction, or when the filer pasted it. There
// is still no historical price source on this deployment, so the quote is ETH
// and converting it to a currency a jurisdiction wants is explicitly the
// filer's job — nothing here does it silently.

/**
 * Rows per read, per indexer table.
 *
 * The client clamps to MAX_PAGE_LIMIT (100). Kept because the indexer path
 * still uses it; the explorer path's own bound is MAX_LEDGER_PAGES x 500 in
 * useWalletLedger, and both turn into declared gaps rather than silence.
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

/** A ledger read state → the vocabulary lib/tax/coverage.ts branches on. */
export function ledgerCoverageStatus(read: LedgerRead): CoverageReadStatus {
  switch (read.status) {
    case 'idle':
      return 'idle';
    case 'loading':
      return 'loading';
    case 'ready':
      return 'ready';
    // A failed read is `unavailable`, never `ready` with no rows: the whole
    // period becomes a declared gap and the export says the read failed.
    case 'failed':
      return 'unavailable';
  }
}

export interface UseTaxReportOptions {
  account: `0x${string}` | null;
  /** Unix seconds, inclusive. */
  periodStart: number;
  periodEnd: number;
  method: CostBasisMethod;
  /** Quote currency the report and the supplied values are denominated in. */
  quoteCurrency?: string;
  /** Minor-unit decimals of that currency. ETH is 18; a fiat currency is 2. */
  quoteScale?: number;
  /** Rows the filer pasted. Merged in and marked `supplied` on the export. */
  supplied?: { lotEvents: TaxLotEvent[]; income: IncomeEvent[] };
  /** Address → symbol / decimals for the INDEXER path; the ledger resolves its own. */
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
  /** How the explorer read is going, for the page's ledger card. */
  ledger: LedgerRead;
  /** Reason from whichever read is the reason. Null when both are fine. */
  detail: string | null;
  reload: () => void;
  /** Epoch ms the explorer read may next be repeated at, or null. */
  nextReloadAt: number | null;
  cooldownSeconds: number;
}

export function useTaxReport(opts: UseTaxReportOptions): UseTaxReportState {
  const {
    account,
    periodStart,
    periodEnd,
    method,
    quoteCurrency = 'ETH',
    quoteScale = 18,
    supplied,
    assets,
    indexedFrom = null,
    enabled = true,
  } = opts;

  const active = enabled && account !== null;
  const indexerOn = isIndexerConfigured();

  const wallet = useWalletLedger({ address: account, enabled: active });
  const swaps = useIndexedSwaps({
    user: account ?? undefined,
    limit: TAX_PAGE_LIMIT,
    enabled: active && indexerOn,
  });
  const staking = useIndexedStakingHistory({
    user: account ?? undefined,
    limit: TAX_PAGE_LIMIT,
    enabled: active && indexerOn,
  });

  const indexerStatus = worstStatus(swaps.status, staking.status);
  // The two vocabularies are the same union by construction — see the note on
  // CoverageReadStatus in lib/tax/coverage.ts — so this assignment is the seam
  // that would stop compiling if either side ever grew a state alone.
  const explorerStatus: IndexedStatus = ledgerCoverageStatus(wallet.read);
  const status = indexerOn ? worstStatus(indexerStatus, explorerStatus) : explorerStatus;
  const detail =
    wallet.read.status === 'failed'
      ? wallet.read.detail
      : indexerOn
        ? (swaps.status === indexerStatus ? swaps.detail : staking.detail)
        : null;

  const report = useMemo(() => {
    const explorerSet =
      wallet.read.status === 'ready'
        ? ledgerToEvents(wallet.read.ledger, { quote: 'eth' })
        : { lotEvents: [], income: [], informational: [], limitations: [] };

    const indexed = indexerOn
      ? mergeEventSets(explorerSet, swapsToEvents(swaps.items, assets), stakingToEvents(staking.items, assets))
      : explorerSet;

    const coverage: ReportCoverageInput[] = [
      {
        source: 'explorer',
        status: ledgerCoverageStatus(wallet.read),
        // The chain's own clock, from the block the read was pinned to.
        syncedAt: wallet.read.status === 'ready' ? wallet.read.head.timestamp : null,
        // Only meaningful when a list truncated; otherwise the read reached the
        // end of history and claiming a cut would invent a gap.
        oldestRowAt: wallet.read.status === 'ready' ? wallet.read.ledger.cut : null,
        truncated: wallet.read.status === 'ready' && wallet.read.ledger.truncated.length > 0,
        indexedFrom: null,
      },
    ];

    if (indexerOn) {
      const timestamps = [
        ...swaps.items.map((s) => Number(s.timestamp)),
        ...staking.items.map((a) => Number(a.timestamp)),
      ];
      coverage.push({
        source: 'indexer',
        status: indexerStatus,
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
      });
    }

    return buildTaxReport({
      periodStart,
      periodEnd,
      method,
      quoteCurrency,
      quoteScale,
      indexed,
      supplied,
      coverage,
      generatedAt: Math.floor(Date.now() / 1000),
      account,
    });
    // `assets` and `supplied` are memoised by the caller; keying on them here
    // would rebuild the whole report on every render of a page that inlines
    // either literal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    wallet.read,
    indexerOn,
    swaps.items,
    staking.items,
    swaps.syncedAt,
    staking.syncedAt,
    swaps.hasMore,
    staking.hasMore,
    indexerStatus,
    periodStart,
    periodEnd,
    method,
    quoteCurrency,
    quoteScale,
    account,
    indexedFrom,
    supplied,
  ]);

  return {
    status,
    report,
    ledger: wallet.read,
    detail,
    nextReloadAt: wallet.nextReloadAt,
    cooldownSeconds: wallet.cooldownSeconds,
    reload: () => {
      wallet.reload();
      if (indexerOn) {
        swaps.reload();
        staking.reload();
      }
    },
  };
}
