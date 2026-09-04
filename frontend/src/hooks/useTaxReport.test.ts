// COVERAGE IS PER ENABLED SOURCE — the seam this hook exists to get right.
//
// Before this change there was one source and it was the F1 indexer, which is
// hosted nowhere, so EVERY report on every deployment carried one whole-period
// `indexer-unavailable` gap. That was true, and it was also the thing that made
// the surface useless: the gap said "nothing could be read" on a deployment
// where the explorer could read the entire year perfectly.
//
// So: a source that is not configured is not ASKED, and a source that was not
// asked contributes no gap. A source that was asked and failed contributes one.
// Neither rule may be relaxed into the other — that is what the four cases here
// pin, in both directions.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { LedgerRead } from './useWalletLedger';
import type { WalletLedger } from '../lib/tax/ledger';

const YEAR_START = Date.UTC(2025, 0, 1) / 1000;
const YEAR_END = Date.UTC(2025, 11, 31, 23, 59, 59) / 1000;
const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;

const EMPTY_LEDGER: WalletLedger = {
  wallet: ACCOUNT,
  txs: [],
  cut: null,
  belowCut: 0,
  truncated: [],
  transferCount: 0,
  unreadRows: 0,
};

const state = vi.hoisted(() => ({
  ledger: { status: 'idle' } as LedgerRead,
  indexerConfigured: false,
  indexerStatus: 'unavailable' as 'ready' | 'unavailable',
}));

vi.mock('./useWalletLedger', () => ({
  useWalletLedger: () => ({
    read: state.ledger,
    reload: vi.fn(),
    nextReloadAt: null,
    cooldownSeconds: 0,
  }),
  MAX_LEDGER_PAGES: 4,
  RELOAD_COOLDOWN_SECONDS: 60,
}));

vi.mock('../lib/indexer/client', () => ({
  isIndexerConfigured: () => state.indexerConfigured,
}));

const indexed = () => ({
  status: state.indexerStatus,
  items: [],
  hasMore: false,
  syncedBlock: null,
  syncedAt: state.indexerStatus === 'ready' ? YEAR_END : null,
  detail: state.indexerStatus === 'ready' ? null : 'The indexer could not be reached.',
  reload: vi.fn(),
});

vi.mock('./useIndexedSwaps', () => ({ useIndexedSwaps: () => indexed() }));
vi.mock('./useIndexedStakingHistory', () => ({ useIndexedStakingHistory: () => indexed() }));

import { useTaxReport } from './useTaxReport';

const READY: LedgerRead = {
  status: 'ready',
  ledger: EMPTY_LEDGER,
  head: { block: 21_000_000n, timestamp: YEAR_END },
  pagesRead: { txlist: 1, txlistinternal: 1, tokentx: 1 },
  rowCounts: { txlist: 0, txlistinternal: 0, tokentx: 0 },
};

const render = () =>
  renderHook(() =>
    useTaxReport({ account: ACCOUNT, periodStart: YEAR_START, periodEnd: YEAR_END, method: 'fifo' }),
  );

beforeEach(() => {
  state.ledger = { status: 'idle' };
  state.indexerConfigured = false;
  state.indexerStatus = 'unavailable';
});

describe('an unconfigured indexer no longer buries what the explorer read', () => {
  it('reports a complete period from the explorer alone, with no indexer gap', () => {
    state.ledger = READY;
    const { result } = render();
    expect(result.current.report.coverage.complete).toBe(true);
    expect(result.current.report.coverage.gaps).toEqual([]);
  });

  it('still reports the indexer’s gap once a deployment actually configures one', () => {
    state.ledger = READY;
    state.indexerConfigured = true;
    const { result } = render();
    const gaps = result.current.report.coverage.gaps;
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ source: 'indexer', reason: 'indexer-unavailable' });
  });
});

describe('a failed explorer read is a declared gap, never an empty year', () => {
  it('covers the WHOLE period with an explorer gap and surfaces the reason', () => {
    state.ledger = {
      status: 'failed',
      reason: 'explorer-keyless',
      detail: "memetics.finance can't reach Etherscan right now.",
    };
    const { result } = render();
    const gaps = result.current.report.coverage.gaps;
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      source: 'explorer',
      reason: 'explorer-unavailable',
      from: YEAR_START,
      to: YEAR_END,
    });
    expect(result.current.detail).toMatch(/can't reach Etherscan/);
    expect(result.current.report.usableAsFiled).toBe(false);
  });

  it('reports two failed sources as two gaps once both are enabled', () => {
    state.ledger = { status: 'failed', reason: 'proxy-error', detail: 'Activity service unavailable.' };
    state.indexerConfigured = true;
    const { result } = render();
    expect(result.current.report.coverage.gaps.map((g) => g.source).sort()).toEqual(['explorer', 'indexer']);
    // Two sources failing over one year must not report two years missing.
    expect(result.current.report.coverage.gapSeconds).toBe(YEAR_END - YEAR_START + 1);
  });

  it('says nothing has been read yet while a read is still running', () => {
    state.ledger = { status: 'loading', action: 'tokentx', page: 2 };
    const { result } = render();
    expect(result.current.report.coverage.gaps[0]).toMatchObject({ reason: 'not-read', source: 'explorer' });
  });
});

describe('the report is quoted in the unit the ledger actually reads', () => {
  it('defaults to ETH at 18 places, so a wei figure is never printed as a fiat one', () => {
    state.ledger = READY;
    const { result } = render();
    expect(result.current.report.quoteCurrency).toBe('ETH');
    expect(result.current.report.quoteScale).toBe(18);
  });
});
