import { useState, useEffect } from 'react';
import { TOWELI_WETH_LP_ADDRESS } from '../lib/constants';

const CACHE_KEY = 'tegridy_price_history';
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

/**
 * Mock 24-point price data based on current price with realistic-looking variance.
 * Used as fallback when API is unavailable.
 */
function generateMockHistory(currentPrice: number): number[] {
  if (currentPrice <= 0) return [];
  const points: number[] = [];
  let p = currentPrice * (0.92 + Math.random() * 0.08); // start slightly below current
  for (let i = 0; i < 24; i++) {
    // Random walk with slight upward bias towards current price
    const drift = (currentPrice - p) * 0.05;
    const noise = (Math.random() - 0.48) * currentPrice * 0.04;
    p = Math.max(p * 0.8, p + drift + noise);
    points.push(p);
  }
  // Ensure last point matches current price
  points[23] = currentPrice;
  return points;
}

interface CachedHistory {
  data: number[];
  ts: number;
}

export function usePriceHistory(currentPrice: number) {
  const [history, setHistory] = useState<number[]>([]);

  useEffect(() => {
    if (currentPrice <= 0) return;

    // Check cache
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const parsed: CachedHistory = JSON.parse(cached);
        if (Date.now() - parsed.ts < CACHE_DURATION && parsed.data.length > 0) {
          setHistory(parsed.data);
          return;
        }
      }
    } catch {}

    let cancelled = false;

    async function fetchHistory() {
      try {
        // GeckoTerminal OHLCV endpoint for the TOWELI/WETH pool
        const url = `https://api.geckoterminal.com/api/v2/networks/eth/pools/${TOWELI_WETH_LP_ADDRESS}/ohlcv/hour?aggregate=1&limit=24`;
        const res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();

        const ohlcv = json?.data?.attributes?.ohlcv_list;
        if (Array.isArray(ohlcv) && ohlcv.length >= 2) {
          // ohlcv_list is newest-first: [timestamp, open, high, low, close, volume]
          // We want oldest-first close prices
          const closes = ohlcv
            .map((candle: number[]) => candle[4]) // close price
            .reverse();

          if (!cancelled) {
            setHistory(closes);
            try {
              localStorage.setItem(CACHE_KEY, JSON.stringify({ data: closes, ts: Date.now() }));
            } catch {}
          }
          return;
        }
        throw new Error('Invalid OHLCV data');
      } catch {
        // Fallback to mock data
        if (!cancelled) {
          const mock = generateMockHistory(currentPrice);
          setHistory(mock);
        }
      }
    }

    fetchHistory();
    return () => { cancelled = true; };
  }, [currentPrice]);

  return history;
}
