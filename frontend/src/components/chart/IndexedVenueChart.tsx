import { useMemo, useState } from 'react';
import { useChartCandles } from '../../hooks/useChartCandles';
import { useTerminalFeed } from '../../hooks/useTerminalFeed';
import { resolvePairTokens, type PairTokenResolution } from '../../lib/chart/pairTokens';
import type { PairPricing } from '../../lib/chart/pairSwaps';
import { TIMEFRAME_IDS, TIMEFRAMES, DEFAULT_TIMEFRAME, type TimeframeId } from '../../lib/chart/timeframes';
import { shortenAddress } from '../../lib/formatting';
import { CandleChart } from './CandleChart';
import { ChartStatus } from './ChartStatus';

// THE SECOND SOURCE: candles for a venue pair, built from indexed swaps.
//
// This is the half of /chart that predates the GeckoTerminal rail, moved out of
// ChartPage whole rather than deleted. It is the only path that can ever show a
// TegridyPair GeckoTerminal has not indexed, a per-bucket trade COUNT, or the
// within-block ordering that decides which way a sandwiched bucket closed — so
// deleting it would have deleted the three things the other source cannot say.
//
// It renders only where `VITE_INDEXER_URL` resolves (the caller checks), because
// with no indexer this block is an unconditional "could not read" banner sitting
// under a chart that worked. The page states that absence once, in its Sources
// card, instead of drawing a second failure.

/**
 * Placeholder pricing for the render passes where no pool is resolved.
 *
 * The hook is called unconditionally (rules of hooks) but is `enabled: false`
 * in exactly those passes, so these numbers never reach a division. They exist
 * so the disabled path cannot be reached with a half-built pricing object.
 */
const NO_PRICING: PairPricing = { base: 'token0', token0Decimals: 18, token1Decimals: 18 };

export function IndexedVenueChart() {
  const feed = useTerminalFeed();
  const [selectedPair, setSelectedPair] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState<TimeframeId>(DEFAULT_TIMEFRAME);

  // Memoised so the empty-array fallback is not a new identity on every render,
  // which would re-run every downstream memo including the one that resolves the
  // pair's tokens.
  const rows = useMemo(() => feed.feed?.rows ?? [], [feed.feed]);
  const activeRow = useMemo(
    () => rows.find((r) => r.pair.toLowerCase() === (selectedPair ?? '').toLowerCase()) ?? rows[0] ?? null,
    [rows, selectedPair],
  );

  const resolution: PairTokenResolution | null = useMemo(
    () => (activeRow ? resolvePairTokens(activeRow.token0, activeRow.token1) : null),
    [activeRow],
  );

  const pricing = resolution?.ok ? resolution.pricing : NO_PRICING;

  const chart = useChartCandles({
    pair: resolution?.ok ? activeRow!.pair : null,
    pricing,
    timeframe,
    enabled: resolution?.ok === true,
  });

  const feedAnswered = feed.status === 'ready' || feed.status === 'backfilling';

  // Why nothing was asked, in the caller's words. The chart hook parks in `idle`
  // whenever there is no resolved pool, and `idle` on its own is indistinguishable
  // from "the reader has not picked one yet". The reason is one level up, so it is
  // stated one level up.
  const idleReason = !feedAnswered
    ? 'No venue pair could be read, so no candles were requested. This says nothing about whether this venue trades.'
    : rows.length === 0
      ? 'The indexer listed no allowlisted pool, so there is nothing to chart here.'
      : resolution && !resolution.ok
        ? resolution.reason
        : null;

  return (
    <section className="mt-8" aria-label="Venue pairs (indexed)">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/50">
        Venue pairs (indexed)
      </h2>
      <p className="mb-3 max-w-2xl text-xs leading-relaxed text-white/60">
        A separate source with a separate coverage line. These candles are built from swaps the
        indexer recorded one at a time, so they carry trade counts and within-block ordering that
        the GeckoTerminal buckets above do not. The two are never overlaid on one axis.
      </p>

      {feedAnswered && rows.length > 0 ? (
        <div className="mb-3 flex flex-wrap gap-2">
          {rows.map((row) => {
            const active = activeRow?.pair === row.pair;
            const resolved = resolvePairTokens(row.token0, row.token1);
            return (
              <button
                key={row.pair}
                type="button"
                onClick={() => setSelectedPair(row.pair)}
                aria-pressed={active}
                className={`min-h-[44px] rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? 'border-white/40 bg-white/15 text-white'
                    : 'border-white/15 bg-white/[0.04] text-white/70 hover:bg-white/10'
                }`}
              >
                {resolved.ok ? `${resolved.base.symbol} / ${resolved.quote.symbol}` : shortenAddress(row.pair)}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-xs font-semibold uppercase tracking-wider text-white/50">
          {resolution?.ok ? `${resolution.base.symbol} / ${resolution.quote.symbol}` : 'Candles'}
        </h3>
        {TIMEFRAME_IDS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTimeframe(id)}
            aria-pressed={timeframe === id}
            className={`min-h-[44px] rounded-md border px-3 py-1 text-[11px] font-medium transition-colors ${
              timeframe === id
                ? 'border-white/40 bg-white/15 text-white'
                : 'border-white/15 bg-white/[0.04] text-white/65 hover:bg-white/10'
            }`}
          >
            {TIMEFRAMES[id].label}
          </button>
        ))}
      </div>

      {chart.status === 'ready' && chart.series && resolution?.ok ? (
        <div className="mb-3 rounded-xl border border-white/12 bg-black/25 p-3">
          <CandleChart
            series={chart.series}
            baseSymbol={resolution.base.symbol}
            quoteSymbol={resolution.quote.symbol}
          />
        </div>
      ) : null}

      <ChartStatus
        status={chart.status}
        detail={chart.status === 'idle' ? idleReason : chart.detail}
        series={chart.series}
        swapsRead={chart.swapsRead}
        unpriceable={chart.unpriceable}
        truncated={chart.truncated}
        syncedAt={chart.syncedAt}
        onRetry={chart.reload}
      />
    </section>
  );
}

export default IndexedVenueChart;
