import { useEffect, useRef, useState, memo, useCallback } from 'react';
import { createChart, type IChartApi, type ISeriesApi, ColorType, type CandlestickData, type Time, CandlestickSeries } from 'lightweight-charts';
import { TOWELI_WETH_LP_ADDRESS, GECKOTERMINAL_URL } from '../../lib/constants';

type Timeframe = '1h' | '4h' | '1d' | '1w';

const TF_CONFIG: Record<Timeframe, { apiTf: string; aggregate: string; label: string; limit: number }> = {
  '1h': { apiTf: 'hour', aggregate: '1', label: '1H', limit: 168 },
  '4h': { apiTf: 'hour', aggregate: '4', label: '4H', limit: 90 },
  '1d': { apiTf: 'day', aggregate: '1', label: '1D', limit: 90 },
  '1w': { apiTf: 'day', aggregate: '7', label: '1W', limit: 52 },
};

const GECKO_EMBED_URL = `https://www.geckoterminal.com/eth/pools/${TOWELI_WETH_LP_ADDRESS}?embed=1&info=0&swaps=0&grayscale=0&light_chart=0`;

// In-memory cache
const ohlcvCache: Record<string, { data: CandlestickData<Time>[]; ts: number }> = {};
const CACHE_TTL = 60_000;

async function fetchWithRetry(url: string, retries = 5, delay = 800, signal?: AbortSignal): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { signal });
      if (res.ok) return res;
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, delay * (i + 1) * 2));
        continue;
      }
      return res;
    } catch (err) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delay * (i + 1)));
    }
  }
  throw new Error('Max retries reached');
}

async function fetchOHLCV(tf: Timeframe, signal?: AbortSignal): Promise<CandlestickData<Time>[]> {
  const cacheKey = tf;
  const cached = ohlcvCache[cacheKey];
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const cfg = TF_CONFIG[tf];
  // Use same-origin proxy to avoid Edge/Safari tracking prevention blocking cross-origin API calls
  const url = `https://api.geckoterminal.com/api/v2/networks/eth/pools/${TOWELI_WETH_LP_ADDRESS}/ohlcv/${cfg.apiTf}?aggregate=${cfg.aggregate}&limit=${cfg.limit}&currency=usd`;

  const res = await fetchWithRetry(url, 5, 800, signal);
  if (!res.ok) throw new Error(`API ${res.status}`);
  const json = await res.json();
  const list = json?.data?.attributes?.ohlcv_list ?? [];

  const raw = (Array.isArray(list) ? list : [])
    .map((bar: unknown) => {
      if (!Array.isArray(bar) || bar.length < 5) return null;
      const [ts, o, h, l, c] = bar;
      const vals = { open: Number(o), high: Number(h), low: Number(l), close: Number(c) };
      const time = Math.floor(Number(ts));
      if (!Number.isFinite(time) || !Number.isFinite(vals.open) || !Number.isFinite(vals.high) || !Number.isFinite(vals.low) || !Number.isFinite(vals.close)) return null;
      // lightweight-charts throws "Value is null" if OHLC values are 0 or invalid
      if (vals.open <= 0 || vals.high <= 0 || vals.low <= 0 || vals.close <= 0) return null;
      // Ensure OHLC ordering: high must be highest, low must be lowest
      vals.high = Math.max(vals.open, vals.high, vals.low, vals.close);
      vals.low = Math.min(vals.open, vals.low, vals.high, vals.close);
      return { time: (time as unknown) as Time, ...vals };
    })
    .filter((b): b is CandlestickData<Time> => b !== null);
  const bars = raw.sort((a, b) => (a.time as number) - (b.time as number));

  if (Object.keys(ohlcvCache).length > 8) {
    for (const k of Object.keys(ohlcvCache)) delete ohlcvCache[k];
  }
  ohlcvCache[cacheKey] = { data: bars, ts: Date.now() };
  return bars;
}

// Format tiny prices like 0.00004052 nicely
function formatPrice(price: number): string {
  if (price === 0) return '0';
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.01) return price.toFixed(4);
  if (price >= 0.0001) return price.toFixed(6);
  return price.toFixed(8);
}

function PriceChartInner() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [tf, setTf] = useState<Timeframe>('1d');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [useEmbed, setUseEmbed] = useState(false);
  const retryCountRef = useRef(0);

  // Create chart once
  useEffect(() => {
    if (!containerRef.current || useEmbed) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: 'rgba(255,255,255,1)',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(139,92,246,0.1)' },
        horzLines: { color: 'rgba(139,92,246,0.1)' },
      },
      crosshair: {
        vertLine: { color: 'rgba(139,92,246,0.3)', labelBackgroundColor: '#7c3aed' },
        horzLine: { color: 'rgba(139,92,246,0.3)', labelBackgroundColor: '#7c3aed' },
      },
      rightPriceScale: {
        borderColor: 'rgba(139,92,246,0.1)',
        scaleMargins: { top: 0.15, bottom: 0.15 },
      },
      timeScale: {
        borderColor: 'rgba(139,92,246,0.1)',
        timeVisible: true,
        secondsVisible: false,
      },
      localization: {
        priceFormatter: formatPrice,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true },
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
  }, [useEmbed]);

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

    fetchOHLCV(timeframe, controller.signal)
      .then((bars) => {
        // Guard against race condition: ignore if a newer request was made
        if (requestId !== requestIdRef.current) return;
        if (!seriesRef.current) return;
        if (bars.length === 0) {
          setError('No chart data available');
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
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (requestId !== requestIdRef.current) return;
        console.warn('Chart fetch failed:', err);
        retryCountRef.current += 1;
        // After 2 failed attempts, fall back to GeckoTerminal embed
        if (retryCountRef.current >= 2) {
          setUseEmbed(true);
          setLoading(false);
          setError(null);
        } else {
          setError('Chart unavailable');
          setLoading(false);
        }
      });
  }, [useEmbed]);

  // Fetch data on timeframe change; abort on unmount
  useEffect(() => {
    loadData(tf);
    return () => {
      abortRef.current?.abort();
    };
  }, [tf, loadData]);

  // If in embed mode, show GeckoTerminal iframe
  if (useEmbed) {
    return (
      <div className="w-full h-full flex flex-col">
        <div className="flex items-center gap-1 mb-2 px-1">
          <a
            href={GECKOTERMINAL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-white hover:text-white text-[10px] transition-colors"
          >
            GeckoTerminal &#8599;
          </a>
        </div>
        <div className="flex-1 relative min-h-0">
          <iframe
            src={GECKO_EMBED_URL}
            className="absolute inset-0 w-full h-full"
            style={{ border: 'none', borderRadius: '8px' }}
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
            title="TOWELI Price Chart"
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
            className={`px-2.5 py-1 min-h-[44px] rounded text-[11px] font-medium transition-all ${
              tf === key ? 'text-white' : 'text-white hover:text-white'
            }`}
            style={tf === key ? { background: 'var(--color-purple-25)', border: '1px solid var(--color-purple-40)' } : { border: '1px solid transparent' }}
          >
            {TF_CONFIG[key].label}
          </button>
        ))}
        <a
          href={GECKOTERMINAL_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-white hover:text-white text-[10px] transition-colors"
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
