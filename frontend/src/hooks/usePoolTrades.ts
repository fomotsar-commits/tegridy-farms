import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readPoolTrades, type PoolTrade } from '../lib/geckoTerminal/poolTrades';

/**
 * Recent trades for ONE pool, from GeckoTerminal.
 *
 * Backs the bungalow trade tape. The venue's LiveActivity pill is TOWELI-
 * denominated and deliberately muted inside a bungalow, which left a token's
 * own page with no sign of life at all — this is the honest replacement: real
 * fills on the bungalow's own pool, each one linkable to its transaction.
 *
 * NOTHING POLLS. One read per mount plus a caller-driven refresh, same rule as
 * usePoolMarket. A tape that refreshed itself would imply a stream this venue
 * does not run.
 *
 * The fetch, the schema and the buy/sell leg rule now live in
 * lib/geckoTerminal/poolTrades.ts, which the non-component surfaces read too.
 * What is left here is React: an abort on re-key, a refresh nonce, and the
 * translation from that module's state union into this hook's flat
 * `{ trades, isLoading, error }` — unchanged, because components depend on it.
 */

export type { PoolTrade };

export interface PoolTradesResult {
  trades: PoolTrade[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function usePoolTrades(
  network: string | null,
  pool: string | null,
  limit = 12,
): PoolTradesResult {
  const [trades, setTrades] = useState<PoolTrade[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!network || !pool) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    let cancelled = false;

    queueMicrotask(async () => {
      if (cancelled) return;
      setIsLoading(true);
      setError(null);
      try {
        const read = await readPoolTrades(network, pool, { signal: controller.signal });
        if (cancelled) return;
        if (read.status === 'read') {
          setTrades(read.trades.slice(0, limit));
          setError(null);
          return;
        }
        // A cancelled read is not a failure and gets no banner: it means this
        // effect was superseded or the view went away.
        if (read.reason === 'aborted') return;
        setError('Trades could not be read — that is an outage, not an empty tape.');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    });

    return () => { cancelled = true; controller.abort(); };
  }, [network, pool, limit, nonce]);

  return useMemo(
    () => ({ trades, isLoading, error, refresh }),
    [trades, isLoading, error, refresh],
  );
}
