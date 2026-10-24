import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readPoolTrades, type PoolTrade } from '../lib/geckoTerminal/poolTrades';
import { GECKO_FRESHNESS_UNKNOWN, type GeckoFreshness } from '../lib/geckoTerminal/edge';

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
 *
 * AGE (2026-10-15). This hook asks the edge for its last good copy when
 * GeckoTerminal is refusing, so its caller MUST print `freshness` (see
 * geckoAsOfLine). And a new pool starts from an empty tape: the previous pool's
 * fills must never sit under the next pool's ticker while it loads or fails.
 */

export type { PoolTrade };

export interface PoolTradesResult {
  trades: PoolTrade[];
  isLoading: boolean;
  error: string | null;
  /** How old `trades` is, and whether it is a kept copy. Print it with geckoAsOfLine. */
  freshness: GeckoFreshness;
  refresh: () => void;
}

export function usePoolTrades(
  network: string | null,
  pool: string | null,
  limit = 12,
): PoolTradesResult {
  const [trades, setTrades] = useState<PoolTrade[]>([]);
  const [freshness, setFreshness] = useState<GeckoFreshness>(GECKO_FRESHNESS_UNKNOWN);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const shownKeyRef = useRef<string | null>(null);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!network || !pool) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    let cancelled = false;
    const key = `${network}:${pool}`;

    queueMicrotask(async () => {
      if (cancelled) return;
      // A different pool: drop what the last one showed before anything else.
      // A refresh of the SAME pool keeps its tape on screen while it re-reads.
      if (shownKeyRef.current !== key) {
        shownKeyRef.current = key;
        setTrades([]);
        setFreshness(GECKO_FRESHNESS_UNKNOWN);
      }
      setIsLoading(true);
      setError(null);
      try {
        const read = await readPoolTrades(network, pool, { signal: controller.signal, acceptStale: true });
        if (cancelled) return;
        if (read.status === 'read') {
          setTrades(read.trades.slice(0, limit));
          setFreshness({ fetchedAt: read.fetchedAt, stale: read.stale });
          setError(null);
          return;
        }
        // A cancelled read is not a failure and gets no banner: it means this
        // effect was superseded or the view went away.
        if (read.reason === 'aborted') return;
        setError(
          read.reason === 'rate-limited'
            ? 'The trades feed is busy right now. Try again in a minute.'
            : 'Trades could not be read. That is an outage, not an empty tape.',
        );
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    });

    return () => { cancelled = true; controller.abort(); };
  }, [network, pool, limit, nonce]);

  return useMemo(
    () => ({ trades, isLoading, error, freshness, refresh }),
    [trades, isLoading, error, freshness, refresh],
  );
}
