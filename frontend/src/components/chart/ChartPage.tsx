import { useMemo, useState } from 'react';
import { usePageTitle } from '../../hooks/usePageTitle';
import { useChartCandles } from '../../hooks/useChartCandles';
import { useTerminalFeed } from '../../hooks/useTerminalFeed';
import { resolvePairTokens, type PairTokenResolution } from '../../lib/chart/pairTokens';
import type { PairPricing } from '../../lib/chart/pairSwaps';
import { TIMEFRAME_IDS, TIMEFRAMES, DEFAULT_TIMEFRAME, type TimeframeId } from '../../lib/chart/timeframes';
import { shortenAddress } from '../../lib/formatting';
import { PageArtBackdrop } from '../PageArtBackdrop';
import { CandleChart } from './CandleChart';
import { ChartStatus } from './ChartStatus';

// PRO CHARTING (#47) — candles for venue pools, built from indexed swaps.
//
// The pool list and the candles come from the SAME indexer (lib/indexer/client.ts),
// so both halves of this page are gated by one environment variable and both say
// so in their own words. That is deliberate: a pool picker that worked while the
// chart did not would invite the reading that the pools are real and only the
// prices are missing, when in fact neither was read.
//
// NO KEEPER, NO STREAM. This page reads one page of swaps when it mounts and
// when the reader asks again. Nothing refreshes it in the background, and it
// never claims to be live — the coverage lines state the indexer's own sync
// position instead of a "last updated" that would tick on its own.

/**
 * Placeholder pricing for the render passes where no pool is resolved.
 *
 * The hook is called unconditionally (rules of hooks) but is `enabled: false`
 * in exactly those passes, so these numbers never reach a division. They exist
 * so the disabled path cannot be reached with a half-built pricing object.
 */
const NO_PRICING: PairPricing = { base: 'token0', token0Decimals: 18, token1Decimals: 18 };

export default function ChartPage() {
  usePageTitle(
    'Pro Charting',
    'Candlestick charts for venue pools, drawn from indexed swaps — with every empty bucket shown as a gap rather than filled in with a price that never traded.',
  );

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
  // from "the reader has not picked one yet" — which in this build is never the
  // reason. The reason is one level up, so it is stated one level up.
  const idleReason = !feedAnswered
    ? 'No pool could be read, so no candles were requested. The pool list above says why — and neither statement is about whether this venue trades.'
    : rows.length === 0
      ? 'The indexer listed no allowlisted pool, so there is nothing to chart.'
      : resolution && !resolution.ok
        ? resolution.reason
        : null;

  return (
    <div className="relative min-h-screen">
      <PageArtBackdrop pageId="chart" />

      <div className="relative z-10 mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold text-white sm:text-3xl">Pro Charting</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/70">
            Candles for venue pools, derived from the swaps the indexer recorded. A bucket where
            nothing traded is drawn as a gap: this chart will never draw a candle for a price that
            was not paid.
          </p>
        </header>

        <section className="mb-5" aria-label="Pool">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/50">Pool</h2>
          {feedAnswered ? (
            rows.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {rows.map((row) => {
                  const active = activeRow?.pair === row.pair;
                  const resolved = resolvePairTokens(row.token0, row.token1);
                  return (
                    <button
                      key={row.pair}
                      type="button"
                      onClick={() => setSelectedPair(row.pair)}
                      aria-pressed={active}
                      className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                        active
                          ? 'border-white/40 bg-white/15 text-white'
                          : 'border-white/15 bg-white/[0.04] text-white/70 hover:bg-white/10'
                      }`}
                    >
                      {resolved.ok
                        ? `${resolved.base.symbol} / ${resolved.quote.symbol}`
                        : shortenAddress(row.pair)}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="rounded-lg border border-white/15 bg-white/[0.03] px-4 py-3 text-xs text-white/75">
                The indexer answered and listed no allowlisted pool, so there is nothing to chart.
              </p>
            )
          ) : (
            <p className="rounded-lg border border-amber-400/40 bg-amber-400/[0.07] px-4 py-3 text-xs leading-relaxed text-white/80">
              {feed.detail ??
                'The pool list could not be read, so no pool can be offered. This says nothing about which pools exist.'}
            </p>
          )}
        </section>

        {resolution && !resolution.ok ? (
          <p className="mb-5 rounded-lg border border-amber-400/40 bg-amber-400/[0.07] px-4 py-3 text-xs leading-relaxed text-white/80">
            {resolution.reason}
          </p>
        ) : null}

        <section aria-label="Chart">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="mr-auto text-xs font-semibold uppercase tracking-wider text-white/50">
              {resolution?.ok ? `${resolution.base.symbol} / ${resolution.quote.symbol}` : 'Candles'}
            </h2>
            {TIMEFRAME_IDS.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setTimeframe(id)}
                aria-pressed={timeframe === id}
                className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
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

        <p className="mt-6 text-[11px] leading-relaxed text-white/45">
          Prices are computed per swap from the pool's own amount legs — quote received divided by
          base sent — and are not read from any oracle or aggregator. Nothing on this page refreshes
          on its own; there is no keeper and no stream behind it.
        </p>
      </div>
    </div>
  );
}
