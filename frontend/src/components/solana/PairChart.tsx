// Collapsed-by-default price chart for the swap page's buy token, fed by
// GeckoTerminal (already in the CSP connect-src; see lib/solanaChart.ts).
// No @solana/* imports here, so the solanaPolyfill entry import is NOT needed.
//
// HARD RULE: no market cap / FDV anywhere in this DOM — the Solana surfaces
// deliberately render no market-cap/FDV numbers (house "no-FDV" rule). Only
// the close-price series and its range change are shown.
import { useEffect, useState } from 'react';
import {
  fetchTokenOhlcv,
  linePath,
  areaPath,
  rangeChangePct,
  formatChartPrice,
  type ChartTimeframe,
  type OhlcvPoint,
} from '../../lib/solanaChart';

const TIMEFRAMES: ChartTimeframe[] = ['1H', '1D', '1W'];

// viewBox space; the SVG stretches to 100% width (preserveAspectRatio="none")
// with vectorEffect keeping the stroke at a true 1.5px.
const VIEW_W = 320;
const VIEW_H = 120;

interface PairChartProps {
  /** Base58 SPL mint of the buy token. */
  mint: string;
  symbol: string;
}

function PairChartInner({ mint, symbol }: PairChartProps) {
  const [expanded, setExpanded] = useState(false);
  const [tf, setTf] = useState<ChartTimeframe>('1D');
  const [points, setPoints] = useState<OhlcvPoint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // Fetch on first expand and on timeframe change while expanded — never while
  // collapsed. All setState runs inside the deferred timeout/promise callbacks
  // (never the synchronous effect body) so it can't trigger cascading renders.
  useEffect(() => {
    if (!expanded) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setLoading(true);
      setFailed(false);
      fetchTokenOhlcv(mint, tf, ctrl.signal)
        .then((pts) => {
          if (ctrl.signal.aborted) return;
          setPoints(pts);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
          setPoints(null);
          setLoading(false);
          setFailed(true);
        });
    }, 0);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [expanded, tf, mint]);

  const hasChart = points !== null && points.length > 0;
  const last = hasChart ? points[points.length - 1] : undefined;
  const chg = hasChart ? rangeChangePct(points) : null;

  return (
    <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.10)' }}>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between px-3 py-2.5 min-h-[40px] text-left hover:bg-white/5 transition-colors"
      >
        <span className="text-white text-[12px] font-medium">{symbol} price chart</span>
        <span className="text-white/60 text-[12px]" aria-hidden="true">{expanded ? '▴' : '▾'}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="flex gap-1.5" role="group" aria-label="Chart range">
              {TIMEFRAMES.map((t) => {
                const active = tf === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTf(t)}
                    aria-pressed={active}
                    className="px-3 py-1.5 min-h-[40px] rounded-full text-white text-[10px] font-medium transition-colors"
                    style={{
                      background: active ? 'var(--color-stan)' : 'rgba(0,0,0,0.45)',
                      border: active ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.12)',
                    }}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
            {last && (
              <div className="text-right min-w-0">
                <div className="text-white text-[13px] font-mono font-medium truncate">{formatChartPrice(last.close)}</div>
                {chg !== null && (
                  <div className={`text-[10px] font-mono ${chg >= 0 ? 'text-success' : 'text-red-300'}`}>
                    {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
                  </div>
                )}
              </div>
            )}
          </div>

          {loading && !hasChart ? (
            <div className="h-[120px] rounded-lg animate-pulse" style={{ background: 'rgba(255,255,255,0.06)' }} aria-label="Loading chart" />
          ) : hasChart ? (
            <svg
              viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
              preserveAspectRatio="none"
              className="w-full block"
              style={{ height: '120px' }}
              role="img"
              aria-label={`${symbol} price chart, ${tf}`}
            >
              <path d={areaPath(points, VIEW_W, VIEW_H)} fill="rgba(255,255,255,0.06)" stroke="none" />
              <path
                d={linePath(points, VIEW_W, VIEW_H)}
                fill="none"
                stroke="var(--color-stan)"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
          ) : failed || points !== null ? (
            // New tokens often have no indexed pool yet — one honest line, no
            // fake flatline.
            <p className="text-white/60 text-[12px] py-4 text-center">Chart unavailable for this pair.</p>
          ) : null}

          <p className="text-white/55 text-[10px] mt-1.5">data: GeckoTerminal</p>
        </div>
      )}
    </div>
  );
}

export function PairChart({ mint, symbol }: PairChartProps) {
  // key={mint} remounts the inner component when the buy token changes, which
  // resets to collapsed, clears the series, and aborts any in-flight fetch —
  // no setState in render or in a synchronous effect body needed.
  return <PairChartInner key={mint} mint={mint} symbol={symbol} />;
}
