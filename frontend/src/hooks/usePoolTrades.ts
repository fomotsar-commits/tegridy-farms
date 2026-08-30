import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { geckoTerminalTradesSchema, parseOrNull } from '../lib/schemas/geckoTerminal';

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
 */

export interface PoolTrade {
  /** ISO timestamp of the block the fill landed in. */
  at: string;
  kind: 'buy' | 'sell';
  txHash: string;
  wallet: string | null;
  /** Size in the bungalow's own token. Null when unreadable. */
  tokenAmount: number | null;
  usd: number | null;
}

export interface PoolTradesResult {
  trades: PoolTrade[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

function num(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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
        const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}/trades`;
        const res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: unknown = await res.json();
        const parsed = parseOrNull(geckoTerminalTradesSchema, json);
        if (!parsed) throw new Error('Trades response failed schema validation');
        if (cancelled) return;

        const rows: PoolTrade[] = parsed.data.slice(0, limit).map((row) => {
          const a = row.attributes;
          // On a BUY the bungalow token is what you RECEIVE (to_token_amount);
          // on a SELL it is what you GIVE (from_token_amount). Getting this
          // backwards would print the SOL leg as a token size.
          const tokenAmount = a.kind === 'buy'
            ? num(a.to_token_amount)
            : num(a.from_token_amount);
          return {
            at: a.block_timestamp,
            kind: a.kind,
            txHash: a.tx_hash,
            wallet: a.tx_from_address ?? null,
            tokenAmount,
            usd: num(a.volume_in_usd),
          };
        });
        setTrades(rows);
        setError(null);
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
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
