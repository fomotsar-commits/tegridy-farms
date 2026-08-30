import { Suspense, lazy, useMemo } from 'react';
import type { Bungalow } from '../../lib/bungalows';
import { usePoolMarket } from '../../hooks/usePoolMarket';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { BungalowTrades } from './BungalowTrades';

// The chart pulls in lightweight-charts; keep it out of the bungalow's first
// paint the same way the classic dashboard does.
const PriceChart = lazy(() =>
  import('../chart/PriceChart').then((m) => ({ default: m.PriceChart })),
);

/**
 * The bungalow's market: a candlestick chart of its own pool plus the numbers
 * a holder actually asks for — price, 24h move, liquidity, volume, FDV, and
 * the buy/sell split.
 *
 * WHY IT EXISTS: before 2026-08-28 the Bayla bungalow stated no market fact at
 * all. The venue's chart was hardcoded to TOWELI/WETH on Ethereum and rendered
 * only on the classic dashboard, which a token-first bungalow replaces
 * wholesale; the home page's stat pills are `!bungalowIdentity` gated because
 * they are TOWELI-denominated. So her page could say who she was and where to
 * trade her, but not what she was worth.
 *
 * HONESTY RULES (the venue's, applied here):
 *  - a number that could not be read renders "—", never 0;
 *  - FDV is labelled FDV. GeckoTerminal returns no market cap for her (no
 *    circulating-supply record), and printing FDV under "Market cap" would be
 *    the kind of quiet substitution the staking-look doc exists to prevent;
 *  - nothing polls. One read on mount, and a Refresh the reader controls —
 *    so the strip can never imply a liveness it doesn't have;
 *  - the source is named and linked, so any figure can be checked.
 */
export function BungalowMarket({ bungalow }: { bungalow: Bungalow }) {
  const market = bungalow.market ?? null;
  const { market: data, isLoading, error, refresh } = usePoolMarket(
    market?.network ?? null,
    market?.pool ?? null,
  );

  const chartMarket = useMemo(
    () => (market ? { network: market.network, pool: market.pool, label: bungalow.symbol } : null),
    [market, bungalow.symbol],
  );

  if (!market || !chartMarket) return null;

  const change = data?.change24hPct ?? null;
  const changeColor =
    change === null ? 'rgba(255,255,255,0.55)' : change >= 0 ? '#22c55e' : '#ef4444';

  return (
    <section
      className="rounded-2xl p-6"
      style={{ background: 'rgba(4,9,18,0.72)', border: '1px solid var(--color-purple-25)' }}
      aria-label={`${bungalow.symbol} market`}
    >
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-kyle)' }}>
          The market
        </p>
        <h2 className="heading-luxury text-xl text-white">{bungalow.symbol} price</h2>
        <span className="text-[11px] text-white/45">{market.label}</span>
        <div className="flex-1" />
        <button
          onClick={refresh}
          disabled={isLoading}
          className="text-[11px] px-3 py-1 rounded border border-white/10 bg-white/5 text-white/70 hover:text-white disabled:opacity-50"
        >
          {isLoading ? 'Reading…' : 'Refresh'}
        </button>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
        <Stat label="Price" value={fmtUsd(data?.priceUsd ?? null)} />
        <Stat
          label="24h"
          value={change === null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}
          color={changeColor}
        />
        <Stat label="Liquidity" value={fmtUsd(data?.liquidityUsd ?? null, 0)} />
        <Stat label="24h volume" value={fmtUsd(data?.volume24hUsd ?? null, 0)} />
        <Stat
          label="FDV"
          value={fmtUsd(data?.fdvUsd ?? null, 0)}
          title="Fully diluted valuation — total supply times price. Not market cap: no circulating-supply record exists for this token upstream, so no market cap is claimed."
        />
        <Stat
          label="24h buys / sells"
          value={
            data?.buys24h === null || data?.buys24h === undefined ||
            data?.sells24h === null || data?.sells24h === undefined
              ? '—'
              : `${data.buys24h} / ${data.sells24h}`
          }
          title={
            data?.buyers24h !== null && data?.buyers24h !== undefined
              ? `${data.buyers24h} distinct buyers, ${data.sellers24h ?? '—'} sellers`
              : undefined
          }
        />
      </div>

      {error && (
        <p className="text-[12px] mb-4" style={{ color: '#f0b26b' }}>{error}</p>
      )}

      {/* Chart */}
      <div className="h-[360px] rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.35)' }}>
        <ErrorBoundary
          fallback={
            <div className="flex items-center justify-center h-full text-white/70 text-[13px]">
              Chart unavailable
            </div>
          }
        >
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full text-white/50 text-[12px]">
                Loading chart…
              </div>
            }
          >
            <PriceChart market={chartMarket} />
          </Suspense>
        </ErrorBoundary>
      </div>

      {/* The tape — the venue's LiveActivity pill is muted in a bungalow. */}
      <BungalowTrades bungalow={bungalow} />

      <p className="text-[10px] text-white/40 mt-3">
        Price, liquidity, volume and the trade split are read from GeckoTerminal for this
        pool on read — nothing here refreshes on its own. A dash means the figure could
        not be read, not that it is zero.
      </p>
    </section>
  );
}

function Stat({ label, value, color, title }: {
  label: string;
  value: string;
  color?: string;
  title?: string;
}) {
  return (
    <div
      className="rounded-xl px-3 py-2.5"
      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
      title={title}
    >
      <p className="text-[10px] uppercase tracking-wider text-white/50 mb-1">{label}</p>
      <p className="text-white text-[15px] tabular-nums" style={color ? { color } : undefined}>
        {value}
      </p>
    </div>
  );
}

/**
 * USD formatter that keeps sub-cent tokens readable. `null` is "—" on purpose:
 * the caller must never be able to render an unread figure as a zero.
 */
function fmtUsd(v: number | null, minFrac?: number): string {
  if (v === null) return '—';
  if (minFrac === 0) {
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
    return `$${v.toFixed(0)}`;
  }
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(4)}`;
  if (v >= 0.0001) return `$${v.toFixed(6)}`;
  return `$${v.toFixed(9)}`;
}
