import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle';
import { useMarketFeed, type MarketFeedRequest } from '../hooks/useMarketFeed';
import { useSafetyBatch } from '../hooks/useSafetyBatch';
import { useTerminalFeed } from '../hooks/useTerminalFeed';
import { useTerminalSafety } from '../hooks/useTerminalSafety';
import { useTerminalWatchlist } from '../hooks/useTerminalWatchlist';
import { counterToken, type TerminalPairRow } from '../lib/terminal/feed';
import { GECKO_POOLS_MULTI_MAX, type MarketRow } from '../lib/geckoTerminal/pools';
import { residentLabelForPool } from '../lib/bungalows';
import { islandPoolsOn } from '../lib/terminal/islandPools';
import { watchedOn } from '../lib/terminal/watchlist';
import { NETWORK_LABEL, type MarketView } from '../lib/terminal/feedBanner';
import { parseTerminalParams, serializeTerminalParams } from '../lib/terminal/terminalParams';
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
import { ArtCard } from '../components/ui/ArtCard';
import { FeedStatus } from '../components/terminal/FeedStatus';
import { FeedTabs } from '../components/terminal/FeedTabs';
import { MarketFeedStatus } from '../components/terminal/MarketFeedStatus';
import { MarketTable } from '../components/terminal/MarketTable';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { PairTable } from '../components/terminal/PairTable';
import { QuickBuyPanel } from '../components/terminal/QuickBuyPanel';
import { SafetyInspector } from '../components/terminal/SafetyInspector';

// THE PRO TERMINAL — a multi-chain discovery feed where every row carries its
// risk read, or says why it does not have one.
//
// The differentiator is not the feed; anyone can list pools, and the rows here
// come from GeckoTerminal's public market-wide feed rather than from anything
// this venue computed. What is ours is that a row states whether it was actually
// READ. Two rules hold the whole page up and both live in
// lib/terminal/rowSafety.ts rather than in this file, so a layout change cannot
// edit them away:
//
//   1. Only a FULLY-read row can be green, and the green badge and the "fully
//      read" filter go through the same predicate.
//   2. A row that could not be read has no position on the safety axis. It
//      sorts to the end under BOTH directions rather than taking the flattering
//      end of one.
//
// AND ON THIS BUILD, RULE 1 IS NEVER SATISFIED BY A FEED ROW. Resolving which
// address deployed a token needs Etherscan's `getcontractcreation`, which is not
// in frontend/api/etherscan.js's action allowlist — there is no contract-creator
// lookup anywhere in this build. So the deployer half is unread for every row on
// every chain unless a visitor pastes an address, and what they paste is a
// claim, not a verification. The page says that in the header, the badge gaps,
// the inspector label and the batch banner rather than letting an empty "Read,
// nothing found" filter imply that nothing passed the bar.
//
// WHY THE FEED IS READ BROWSER-DIRECT: see useMarketFeed. The short version is
// that this app's own GeckoTerminal proxy turns a 429 into an empty list with a
// 200, and an empty table on a discovery feed is a claim about an entire chain.
//
// THE INDEXER IS DEMOTED, NOT DELETED. The venue's own pair feed — the only
// source with in-window activity counts and a head-block time — appears as a
// "Venue pairs" tab if and only if one is configured. Nothing about venue pairs
// is ever rendered from the market feed.

const VENUE_TOKENS = [WETH_ADDRESS, TOWELI_ADDRESS];

// Stable empty arrays. A literal [] is a new identity on every render, which
// would defeat every useMemo downstream of it.
const EMPTY_MARKET_ROWS: readonly MarketRow[] = [];
const EMPTY_PAIR_ROWS: readonly TerminalPairRow[] = [];

export default function TerminalPage() {
  usePageTitle(
    'Pro Terminal',
    'A live multi-chain pool feed from GeckoTerminal where every row carries this venue’s own safety read — or says why it has none. No row is fully read on this build, because the deploying address is never resolved.',
  );

  const [searchParams, setSearchParams] = useSearchParams();
  const { network, view, pool: selectedKey } = parseTerminalParams(searchParams);

  const watchlist = useTerminalWatchlist();
  const batch = useSafetyBatch();

  const [deployer, setDeployer] = useState('');
  const [filter, setFilter] = useState<SafetyFilter>('all');
  const [direction, setDirection] = useState<SafetySortDirection>('safest-first');
  const [watchedOnly, setWatchedOnly] = useState(false);

  const setParams = useCallback(
    (next: Partial<{ network: typeof network; view: typeof view; pool: string | null }>) => {
      // A network or view change CLEARS the selection. A row key from one view is
      // meaningless in another, and carrying it forward would leave the inspector
      // reading a row that is no longer on screen — the one state where the
      // safety panel and the table could describe different tokens.
      const movedView = next.network !== undefined || next.view !== undefined;
      const pool = next.pool !== undefined ? next.pool : movedView ? null : selectedKey;

      setSearchParams(
        serializeTerminalParams({
          network: next.network ?? network,
          view: next.view ?? view,
          pool,
        }),
        { replace: true },
      );
    },
    [network, view, selectedKey, setSearchParams],
  );

  const isIndexerView = view === 'indexer';

  // ── The market feed ────────────────────────────────────────────────────────
  const islandPools = useMemo(() => islandPoolsOn(network), [network]);
  const watchedHere = useMemo(
    () => watchedOn(watchlist.watched, network),
    [watchlist.watched, network],
  );
  const watchedShown = useMemo(
    () => watchedHere.slice(0, GECKO_POOLS_MULTI_MAX),
    [watchedHere],
  );

  const request: MarketFeedRequest | null = useMemo(() => {
    switch (view) {
      case 'new':
        return { view: 'list', network, list: 'new' };
      case 'trending':
        return { view: 'list', network, list: 'trending' };
      case 'island':
        return { view: 'multi', network, pools: islandPools };
      case 'watchlist':
        return { view: 'multi', network, pools: watchedShown };
      case 'indexer':
        return null;
    }
  }, [view, network, islandPools, watchedShown]);

  const market = useMarketFeed(request);
  // Memoised because a fresh [] every render would re-key every useMemo below
  // it, and one of those drives the safety lookup for the selected row.
  const marketRows = useMemo(
    () => (market.state.status === 'ready' ? market.state.rows : EMPTY_MARKET_ROWS),
    [market.state],
  );
  const readAt = market.state.status === 'ready' ? market.state.readAt : 0;

  // ── The venue's own pair feed, only when one is configured ─────────────────
  const feed = useTerminalFeed({ enabled: isIndexerView });
  const pairRows = useMemo(() => feed.feed?.rows ?? EMPTY_PAIR_ROWS, [feed.feed]);

  // ── Selection ──────────────────────────────────────────────────────────────
  // ONE KEY SHAPE across both feeds: `${network}:${address}`. The indexer's rows
  // are venue pairs on Ethereum, so they key as `eth:0x…` — which is also what
  // the watchlist stores, so a star set on either feed means the same thing.
  const selectedMarketRow = useMemo(
    () => marketRows.find((r) => r.key === selectedKey) ?? null,
    [marketRows, selectedKey],
  );
  const selectedPairRow = useMemo(
    () => pairRows.find((r) => `eth:${r.pair.toLowerCase()}` === selectedKey) ?? null,
    [pairRows, selectedKey],
  );

  // The token a trader would buy on a venue pair is the non-venue leg. When
  // neither leg is a venue token this build cannot name a target, so nothing is
  // guessed and the panel simply has no token.
  const selectedToken = isIndexerView
    ? selectedPairRow
      ? counterToken(selectedPairRow, VENUE_TOKENS)
      : null
    : (selectedMarketRow?.token ?? null);
  const selectedNetwork = isIndexerView ? 'eth' : selectedMarketRow?.network;

  const live = useTerminalSafety({
    token: selectedToken ?? '',
    deployer,
    network: selectedNetwork,
  });

  // Exactly one row is live-scored; the opt-in batch may add up to five more.
  // Every other row is explicitly unscored, and that is the resting state rather
  // than an optimistic one.
  //
  // PRECEDENCE IS CHOSEN SO A FINDING IS NEVER HIDDEN. The live read wins for
  // the selected row only when it actually produced a score — while it is still
  // loading it reads as `unscored`, and letting that overwrite a batch result
  // that already found something would replace a warning with a shrug.
  const safetyOf = useCallback(
    (key: string): RowSafety => {
      if (key === selectedKey && selectedToken && live.safety.kind === 'scored') return live.safety;
      const batched = batch.results.get(key);
      if (batched) return batched;
      if (key === selectedKey && selectedToken) return live.safety;
      return SAFETY_NOT_REQUESTED;
    },
    [selectedKey, selectedToken, live.safety, batch.results],
  );

  const marketSafetyOf = useCallback((row: MarketRow) => safetyOf(row.key), [safetyOf]);
  const pairSafetyOf = useCallback(
    (row: TerminalPairRow) => safetyOf(`eth:${row.pair.toLowerCase()}`),
    [safetyOf],
  );

  const visibleMarket = useMemo(() => {
    const filtered = marketRows.filter((row) => {
      if (watchedOnly && !watchlist.isWatched(row.key)) return false;
      return passesSafetyFilter(marketSafetyOf(row), filter);
    });
    return sortBySafety(filtered, marketSafetyOf, direction);
  }, [marketRows, watchedOnly, watchlist, filter, direction, marketSafetyOf]);

  const visiblePairs = useMemo(() => {
    const filtered = pairRows.filter((row) => {
      if (watchedOnly && !watchlist.isWatched(row.pair)) return false;
      return passesSafetyFilter(pairSafetyOf(row), filter);
    });
    return sortBySafety(filtered, pairSafetyOf, direction);
  }, [pairRows, watchedOnly, watchlist, filter, direction, pairSafetyOf]);

  const labelFor = useCallback(
    (row: MarketRow) => residentLabelForPool(row.network, row.pool),
    [],
  );

  const showMarketTable = market.state.status === 'ready' && visibleMarket.length > 0;
  const showPairTable =
    isIndexerView && (feed.status === 'ready' || feed.status === 'backfilling');

  return (
    <div className="relative min-h-screen">
      {/* ART 2026-09-01: this page rendered no art surface at all, so it was
          invisible to both studios — a skin could not touch it. */}
      <PageArtBackdrop pageId="terminal" />
      <div className="relative z-10 mx-auto w-full max-w-7xl px-4 py-8">
        <header>
          <h1 className="text-2xl font-bold text-white">Pro Terminal</h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/75">
            Rows come from GeckoTerminal&rsquo;s public market-wide feed; the safety read is this
            venue&rsquo;s own and runs only for the row you select. Every row carries that read or
            says that it does not have one — a row that could not be scored is never ranked among
            the scored ones and never shows a pass, because an unreachable scanner is not a clean
            token.
          </p>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-amber-200/90">
            No row on this feed is fully read on this build: the address that deployed a token is
            never resolved here, so half of every score is missing. A row can reach &ldquo;Caution&rdquo;
            or &ldquo;High risk (partly unread)&rdquo; from the holder read alone, but it can never
            reach a pass unless you paste a deployer — and a pasted address is a claim, not a check.
          </p>
        </header>

        <div className="mt-6">
          <FeedTabs
            network={network}
            onNetworkChange={(n) => setParams({ network: n })}
            view={view}
            onViewChange={(v) => setParams({ view: v })}
          />
        </div>

        <div className="mt-4">
          {isIndexerView ? (
            <FeedStatus
              status={feed.status}
              detail={feed.detail}
              feed={feed.feed}
              syncedAt={feed.syncedAt}
              onRetry={feed.reload}
            />
          ) : (
            <MarketFeedStatus
              state={market.state}
              context={{ network, view: view as MarketView }}
              onReload={market.reload}
            />
          )}
        </div>

        {!isIndexerView && view === 'watchlist' && watchedHere.length === 0 ? (
          <p className="mt-4 text-xs text-white/75">
            Nothing is watched on {NETWORK_LABEL[network]} yet. Star a row on any view to add it.
          </p>
        ) : null}

        {!isIndexerView && watchedHere.length > watchedShown.length ? (
          <p className="mt-4 text-xs text-white/75">
            Showing the first {watchedShown.length} of {watchedHere.length} watched pools on{' '}
            {NETWORK_LABEL[network]} — the upstream reads at most {GECKO_POOLS_MULTI_MAX} pools per
            request, and the rest are not shown rather than silently dropped.
          </p>
        ) : null}

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-[11px] font-medium uppercase tracking-wide text-white/60">
                Safety filter
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value as SafetyFilter)}
                  className="mt-1 block min-h-11 rounded-md border border-white/20 bg-black/40 px-2 py-1 text-xs text-white"
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
                  className="mt-1 block min-h-11 rounded-md border border-white/20 bg-black/40 px-2 py-1 text-xs text-white"
                >
                  <option value="safest-first">Safest first</option>
                  <option value="riskiest-first">Riskiest first</option>
                </select>
              </label>

              <label className="flex min-h-11 items-center gap-2 text-[11px] text-white/70">
                <input
                  type="checkbox"
                  checked={watchedOnly}
                  onChange={(e) => setWatchedOnly(e.target.checked)}
                />
                Watchlist only
              </label>

              {!isIndexerView ? (
                <button
                  type="button"
                  onClick={() => batch.run(visibleMarket)}
                  disabled={batch.running || visibleMarket.length === 0}
                  className="inline-flex min-h-11 items-center rounded-md border border-white/25 px-3 text-xs font-medium text-white hover:bg-white/10 disabled:opacity-40"
                >
                  {batch.running ? 'Reading…' : 'Holder-read the top 5 visible rows'}
                </button>
              ) : null}
            </div>

            <p className="mt-2 text-[10px] leading-snug text-white/55">
              Unscored rows are placed after every scored row under either sort direction. They have
              no measured position, so neither end of the axis would be honest.
            </p>

            {batch.progress.total > 0 ? (
              <p className="mt-2 text-[11px] leading-snug text-amber-200">
                {batch.progress.done} of {batch.progress.total} rows holder-read — none is fully
                read, because no deployer is resolved on this build; the rest are unscored, which is
                not clean.
                {batch.progress.stoppedBy
                  ? ` Stopped by ${batch.progress.stoppedBy}`
                  : ''}
              </p>
            ) : null}

            {watchlist.persistError ? (
              <p className="mt-2 text-[11px] text-amber-200">{watchlist.persistError}</p>
            ) : null}

            {selectedKey && !selectedMarketRow && !selectedPairRow ? (
              <p className="mt-2 text-[11px] text-white/70">That pool is not in this view.</p>
            ) : null}

            <div className="mt-4">
              {isIndexerView ? (
                showPairTable ? (
                  visiblePairs.length === 0 ? (
                    <p className="text-xs text-white/70">
                      No row matches this filter. {pairRows.length} pair
                      {pairRows.length === 1 ? ' was' : 's were'} read from the indexer.
                    </p>
                  ) : (
                    <PairTable
                      rows={visiblePairs}
                      safetyOf={pairSafetyOf}
                      selected={selectedPairRow?.pair ?? null}
                      onSelect={(pair) => setParams({ pool: `eth:${pair.toLowerCase()}` })}
                      // Bare 0x keys are migrated to `eth:0x…` by
                      // normalizeWatchKey, so these pass through unwrapped and
                      // still land on the same key the market table writes.
                      isWatched={watchlist.isWatched}
                      onToggleWatch={watchlist.toggle}
                    />
                  )
                ) : null
              ) : showMarketTable ? (
                <MarketTable
                  rows={visibleMarket}
                  readAt={readAt}
                  safetyOf={marketSafetyOf}
                  selected={selectedKey}
                  onSelect={(key) => setParams({ pool: key })}
                  isWatched={watchlist.isWatched}
                  onToggleWatch={watchlist.toggle}
                  labelFor={view === 'island' ? labelFor : undefined}
                  caption={`Pools from GeckoTerminal on ${NETWORK_LABEL[network]}, with this venue’s safety read. Rows that could not be scored say so and are not ranked.`}
                />
              ) : market.state.status === 'ready' && marketRows.length > 0 ? (
                <p className="text-xs text-white/70">
                  No row matches this filter. {marketRows.length} pool
                  {marketRows.length === 1 ? ' was' : 's were'} read from GeckoTerminal.
                </p>
              ) : null}
            </div>
          </div>

          <div className="space-y-6">
            <ArtCard pageId="terminal" idx={0} padding="p-0">
              <SafetyInspector
                token={selectedToken ?? ''}
                safety={selectedToken ? safetyOf(selectedKey ?? '') : SAFETY_NOT_REQUESTED}
                loading={live.loading}
                deployer={deployer}
                onDeployerChange={setDeployer}
                network={selectedNetwork}
              />
            </ArtCard>
            <ArtCard pageId="terminal" idx={0} padding="p-0">
              <QuickBuyPanel
                token={selectedToken ?? ''}
                safety={selectedToken ? safetyOf(selectedKey ?? '') : SAFETY_NOT_REQUESTED}
                network={selectedNetwork}
                pool={selectedMarketRow?.pool}
              />
            </ArtCard>
          </div>
        </div>
      </div>
    </div>
  );
}
