import { useState, useEffect, useRef } from 'react';
import { TOWELI_WETH_LP_ADDRESS } from '../lib/constants';
import { safeGetItem, safeJsonParse, safeSetItem } from '../lib/storage';
import { PRICE_CACHE_VERSION } from './useToweliPrice';

const CACHE_KEY = 'tegridy_price_history';
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const FRESHNESS_SLACK_MS = 60_000;
const MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_RETRIES = 2;
const BASE_DELAY = 1000;

interface CachedHistory {
  version: number;
  data: number[];
  signedAt: number;
}

export interface PriceHistoryResult {
  history: number[];
  error: string | null;
  isLoading: boolean;
}

export function usePriceHistory(_currentPrice?: number): PriceHistoryResult {
  const [history, setHistory] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const retryCount = useRef(0);

  useEffect(() => {

    // R075: versioned-cache read with signedAt freshness check. Reject any
    // entry that fails the version pin, has a future signedAt (>60s slack),
    // or is older than 24h. CACHE_DURATION still gates "fresh enough" for
    // the in-session display path.
    const raw = safeGetItem(CACHE_KEY);
    const parsed = safeJsonParse<Partial<CachedHistory>>(raw, {} as Partial<CachedHistory>);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.version === PRICE_CACHE_VERSION &&
      typeof parsed.signedAt === 'number' &&
      Number.isFinite(parsed.signedAt) &&
      parsed.signedAt <= Date.now() + FRESHNESS_SLACK_MS &&
      Date.now() - parsed.signedAt <= MAX_AGE_MS &&
      Date.now() - parsed.signedAt < CACHE_DURATION &&
      Array.isArray(parsed.data) &&
      parsed.data.length > 0 &&
      parsed.data.every((v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    ) {
      setHistory(parsed.data as number[]);
      setError(null);
      return;
    }
    // Drop schema-mismatched entries so they don't fill the eviction queue.
    if (raw && parsed && parsed.version !== PRICE_CACHE_VERSION) {
      try { localStorage.removeItem(CACHE_KEY); } catch { /* noop */ }
    }

    const abortController = new AbortController();
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
            signal: abortController.signal,
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
              // R075: versioned write — version + signedAt stamped on every save.
              const entry: CachedHistory = {
                version: PRICE_CACHE_VERSION,
                data: closes,
                signedAt: Date.now(),
              };
              safeSetItem(CACHE_KEY, JSON.stringify(entry));
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
    return () => { cancelled = true; abortController.abort(); };
  }, []);

  return { history, error, isLoading };
}
