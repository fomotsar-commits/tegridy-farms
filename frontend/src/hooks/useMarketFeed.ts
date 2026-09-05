import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  geckoPoolsMultiUrl,
  geckoPoolsUrl,
  readGeckoPools,
  type GeckoNetwork,
  type MarketRow,
} from '../lib/geckoTerminal/pools';
import type { MarketFeedState } from '../lib/terminal/feedBanner';

// The terminal's market feed: one (network, view) at a time, read BROWSER-DIRECT.
//
// WHY NOT THE SAME-ORIGIN PROXY. This app already has a GeckoTerminal proxy at
// /api/aggregator?resource=launch-radar, and using it here would be the obvious
// move. It USED to be the wrong one outright: that proxy collapsed a 429, a 5xx and
// an unparseable body into HTTP 200 with an empty list and let the CDN cache that
// empty list for a minute — on a discovery feed, the single worst output this page
// can produce: a confident, cached, empty table asserting that nothing is launching,
// produced by a rate limit. api/_lib/launch-radar.js now answers an unread window
// with a 502 and no Cache-Control, so that hazard is gone.
//
// This still reads direct, for the remaining reason: the proxy serves a FIXED
// two-page `new_pools` window on one network, and this page needs new/trending and
// specific-pool views per network — with a refusal that arrives AS a refusal and
// gets its own banner.
//
// NOTHING POLLS. One read per (network, view), plus a caller-driven re-read.
// Same rule as usePoolMarket and usePoolTrades. An auto-refreshing table would
// imply a stream this venue does not run, and against a keyless API with a
// per-IP limit it would also manufacture the 429 it then reported.
//
// THE CACHE PREVENTS REQUESTS, IT NEVER CAUSES THEM. Flipping between tabs is
// the normal way to use this page and each flip is a fresh mount of the same
// request. Sixty seconds of module-level memory turns "click through three
// networks and back" into three reads rather than six — which matters when four
// rapid reads from one address is enough to be refused. `reload()` bypasses it,
// because a manual re-read that returned cached rows would be a lie about the
// word on the button.

export type MarketFeedRequest =
  | { view: 'list'; network: GeckoNetwork; list: 'new' | 'trending' }
  /** Specific pools by address — backs the island and watchlist views. */
  | { view: 'multi'; network: GeckoNetwork; pools: readonly string[] };

export interface MarketFeedResult {
  state: MarketFeedState;
  /** Re-read now, bypassing the cache. */
  reload: () => void;
}

/** How long a read stays reusable. Short enough that a re-mount is fresh news. */
export const MARKET_FEED_TTL_MS = 60_000;

interface CacheEntry {
  rows: MarketRow[];
  dropped: number;
  /** Unix SECONDS — the moment the response was parsed, not the moment it is read back. */
  readAt: number;
  /** Wall-clock ms, for TTL only. */
  storedAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * PERF-08 (2026-09-03): this cache had no ceiling and no eviction — it was only
 * ever written. Its `multi:` keys are derived from the VISITOR'S WATCHLIST, so
 * the key space is user-controlled: every distinct set of starred pools the
 * reader passes through left a permanent entry holding up to 30 parsed rows for
 * the life of the tab. Starring and unstarring across a session is a normal
 * thing to do and it grew the map without bound.
 *
 * `Map` iterates in insertion order, so `keys().next()` is the oldest entry.
 * ONE entry goes, not the whole map: clearing everything means a reader who
 * crosses the ceiling then pays a fresh GeckoTerminal read — from a keyless
 * budget shared with every other surface in the tab — for every view they
 * switch back to, which is the bug this file's TTL exists to avoid.
 */
export const MARKET_FEED_CACHE_MAX = 16;

/** Test seam. A module-level cache that survives between tests is a flake farm. */
export function __resetMarketFeedCacheForTests(): void {
  cache.clear();
}

function cacheSet(key: string, entry: CacheEntry): void {
  // Re-inserting an existing key must not evict anything: delete-then-set also
  // refreshes its position, so a key the reader keeps coming back to stays.
  if (cache.delete(key)) {
    cache.set(key, entry);
    return;
  }
  if (cache.size >= MARKET_FEED_CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, entry);
}

/** Test seam for the bound above; the hook itself is a React effect. */
export function __marketFeedCacheSizeForTests(): number {
  return cache.size;
}

function requestUrl(req: MarketFeedRequest): string | null {
  if (req.view === 'list') return geckoPoolsUrl(req.network, req.list);
  // An empty `multi` list would build `…/pools/multi/` — a URL that asks about
  // nothing and answers 404, which this page would then have to render as a
  // failed read. "You have starred nothing on this network" is not a failed
  // read, so no request is made and the caller says so in words instead.
  if (req.pools.length === 0) return null;
  // Every address is validated against the network's regex inside this builder
  // before it becomes part of a path segment. Nothing here trusts its caller.
  return geckoPoolsMultiUrl(req.network, [...req.pools]);
}

/**
 * The cache key must contain everything that changes the ANSWER.
 *
 * For `multi` that includes the exact pool list: two watchlists of the same
 * length on the same network are different questions, and a key that ignored the
 * list would serve one the other's rows. Sorted so the same set in a different
 * order is one entry rather than two.
 */
function cacheKey(req: MarketFeedRequest): string {
  return req.view === 'list'
    ? `list:${req.network}:${req.list}`
    : `multi:${req.network}:${[...req.pools].sort().join(',')}`;
}

/**
 * A settled read, TAGGED WITH THE REQUEST IT ANSWERS.
 *
 * The tag is not bookkeeping. Without it, switching from Ethereum to Solana
 * renders Ethereum's rows for one frame underneath a banner that already says
 * "Solana" — a table whose rows and whose attribution disagree, which is the
 * exact class of quiet lie this page exists to refuse. Holding the key beside
 * the state means a result can only ever be shown for the request it answers;
 * anything else is `loading`.
 */
interface Settled {
  key: string;
  state: Extract<MarketFeedState, { status: 'ready' } | { status: 'unreachable' }>;
}

const LOADING: MarketFeedState = { status: 'loading' };
const IDLE: MarketFeedState = { status: 'idle' };

export function useMarketFeed(req: MarketFeedRequest | null): MarketFeedResult {
  const [settled, setSettled] = useState<Settled | null>(null);
  const [nonce, setNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // The request object is rebuilt by the caller every render (it is a literal),
  // so the effect keys on its VALUE rather than its identity. Without this the
  // effect re-fires forever and the cache would be the only thing standing
  // between this page and a permanent 429.
  const url = req ? requestUrl(req) : null;
  const key = req && url ? cacheKey(req) : null;

  // Idle and loading are DERIVED rather than written into state. Nothing here
  // needs to remember them, and setting them from inside the effect would both
  // cascade a render and open the cross-request window described above.
  const state: MarketFeedState = !key ? IDLE : settled?.key === key ? settled.state : LOADING;

  useEffect(() => {
    if (!url || !key) return;

    // A manual re-read must reach the upstream; an automatic one may be served
    // from memory. `nonce > 0` is only ever produced by reload().
    const cached = nonce === 0 ? cache.get(key) : undefined;
    if (cached && Date.now() - cached.storedAt < MARKET_FEED_TTL_MS) {
      setSettled({
        key,
        state: {
          status: 'ready',
          rows: cached.rows,
          dropped: cached.dropped,
          // The ORIGINAL read time, not now. Re-stamping it here is exactly the
          // ticking clock this page refuses: the rows would be a minute old and
          // the page would say they were read this instant.
          readAt: cached.readAt,
        },
      });
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    let cancelled = false;

    void readGeckoPools(url, { signal: controller.signal }).then((read) => {
      if (cancelled) return;

      if (read.status === 'read') {
        const readAt = Math.floor(read.fetchedAt / 1000);
        cacheSet(key, {
          rows: read.rows,
          dropped: read.dropped,
          readAt,
          storedAt: Date.now(),
        });
        setSettled({
          key,
          state: { status: 'ready', rows: read.rows, dropped: read.dropped, readAt },
        });
        return;
      }

      // An aborted read is not a failure and gets no banner: this effect was
      // superseded by a newer one, whose state is the one that should win.
      if (read.reason === 'aborted') return;

      // NOTHING IS CACHED HERE. A cached refusal would keep saying "rate
      // limited" for a minute after the limit cleared, and — worse — would make
      // a retry button that cannot retry.
      setSettled({
        key,
        state: {
          status: 'unreachable',
          // 'schema' is this page's 'malformed': the body parsed as JSON but is
          // not a shape we will render. Renaming it at the boundary keeps the
          // banner's vocabulary the reader's, not the transport's.
          reason: read.reason === 'schema' ? 'malformed' : read.reason,
          detail: read.detail,
        },
      });
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url, key, nonce]);

  return useMemo(() => ({ state, reload }), [state, reload]);
}
