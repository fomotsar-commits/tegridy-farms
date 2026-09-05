import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { geckoTerminalPoolSchema, parseOrNull } from '../lib/schemas/geckoTerminal';

/**
 * Live market facts for ONE liquidity pool, from GeckoTerminal.
 *
 * Built 2026-08-28 for the bungalow market strip. A bungalow trades its own
 * token on its own chain (BAYLA/SOL on PumpSwap, Solana) and the venue had no
 * way to state a single number about it — no price, no volume, no liquidity.
 *
 * HONESTY CONTRACT, same shape as the rest of the venue:
 *  - every field is `number | null`; null means NOT READ, and the UI must
 *    render it as "—", never as 0. A pool with no trades in 24h really does
 *    report volume 0, and that zero is a different fact from an outage;
 *  - `marketCapUsd` is null for most pump.fun tokens (no circulating-supply
 *    record upstream). Callers show `fdvUsd` labelled FDV instead of silently
 *    printing one under the other's name;
 *  - a failed fetch sets `error` and leaves the previous values alone rather
 *    than blanking the strip to zeros.
 *
 * READ THROUGH THE EDGE, not direct (changed 2026-09-04). This used to fetch
 * api.geckoterminal.com straight from the browser, and the paragraph here said
 * "there is no same-origin proxy for it in production, so adding one here would
 * need an operator step". That was true when it was written and stopped being
 * true when `?resource=launch-radar` shipped: the same keyless host is already
 * proxied through the aggregator catchall with no operator step and no new
 * function slot, so the plumbing this needed already existed and the comment was
 * the only thing still saying otherwise.
 *
 * The field review of 2026-09-04 found the consequence — a first load showed the
 * whole strip, a reload minutes later showed dashes across all of it, because
 * every visitor spent their own keyless budget two calls per page view.
 *
 * What fixes it is the `s-maxage` on the proxy, not the proxy: the edge answers,
 * so upstream sees roughly one request per pool per 45s however many people are
 * reading. See api/_lib/pool-market.js for why the header is load-bearing.
 *
 * The response is forwarded verbatim, so the R080 schema validation below is
 * unchanged and still the only place this JSON is parsed.
 */

export interface PoolMarket {
  /** Pool display name upstream, e.g. "BAYLA / SOL". */
  name: string | null;
  priceUsd: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  /** Total liquidity in the pool, USD. */
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  change24hPct: number | null;
  buys24h: number | null;
  sells24h: number | null;
  buyers24h: number | null;
  sellers24h: number | null;
}

export interface PoolMarketResult {
  market: PoolMarket | null;
  isLoading: boolean;
  error: string | null;
  /** Re-read on demand. Nothing here polls on its own. */
  refresh: () => void;
}

const EMPTY: PoolMarket = {
  name: null,
  priceUsd: null,
  fdvUsd: null,
  marketCapUsd: null,
  liquidityUsd: null,
  volume24hUsd: null,
  change24hPct: null,
  buys24h: null,
  sells24h: null,
  sellers24h: null,
  buyers24h: null,
};

/** String → finite number, or null. Never NaN, never a silent 0. */
function num(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function usePoolMarket(
  network: string | null,
  pool: string | null,
): PoolMarketResult {
  const [market, setMarket] = useState<PoolMarket | null>(null);
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

    // R007 Pattern C — the synchronous setState is deferred out of the effect
    // body so the lint rule doesn't flag a cascading render.
    queueMicrotask(async () => {
      if (cancelled) return;
      setIsLoading(true);
      setError(null);
      try {
        const url = `/api/aggregator?resource=pool-market&network=${encodeURIComponent(network)}&pool=${encodeURIComponent(pool)}`;
        const res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: unknown = await res.json();

        // Validate the whole envelope before a single number reaches the UI —
        // same rule as R080 on the other two GeckoTerminal readers.
        const parsed = parseOrNull(geckoTerminalPoolSchema, json);
        if (!parsed) throw new Error('Pool response failed schema validation');

        const a = parsed.data.attributes;
        const tx = a.transactions?.h24;
        if (cancelled) return;
        setMarket({
          ...EMPTY,
          name: a.name ?? null,
          priceUsd: num(a.base_token_price_usd),
          fdvUsd: num(a.fdv_usd),
          marketCapUsd: num(a.market_cap_usd),
          liquidityUsd: num(a.reserve_in_usd),
          volume24hUsd: num(a.volume_usd?.h24),
          change24hPct: num(a.price_change_percentage?.h24),
          buys24h: int(tx?.buys),
          sells24h: int(tx?.sells),
          buyers24h: int(tx?.buyers),
          sellers24h: int(tx?.sellers),
        });
        setError(null);
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        // Leave any previously read values in place — a dropped refresh must
        // not repaint real numbers as blanks.
        setError('Market data could not be read — that is an outage, not a zero.');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    });

    return () => { cancelled = true; controller.abort(); };
  }, [network, pool, nonce]);

  return useMemo(
    () => ({ market, isLoading, error, refresh }),
    [market, isLoading, error, refresh],
  );
}
