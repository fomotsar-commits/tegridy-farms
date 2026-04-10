import { useState, useEffect, useRef } from 'react';
import { TOWELI_WETH_LP_ADDRESS } from '../lib/constants';

const CACHE_KEY = 'tegridy_price_history';
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const MAX_RETRIES = 2;
const BASE_DELAY = 1000;

interface CachedHistory {
  data: number[];
  ts: number;
}

export interface PriceHistoryResult {
  history: number[];
  error: string | null;
  isLoading: boolean;
}

export function usePriceHistory(currentPrice: number): PriceHistoryResult {
  const [history, setHistory] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const retryCount = useRef(0);

  useEffect(() => {
    if (currentPrice <= 0) return;

    // Check cache
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const parsed: CachedHistory = JSON.parse(cached);
        if (
          Date.now() - parsed.ts < CACHE_DURATION &&
          Array.isArray(parsed.data) &&
          parsed.data.length > 0 &&
          parsed.data.every((v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
        ) {
          setHistory(parsed.data);
          setError(null);
          return;
        }
      }
    } catch {}

    let cancelled = false;
    retryCount.current = 0;

    async function fetchHistory() {
      setIsLoading(true);
      setError(null);

      while (retryCount.current <= MAX_RETRIES) {
        try {
          const url = `https://api.geckoterminal.com/api/v2/networks/eth/pools/${TOWELI_WETH_LP_ADDRESS}/ohlcv/hour?aggregate=1&limit=24`;
          const res = await fetch(url, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(8000),
          });

          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = await res.json();

          const ohlcv = json?.data?.attributes?.ohlcv_list;
          if (Array.isArray(ohlcv) && ohlcv.length >= 2) {
            const closes: number[] = [];
            for (const candle of ohlcv) {
              if (!Array.isArray(candle) || candle.length < 5) continue;
              const close = Number(candle[4]);
              if (!Number.isFinite(close) || close < 0) continue;
              closes.push(close);
            }
            closes.reverse();

            if (closes.length < 2) throw new Error('Insufficient valid OHLCV entries');

            if (!cancelled) {
              setHistory(closes);
              setError(null);
              setIsLoading(false);
              try {
                localStorage.setItem(CACHE_KEY, JSON.stringify({ data: closes, ts: Date.now() }));
              } catch {}
            }
            return;
          }
          throw new Error('Invalid OHLCV data');
        } catch (e) {
          retryCount.current++;
          if (retryCount.current <= MAX_RETRIES) {
            const delay = BASE_DELAY * Math.pow(2, retryCount.current - 1);
            await new Promise((r) => setTimeout(r, delay));
            if (cancelled) return;
          }
        }
      }

      if (!cancelled) {
        setHistory([]);
        setError('Price data unavailable');
        setIsLoading(false);
      }
    }

    fetchHistory();
    return () => { cancelled = true; };
  }, [currentPrice]);

  return { history, error, isLoading };
}
