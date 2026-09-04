import { useEffect, useMemo, useRef, useState, memo, useCallback } from 'react';
import { createChart, type IChartApi, type ISeriesApi, ColorType, type CandlestickData, type Time, CandlestickSeries } from 'lightweight-charts';
import {
  TF_CONFIG,
  TOWELI_MARKET,
  chartEmbedUrl,
  chartPoolUrl,
  readChartCandles,
  type ChartCandlesReason,
  type ChartMarket,
  type Timeframe,
} from '../../lib/chart/market';
import { useTheme } from '../../contexts/ThemeContext';

// WHAT A REFUSED READ SAYS. Every branch names the READ, never the market: a
// chart that cannot be drawn because the feed refused us is not a chart of a
// pool with no trades. The fetch itself — one request, no retry of any class, an
// 8s deadline and a bounded cache — lives in lib/chart/market.ts next to the URL
// builder it belongs with; see the PERF-07/PERF-12 note there for why the
// five-attempt 429 backoff that used to sit in this file had to go.
const READ_FAILURE_COPY: Record<ChartCandlesReason, string> = {
  'rate-limited': 'The chart feed is rate-limiting right now. Give it a moment and try again.',
  'not-found': 'The chart feed has no candles for this pool.',
  http: 'The chart feed refused this request.',
  'off-schema': 'The chart feed answered in a shape we will not draw.',
  network: 'The chart feed could not be reached.',
  timeout: 'The chart feed did not answer in time.',
};

// Format tiny prices like 0.00004052 nicely
function formatPrice(price: number): string {
  if (price === 0) return '0';
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.01) return price.toFixed(4);
  if (price >= 0.0001) return price.toFixed(6);
  return price.toFixed(8);
}

function PriceChartInner({ market = TOWELI_MARKET }: { market?: ChartMarket }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [tf, setTf] = useState<Timeframe>('1d');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [useEmbed, setUseEmbed] = useState(false);
  const retryCountRef = useRef(0);
  const { isDark } = useTheme();

  // AUDIT THEME: chart chrome (text, grid lines, axis borders) was hardcoded
  // to white + purple, making light mode a near-illegible light-on-light
  // chart. Candlestick semantic colors (green/red) stay fixed across themes
  // since they encode direction, not brand.
  // R072: pre-compute the full chart-options object via useMemo keyed on
  // [isDark] so the createChart effect's deps are a single stable reference
  // — we only rebuild on actual theme flip rather than on every render.
  const chartOptions = useMemo(() => {
    const chartTextColor = isDark ? 'rgba(255,255,255,1)' : 'rgba(26,26,26,0.88)';
    const chartGridColor = isDark ? 'rgba(139,92,246,0.1)' : 'rgba(26,26,26,0.08)';
    const chartAxisColor = isDark ? 'rgba(139,92,246,0.1)' : 'rgba(26,26,26,0.14)';
    return {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' as const },
        textColor: chartTextColor,
        fontSize: 11,
      },
      grid: {
        vertLines: { color: chartGridColor },
        horzLines: { color: chartGridColor },
      },
      crosshair: {
        vertLine: { color: 'rgba(139,92,246,0.3)', labelBackgroundColor: '#7c3aed' },
        horzLine: { color: 'rgba(139,92,246,0.3)', labelBackgroundColor: '#7c3aed' },
      },
      rightPriceScale: {
        borderColor: chartAxisColor,
        scaleMargins: { top: 0.15, bottom: 0.15 },
      },
      timeScale: {
        borderColor: chartAxisColor,
        timeVisible: true,
        secondsVisible: false,
      },
      localization: {
        priceFormatter: formatPrice,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true },
    };
  }, [isDark]);

  // Create chart once per theme flip.
  useEffect(() => {
    if (!containerRef.current || useEmbed) return;

    const chart = createChart(containerRef.current, {
      ...chartOptions,
      layout: { ...chartOptions.layout, background: { type: ColorType.Solid, color: 'transparent' } },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: 'rgba(34,197,94,0.6)',
      wickDownColor: 'rgba(239,68,68,0.6)',
      priceFormat: {
        type: 'custom',
        formatter: formatPrice,
        // lightweight-charts v5 requires `minMove` on PriceFormatCustom
        // (the field is non-optional in the typings, but addSeries accepts
        // a Partial so TS doesn't catch it). Without it the series builds
        // a null tick step and throws "Value is null" from the internal
        // price-line constructor on setData. TOWELI prices reach 1e-8, so
        // pin minMove there to avoid snapping visible bars to one level.
        minMove: 0.00000001,
      },
    });

    chartRef.current = chart;
    seriesRef.current = series;

    let rafId: number | null = null;
    const ro = new ResizeObserver((entries) => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          chart.applyOptions({ width, height });
        }
        rafId = null;
      });
    });
    ro.observe(containerRef.current);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    // Recreate the chart when the theme changes so the new text / grid
    // / axis palette takes effect. lightweight-charts has applyOptions,
    // but it doesn't propagate every chrome field — a remount is the
    // safe, small fix.
  }, [useEmbed, chartOptions]);

  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const loadData = useCallback((timeframe: Timeframe) => {
    if (useEmbed) return;

    // Abort any in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const requestId = ++requestIdRef.current;

    setLoading(true);
    setError(null);

    readChartCandles(market, timeframe, { signal: controller.signal })
      .then((read) => {
        // Guard against race condition: ignore if a newer request was made
        if (requestId !== requestIdRef.current) return;
        if (!seriesRef.current) return;

        if (!read.ok) {
          // A REFUSAL IS NOT AN OUTAGE OF THIS COMPONENT. Two failed reads still
          // fall through to GeckoTerminal's own embed (which answers from their
          // origin and their budget), but the reason is named on the way there
          // rather than collapsed into "Chart unavailable".
          retryCountRef.current += 1;
          if (retryCountRef.current >= 2) {
            setUseEmbed(true);
            setLoading(false);
            setError(null);
          } else {
            setError(READ_FAILURE_COPY[read.reason]);
            setLoading(false);
          }
          return;
        }

        // lightweight-charts wants strictly ascending unique `time` values and a
        // positive price on every field. readOhlcvBars already guarantees both —
        // it sorts, keeps the last bar per timestamp, and DROPS a bar whose high
        // sits below its close rather than clamping it into a shape that draws.
        // This map therefore invents nothing; the old inline reader repaired the
        // OHLC here, which put an ordering on screen that nobody traded.
        const bars: CandlestickData<Time>[] = read.bars.map((b) => ({
          time: b.timeSec as unknown as Time,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
        }));

        if (bars.length === 0) {
          setError('The chart feed returned no candles for this pool.');
          setLoading(false);
          return;
        }
        retryCountRef.current = 0;
        try {
          seriesRef.current.setData(bars);
          chartRef.current?.timeScale().fitContent();
        } catch (chartErr) {
          console.warn('Chart setData error, falling back to embed:', chartErr);
          setUseEmbed(true);
        }
        setLoading(false);
      })
      .catch((err) => {
        // readChartCandles only rejects for an abort the CALLER asked for —
        // every read failure comes back as a tagged reason above.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (requestId !== requestIdRef.current) return;
        console.warn('Chart read threw:', err);
        setError('Chart unavailable');
        setLoading(false);
      });
  }, [useEmbed, market]);

  // Fetch data on timeframe change; abort on unmount.
  // R007 Pattern C — defer the loadData call (which does synchronous
  // setLoading/setError) via microtask + cancelled guard so the lint rule
  // doesn't flag it as a synchronous setState-in-effect.
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      loadData(tf);
    });
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [tf, loadData]);

  // If in embed mode, show GeckoTerminal iframe
  if (useEmbed) {
    return (
      <div className="w-full h-full flex flex-col">
        <div className="flex items-center gap-1 mb-2 px-1">
          <a
            href={chartPoolUrl(market)}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-white/60 hover:text-white text-[10px] transition-colors"
          >
            GeckoTerminal &#8599;
          </a>
        </div>
        <div className="flex-1 relative min-h-0">
          {/* R072: tightened iframe sandbox — `allow-same-origin` + `allow-scripts`
              together is equivalent to no sandbox at all (scripts can escape).
              GeckoTerminal's chart iframe is a third-party origin already, so
              it doesn't need same-origin to render its own assets. Removing it
              is the tightest sandbox that still lets the chart be interactive. */}
          <iframe
            src={chartEmbedUrl(market)}
            className="absolute inset-0 w-full h-full"
            style={{ border: 'none', borderRadius: '8px' }}
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            title={`${market.label} price chart`}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex items-center gap-1 mb-2 px-1 min-h-[44px]">
        {(Object.keys(TF_CONFIG) as Timeframe[]).map((key) => (
          <button
            key={key}
            onClick={() => setTf(key)}
            aria-pressed={tf === key}
            className={`px-2.5 py-1 min-h-[44px] rounded text-[11px] font-medium transition-all ${
              tf === key ? 'text-white' : 'text-white/55 hover:text-white'
            }`}
            style={tf === key ? { background: 'var(--color-purple-25)', border: '1px solid var(--color-purple-40)' } : { border: '1px solid transparent' }}
          >
            {TF_CONFIG[key].label}
          </button>
        ))}
        <a
          href={chartPoolUrl(market)}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-white/60 hover:text-white text-[10px] transition-colors"
        >
          GeckoTerminal &#8599;
        </a>
      </div>

      <div className="flex-1 relative min-h-0">
        <div ref={containerRef} className="absolute inset-0" />
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              <span className="text-white text-[12px]">Loading chart...</span>
            </div>
          </div>
        )}
        {error && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 z-10">
            <span className="text-white text-[12px]">{error}</span>
            <button
              onClick={() => loadData(tf)}
              className="px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all cursor-pointer"
              style={{ background: 'var(--color-purple-20)', color: '#ffffff', border: '1px solid var(--color-purple-30)' }}
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export const PriceChart = memo(PriceChartInner);
