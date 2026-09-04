import { useState, useEffect, useRef } from 'react';
import { safeGetItem, safeJsonParse, safeSetItem } from '../lib/storage';
import { PRICE_CACHE_VERSION } from './useToweliPrice';
import { TOWELI_MARKET } from '../lib/chart/market';
import { ohlcvUrlFor, readOhlcvBars } from '../lib/chart/ohlcv';

const CACHE_KEY = 'tegridy_price_history';
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const FRESHNESS_SLACK_MS = 60_000;
const MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_RETRIES = 2;
const BASE_DELAY = 1000;
/** One day of hourly closes. The sparkline's whole claim is "the last 24 hours". */
const HISTORY_BUCKETS = 24;

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

// F152: the hook fetches its own 24h close series — it never consumed a
// current-price argument (the sparkline doesn't append live ticks). The dead
// optional param was removed; all call sites now invoke it with no argument.
export function usePriceHistory(): PriceHistoryResult {
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
          // ONE OHLCV READER. The URL and the envelope validation used to be
          // written out here, a second copy of what lib/chart/ohlcv.ts does for
          // /chart — and a second copy of a rule is a rule that drifts. R080's
          // envelope check, the reject-never-repair sanity rule and the
          // duplicate-timestamp rule now all reach this sparkline too, because
          // there is only one place they live.
          const url = ohlcvUrlFor(TOWELI_MARKET, '1h', { limit: HISTORY_BUCKETS });
          const read = await readOhlcvBars(url, fetch, abortController.signal);

          if (!read.ok) {
            // A refusal is NOT retried. GeckoTerminal's keyless limit is shared
            // by every open page in this tab, and re-asking a 429 twice with
            // backoff is how a rate limit becomes a longer one.
            if (read.reason === 'rate-limited') break;
            throw new Error(read.detail);
          }

          // `read.bars` is already ascending and de-duplicated; GeckoTerminal
          // answers newest-first and the sparkline draws left-to-right, so the
          // ordering is the reader's job rather than a `reverse()` here.
          const closes = read.bars.map((bar) => bar.close);
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
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return;
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
