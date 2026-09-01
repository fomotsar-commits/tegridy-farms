import { useMemo, useState } from 'react';
import { usePageTitle } from '../hooks/usePageTitle';
import { useTerminalFeed } from '../hooks/useTerminalFeed';
import { useTerminalSafety } from '../hooks/useTerminalSafety';
import { useTerminalWatchlist } from '../hooks/useTerminalWatchlist';
import { counterToken, type TerminalPairRow } from '../lib/terminal/feed';
import {
  SAFETY_FILTER_LABELS,
  SAFETY_NOT_REQUESTED,
  passesSafetyFilter,
  sortBySafety,
  type RowSafety,
  type SafetyFilter,
  type SafetySortDirection,
} from '../lib/terminal/rowSafety';
import { TOWELI_ADDRESS, WETH_ADDRESS } from '../lib/constants';
import { FeedStatus } from '../components/terminal/FeedStatus';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { PairTable } from '../components/terminal/PairTable';
import { QuickBuyPanel } from '../components/terminal/QuickBuyPanel';
import { SafetyInspector } from '../components/terminal/SafetyInspector';

// THE PRO TERMINAL — a discovery feed where every row carries its risk read.
//
// The differentiator is not the feed; anyone can list pairs. It is that a row
// here states whether it was actually READ. Two rules hold the whole page up and
// both are enforced in lib/terminal/rowSafety.ts rather than in this file, so
// they cannot be edited away by a layout change:
//
//   1. Only a fully-read row can be green, and the green badge and the "fully
//      read" filter go through the same predicate.
//   2. A row that could not be read has no position on the safety axis. It
//      sorts to the end under BOTH directions rather than taking the flattering
//      end of one.
//
// And the feed itself: with no indexer hosted this page renders the unavailable
// banner and NO TABLE. An empty table on a new-pair feed asserts that nothing is
// launching — a claim about the entire chain, produced by a missing environment
// variable.

const VENUE_TOKENS = [WETH_ADDRESS, TOWELI_ADDRESS];

export default function TerminalPage() {
  usePageTitle(
    'Pro Terminal',
    'A live pair feed where every row carries its safety read — holder concentration and deployer history — and a row that could not be read says so instead of showing green.',
  );

  const feed = useTerminalFeed();
  const watchlist = useTerminalWatchlist();

  const [selectedPair, setSelectedPair] = useState<string | null>(null);
  const [deployer, setDeployer] = useState('');
  const [filter, setFilter] = useState<SafetyFilter>('all');
  const [direction, setDirection] = useState<SafetySortDirection>('safest-first');
  const [watchedOnly, setWatchedOnly] = useState(false);

  const rows = feed.feed?.rows ?? [];

  const selectedRow = useMemo(
    () => rows.find((r) => r.pair.toLowerCase() === (selectedPair ?? '').toLowerCase()) ?? null,
    [rows, selectedPair],
  );

  // The token a trader would buy is the non-venue leg. When neither leg is a
  // venue token the pair is not one this build can name a target for, so nothing
  // is guessed — the quick-buy panel simply has no token.
  const selectedToken = selectedRow ? counterToken(selectedRow, VENUE_TOKENS) : null;

  const live = useTerminalSafety({ token: selectedToken ?? '', deployer });

  // Exactly one row is live-scored. Every other row is explicitly unscored, and
  // that is the resting state rather than an optimistic one.
  const safetyOf = useMemo(() => {
    const selected = (selectedPair ?? '').toLowerCase();
    return (row: TerminalPairRow): RowSafety =>
      row.pair.toLowerCase() === selected && selectedToken ? live.safety : SAFETY_NOT_REQUESTED;
  }, [selectedPair, selectedToken, live.safety]);

  const visible = useMemo(() => {
    const filtered = rows.filter((row) => {
      if (watchedOnly && !watchlist.isWatched(row.pair)) return false;
      return passesSafetyFilter(safetyOf(row), filter);
    });
    return sortBySafety(filtered, safetyOf, direction);
  }, [rows, watchedOnly, watchlist, filter, direction, safetyOf]);

  const showTable = feed.status === 'ready' || feed.status === 'backfilling';

  return (
    <div className="relative min-h-screen">
      {/* ART 2026-09-01: this page rendered no art surface at all, so it was
          invisible to both studios — a skin could not touch it. */}
      <PageArtBackdrop pageId="terminal" />
      <div className="relative z-10 mx-auto w-full max-w-7xl px-4 py-8">
        <header>
          <h1 className="text-2xl font-bold text-white">Pro Terminal</h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/75">
            Every row here carries a safety read or says that it does not have one. A row that could
            not be scored is never ranked among the scored ones and never shows a pass — an
            unreachable scanner is not a clean token.
          </p>
        </header>

        <div className="mt-6">
          <FeedStatus
            status={feed.status}
            detail={feed.detail}
            feed={feed.feed}
            syncedAt={feed.syncedAt}
            onRetry={feed.reload}
          />
        </div>

        {showTable ? (
          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-[11px] font-medium uppercase tracking-wide text-white/60">
                  Safety filter
                  <select
                    value={filter}
                    onChange={(e) => setFilter(e.target.value as SafetyFilter)}
                    className="mt-1 block rounded-md border border-white/20 bg-black/40 px-2 py-1 text-xs text-white"
                  >
                    {(Object.keys(SAFETY_FILTER_LABELS) as SafetyFilter[]).map((key) => (
                      <option key={key} value={key}>
                        {SAFETY_FILTER_LABELS[key]}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-[11px] font-medium uppercase tracking-wide text-white/60">
                  Sort
                  <select
                    value={direction}
                    onChange={(e) => setDirection(e.target.value as SafetySortDirection)}
                    className="mt-1 block rounded-md border border-white/20 bg-black/40 px-2 py-1 text-xs text-white"
                  >
                    <option value="safest-first">Safest first</option>
                    <option value="riskiest-first">Riskiest first</option>
                  </select>
                </label>

                <label className="flex items-center gap-2 text-[11px] text-white/70">
                  <input
                    type="checkbox"
                    checked={watchedOnly}
                    onChange={(e) => setWatchedOnly(e.target.checked)}
                  />
                  Watchlist only
                </label>
              </div>

              <p className="mt-2 text-[10px] leading-snug text-white/55">
                Unscored rows are placed after every scored row under either sort direction. They
                have no measured position, so neither end of the axis would be honest.
              </p>

              {watchlist.persistError ? (
                <p className="mt-2 text-[11px] text-amber-200">{watchlist.persistError}</p>
              ) : null}

              <div className="mt-4">
                {visible.length === 0 ? (
                  <p className="text-xs text-white/70">
                    No row matches this filter. {rows.length} pair
                    {rows.length === 1 ? ' was' : 's were'} read from the indexer.
                  </p>
                ) : (
                  <PairTable
                    rows={visible}
                    safetyOf={safetyOf}
                    selected={selectedPair}
                    onSelect={setSelectedPair}
                    isWatched={watchlist.isWatched}
                    onToggleWatch={watchlist.toggle}
                  />
                )}
              </div>
            </div>

            <div className="space-y-6">
              <SafetyInspector
                token={selectedToken ?? ''}
                safety={selectedToken ? live.safety : SAFETY_NOT_REQUESTED}
                loading={live.loading}
                deployer={deployer}
                onDeployerChange={setDeployer}
              />
              <QuickBuyPanel
                token={selectedToken ?? ''}
                safety={selectedToken ? live.safety : SAFETY_NOT_REQUESTED}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
