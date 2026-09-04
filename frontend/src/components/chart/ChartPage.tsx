import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { usePageTitle } from '../../hooks/usePageTitle';
import { useGeckoCandles } from '../../hooks/useGeckoCandles';
import { isIndexerConfigured } from '../../lib/indexer/client';
import { chartPoolUrl } from '../../lib/chart/market';
import { resolveChartParams } from '../../lib/chart/chartParams';
import {
  NETWORK_LABELS,
  chartableMarkets,
  marketKey,
  type ChartableMarket,
} from '../../lib/chart/markets';
import { GECKO_TIMEFRAMES, GECKO_TIMEFRAME_IDS, type GeckoTimeframeId } from '../../lib/chart/ohlcv';
import { GECKO_NETWORKS } from '../../lib/geckoTerminal/pools';
import { ETH_ADDRESS_RE, SOL_ADDRESS_RE } from '../../lib/scanner/scanner';
import { PageArtBackdrop } from '../PageArtBackdrop';
import { ArtCard } from '../ui/ArtCard';
import { CandleChart } from './CandleChart';
import { ChartStatus } from './ChartStatus';
import { IndexedVenueChart } from './IndexedVenueChart';

// PRO CHARTING — candles for the island's pools, read from GeckoTerminal.
//
// WHAT CHANGED AND WHY. This page used to read the F1 indexer for BOTH halves —
// the pool list and the candles — and that indexer is hosted nowhere, so the
// whole surface was two "could not read" banners under a heading. Meanwhile the
// same app has been drawing GeckoTerminal candles in production on every
// bungalow page for weeks (components/bungalow/BungalowMarket.tsx). The fix was
// not to build anything: it was to point this page at the rail the rest of the
// venue already trusts, and to keep the gap-honest renderer that was already
// here and already tested.
//
// The pool list is a REGISTRY READ (lib/chart/markets.ts): TOWELI's own pool
// plus every island resident carrying a `market`. Nothing here is discovered at
// runtime, so the picker is fully rendered even when GeckoTerminal cannot be
// reached — and that degraded page is the fully labelled page, not a stub.
//
// NO KEEPER, NO STREAM. One read per (pool, timeframe), cached 60 s, and the
// as-of printed anywhere is the SOURCE's own newest bucket rather than a clock
// this page ticks. Nothing refreshes on its own and the footer says so.
//
// The indexer is not gone: it is a SECOND source (IndexedVenueChart) that
// self-enables when VITE_INDEXER_URL lands, because it is the only path that can
// carry trade counts, within-block ordering, and venue pairs GeckoTerminal has
// never indexed.

/**
 * Is this base-token address safe to hand to the in-venue scanner?
 *
 * The address arrives in GeckoTerminal's `meta` block — third-party data — and
 * it is about to be interpolated into a route. It is matched against the SAME
 * strict regexes the scanner itself validates with (lib/scanner/scanner.ts), on
 * the network the market says it is on, before it becomes a link. Anything else
 * renders no link at all: an unusable link into a scan page is worse than none,
 * and an unvalidated one is a hole.
 */
function scanHrefFor(market: ChartableMarket, baseAddress: string | null): string | null {
  if (!baseAddress) return null;
  const addr = baseAddress.trim();
  if (market.network === 'solana') {
    return SOL_ADDRESS_RE.test(addr) ? `/scan?token=${encodeURIComponent(addr)}` : null;
  }
  if (!ETH_ADDRESS_RE.test(addr)) return null;
  // ScannerPage reads `?chain=base` and defaults to Ethereum without it
  // (ScannerPage.tsx). A 0x address is format-ambiguous between the two chains,
  // so omitting it on a Base pool would scan a different token of the same name.
  return market.network === 'base'
    ? `/scan?token=${encodeURIComponent(addr)}&chain=base`
    : `/scan?token=${encodeURIComponent(addr)}`;
}

export default function ChartPage() {
  usePageTitle(
    'Pro Charting',
    "Candlestick charts for the island's pools, read from GeckoTerminal's own OHLCV feed — with every bucket the source did not return drawn as a gap rather than filled in with a price that never traded.",
  );

  const [params, setParams] = useSearchParams();

  // Resolved ONCE, from the URL as it arrived. Re-resolving on every render
  // would re-raise a refusal the reader has already read past, and writing the
  // corrected values back into the URL inside a render is a loop.
  const [initial] = useState(() =>
    resolveChartParams({
      network: params.get('network'),
      pool: params.get('pool'),
      tf: params.get('tf'),
    }),
  );

  const markets = useMemo(() => chartableMarkets(), []);
  const [market, setMarket] = useState<ChartableMarket | null>(initial.market);
  const [timeframe, setTimeframe] = useState<GeckoTimeframeId>(initial.timeframe);

  const candles = useGeckoCandles({ market, timeframe });

  // Selection rides the URL so a chart is a link someone can send. `replace` so
  // switching timeframes does not fill the reader's Back button with steps.
  const commit = (next: ChartableMarket | null, tf: GeckoTimeframeId) => {
    if (!next) return;
    setParams({ network: next.network, pool: next.pool, tf }, { replace: true });
  };

  const selectMarket = (next: ChartableMarket) => {
    setMarket(next);
    commit(next, timeframe);
  };

  const selectTimeframe = (tf: GeckoTimeframeId) => {
    setTimeframe(tf);
    commit(market, tf);
  };

  const activeKey = market ? marketKey(market.network, market.pool) : null;
  const pairHeading = market
    ? `${candles.baseSymbol ?? market.label} / ${candles.quoteSymbol ?? 'quote token (unnamed upstream)'}`
    : 'No pool selected';
  const scanHref = market ? scanHrefFor(market, candles.baseAddress) : null;

  return (
    <div className="relative min-h-screen">
      <PageArtBackdrop pageId="chart" />

      <div className="relative z-10 mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold text-white sm:text-3xl">Pro Charting</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/70">
            Candles for the island's pools, read from GeckoTerminal's own OHLCV feed and drawn by
            this venue. A bucket the source did not return is drawn as a gap: this chart will never
            draw a candle for a price that was not paid.
          </p>
        </header>

        {initial.refusals.length > 0 ? (
          <ul className="mb-5 space-y-2" aria-label="Link refusals">
            {initial.refusals.map((refusal) => (
              <li
                key={refusal.param}
                className="rounded-lg border border-amber-400/40 bg-amber-400/[0.07] px-4 py-3 text-xs leading-relaxed text-white/80"
              >
                {refusal.message}
              </li>
            ))}
          </ul>
        ) : null}

        <ArtCard pageId="chart" idx={1} className="mb-5">
          <section aria-label="Pool">
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-white/50">Pool</h2>
            <p className="mb-3 max-w-2xl text-xs leading-relaxed text-white/60">
              Every pool the island's own registry names — this venue's token and each resident's
              primary pair. The list is a fact this page can read without asking anyone, so it is
              complete here even when the price source is not answering.
            </p>

            {markets.length === 0 ? (
              <p className="rounded-lg border border-white/15 bg-white/[0.03] px-4 py-3 text-xs text-white/75">
                The registry names no pool, so there is nothing to chart. That is a statement about
                this list, not about which pools exist.
              </p>
            ) : (
              GECKO_NETWORKS.map((network) => {
                const group = markets.filter((m) => m.network === network);
                if (group.length === 0) return null;
                return (
                  <div key={network} className="mb-3 last:mb-0">
                    <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/40">
                      {NETWORK_LABELS[network]}
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {group.map((m) => {
                        const key = marketKey(m.network, m.pool);
                        const active = key === activeKey;
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => selectMarket(m)}
                            aria-pressed={active}
                            className={`min-h-[44px] rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                              active
                                ? 'border-white/40 bg-white/15 text-white'
                                : 'border-white/15 bg-white/[0.04] text-white/70 hover:bg-white/10'
                            }`}
                          >
                            {m.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            )}
          </section>
        </ArtCard>

        <section aria-label="Chart">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="mr-auto text-xs font-semibold uppercase tracking-wider text-white/50">
              {pairHeading}
            </h2>
            {GECKO_TIMEFRAME_IDS.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => selectTimeframe(id)}
                aria-pressed={timeframe === id}
                className={`min-h-[44px] rounded-md border px-3 py-1 text-[11px] font-medium transition-colors ${
                  timeframe === id
                    ? 'border-white/40 bg-white/15 text-white'
                    : 'border-white/15 bg-white/[0.04] text-white/65 hover:bg-white/10'
                }`}
              >
                {GECKO_TIMEFRAMES[id].label}
              </button>
            ))}
          </div>

          {/* Mounted ONLY with something to draw. A zero-candle series renders as
              a bare axis, which reads as a market that traded nothing — the
              banner below says what actually happened instead. */}
          {candles.status === 'ready' && candles.series && candles.series.candleCount > 0 && market ? (
            <div className="mb-3 rounded-xl border border-white/12 bg-black/25 p-3">
              <CandleChart
                series={candles.series}
                baseSymbol={candles.baseSymbol ?? market.label}
                quoteSymbol={candles.quoteSymbol ?? 'quote token (unnamed upstream)'}
                newestMayBeOpen
              />
            </div>
          ) : null}

          {market ? (
            <ChartStatus
              source="gecko"
              state={candles}
              market={market}
              timeframeLabel={GECKO_TIMEFRAMES[timeframe].label}
            />
          ) : (
            <div className="rounded-xl border border-white/20 bg-white/[0.03] px-4 py-3" role="status">
              <h2 className="text-sm font-semibold text-white">No pool to chart</h2>
              <p className="mt-1.5 text-xs leading-relaxed text-white/80">
                No pool is selected, so nothing was asked of any source.
              </p>
            </div>
          )}
        </section>

        <ArtCard pageId="chart" idx={2} className="mt-6">
          <section aria-label="Sources">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/50">
              Sources
            </h2>
            <ul className="space-y-2 text-xs leading-relaxed text-white/75">
              <li>
                Candles: GeckoTerminal per-bucket OHLC for this pool, read by this venue — not
                computed or oracled by it.
              </li>
              {!isIndexerConfigured() ? (
                <li>
                  Indexed swaps: not configured on this deployment. Trade counts and per-swap
                  ordering come only from that source; GeckoTerminal candles above do not carry
                  them.
                </li>
              ) : null}
            </ul>

            {market ? (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <a
                  href={chartPoolUrl(market)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-[44px] items-center rounded-lg border border-white/20 px-3 py-1.5 text-xs font-medium text-white/85 hover:bg-white/10"
                >
                  Pool page ↗
                </a>
                {scanHref ? (
                  <Link
                    to={scanHref}
                    className="inline-flex min-h-[44px] items-center rounded-lg border border-white/20 px-3 py-1.5 text-xs font-medium text-white/85 hover:bg-white/10"
                  >
                    Scan this token
                  </Link>
                ) : null}
              </div>
            ) : null}
          </section>
        </ArtCard>

        {/* The indexed source, kept mounted and self-enabling. It renders only
            where an indexer resolves; otherwise the Sources card above is the
            one place its absence is stated, rather than a second failed panel. */}
        {isIndexerConfigured() ? <IndexedVenueChart /> : null}

        <p className="mt-6 text-[11px] leading-relaxed text-white/45">
          Prices are GeckoTerminal's per-bucket OHLC for this pool; this venue reads them, it does
          not compute or oracle them. Nothing on this page refreshes on its own; there is no keeper
          and no stream behind it.
        </p>
      </div>
    </div>
  );
}
