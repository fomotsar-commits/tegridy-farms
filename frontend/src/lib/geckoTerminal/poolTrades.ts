// THE ONE PLACE THIS APP ASKS GECKOTERMINAL FOR A POOL'S FILLS.
//
// Four surfaces want the same tape (the bungalow trade list, the terminal, copy
// trading, tax). Before this module there was exactly one fetch site — inside
// usePoolTrades.ts, a React hook — so any surface that is not a component had a
// choice between importing a hook it cannot call and writing a second fetch. A
// second fetch site is not a style problem: it is a second place for the CSP
// entry, the abort handling, the 429 wording and the null-vs-zero rule to drift.
//
// FAIL-CLOSED, in the same shape as lib/indexer/client.ts. `readPoolTrades`
// resolves to a state UNION, never to a bare array, because an empty array is
// the one value that "this pool has had no fills" and "we could not read the
// pool" would otherwise share. Every unread branch carries a plain-language
// `detail` a surface can print verbatim.
//
// It also NEVER REJECTS. A rejected promise escaping into a component becomes an
// unhandled rejection, which Playwright surfaces as a WebKit `pageerror` and
// fails the e2e run wholesale (playwright.config.ts) — an outage in a third-party
// price API would red the suite. Every throw is caught here and named.

import { geckoTerminalTradesSchema, parseOrNull } from '../schemas/geckoTerminal';

/** One fill on one pool, as the app renders it. */
export interface PoolTrade {
  /** ISO timestamp of the block the fill landed in. */
  at: string;
  kind: 'buy' | 'sell';
  txHash: string;
  wallet: string | null;
  /** Size in the POOL'S OWN base token (see the buy/sell leg rule below). Null when unreadable. */
  tokenAmount: number | null;
  usd: number | null;
  /** The raw legs, kept so a caller can tell WHICH pair traded, not just which side. */
  fromTokenAddress: string | null;
  toTokenAddress: string | null;
  /** Amounts as sent — strings, un-coerced, so no precision is lost in transit. */
  fromTokenAmount: string | null;
  toTokenAmount: string | null;
  blockNumber: number | null;
}

/**
 * Why a read produced nothing. Each is a different sentence to a user:
 *  - `not-attempted` — no pool was named, so nothing was asked. Not an error.
 *  - `rate-limited`  — the keyless upstream is throttling US. Retrying works.
 *  - `http`          — it answered, and the answer was a refusal.
 *  - `schema`        — it answered 200 with a body we will not render.
 *  - `network`       — it did not answer at all.
 *  - `aborted`       — WE cancelled (unmount / re-key). Nothing is wrong.
 */
export type PoolTradesUnreadReason =
  | 'http'
  | 'rate-limited'
  | 'schema'
  | 'network'
  | 'aborted'
  | 'not-attempted';

export type PoolTradesRead =
  | { status: 'read'; trades: PoolTrade[]; fetchedAt: number }
  | { status: 'unread'; reason: PoolTradesUnreadReason; detail: string };

export interface ReadPoolTradesOptions {
  signal?: AbortSignal;
  /** Injection seam for tests; production always uses global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Wall clock for `fetchedAt`, injectable so a test can pin the stamp. NOT the
   * cache's clock — see readPoolTradesCached, which deliberately uses a
   * different one.
   */
  now?: () => number;
}

/**
 * Finite number or null. Lifted OUT of usePoolTrades.ts unchanged.
 *
 * The `null` return is the whole point and the reason this is not `Number(v) || 0`:
 * a missing USD figure must reach the UI as "unknown" and be rendered as a dash.
 * Coerced to 0 it becomes a claim — a $0 trade — that the upstream never made.
 * Exported so the pool-LIST reader coerces identically; two coercion rules for
 * one upstream is how a fabricated zero gets in through the back door.
 */
export function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The trades endpoint for one pool.
 *
 * Both segments are encoded. A pool address never needs encoding, which is
 * exactly why an unencoded template is dangerous: the day a caller passes
 * something else, the value would land as path structure rather than as a
 * (failing) lookup.
 */
export function poolTradesUrl(network: string, pool: string): string {
  return `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(network)}/pools/${encodeURIComponent(pool)}/trades`;
}

function unread(reason: PoolTradesUnreadReason, detail: string): PoolTradesRead {
  return { status: 'unread', reason, detail };
}

/**
 * True when a thrown value is the abort WE asked for.
 *
 * Checked by name rather than by `instanceof DOMException` alone: fetch polyfills
 * and jsdom have historically thrown a plain `Error` named AbortError, and a
 * cancelled request misreported as a network outage would put an error banner on
 * screen every time a user navigates away.
 */
function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/**
 * Read one pool's recent fills. One request, no retry, no polling.
 *
 * Ordering and length are upstream's; this does not slice. A caller that shows
 * twelve rows slices twelve, and a caller that wants the day's tape gets the
 * day's tape from the same read.
 */
export async function readPoolTrades(
  network: string,
  pool: string,
  opts: ReadPoolTradesOptions = {},
): Promise<PoolTradesRead> {
  if (!network || !pool) {
    return unread('not-attempted', 'No pool was named, so no trades were requested.');
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const clock = opts.now ?? Date.now;

  let res: Response;
  try {
    res = await doFetch(poolTradesUrl(network, pool), {
      headers: { Accept: 'application/json' },
      signal: opts.signal,
    });
  } catch (err) {
    return isAbort(err, opts.signal)
      ? unread('aborted', 'The trades request was cancelled before it finished.')
      : unread('network', 'The trades feed could not be reached — that is an outage, not an empty tape.');
  }

  // The keyless public endpoint throttles by IP, so 429 is an ordinary answer
  // under load and gets its own wording: nothing is wrong with the pool, and
  // trying again in a moment actually works.
  if (res.status === 429) {
    return unread('rate-limited', 'The trades feed is rate-limiting right now. Give it a moment and try again.');
  }
  if (!res.ok) {
    return unread('http', `The trades feed refused this pool (HTTP ${res.status}).`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return isAbort(err, opts.signal)
      ? unread('aborted', 'The trades request was cancelled before it finished.')
      : unread('schema', 'The trades feed returned something unreadable.');
  }

  const parsed = parseOrNull(geckoTerminalTradesSchema, body);
  if (!parsed) {
    // Off-schema rows are rejected WHOLESALE, never filtered. Keeping the rows
    // that happen to validate silently shortens a tape, which reads on screen
    // as a quiet market rather than as the parse failure it is.
    return unread('schema', 'The trades feed answered in a shape we will not render, so none of it is shown.');
  }

  const trades: PoolTrade[] = parsed.data.map((row) => {
    const a = row.attributes;
    // On a BUY the pool's base token is what you RECEIVE (to_token_amount); on a
    // SELL it is what you GIVE (from_token_amount). Getting this backwards
    // prints the quote leg as a token size — 0.61 instead of 116,200 — a
    // plausible-looking number nobody catches.
    const tokenAmount = a.kind === 'buy' ? num(a.to_token_amount) : num(a.from_token_amount);
    return {
      at: a.block_timestamp,
      kind: a.kind,
      txHash: a.tx_hash,
      wallet: a.tx_from_address ?? null,
      tokenAmount,
      usd: num(a.volume_in_usd),
      fromTokenAddress: a.from_token_address ?? null,
      toTokenAddress: a.to_token_address ?? null,
      fromTokenAmount: a.from_token_amount ?? null,
      toTokenAmount: a.to_token_amount ?? null,
      blockNumber: a.block_number ?? null,
    };
  });

  return { status: 'read', trades, fetchedAt: clock() };
}

// ─── Cache ───────────────────────────────────────────────────────────────────

/**
 * Same rule as `ohlcvCacheKey` in lib/chart/market.ts: the key carries the
 * NETWORK as well as the pool. A pool-only key is a cross-network cache the
 * moment two chains are in play, and the failure mode is not an error — it is
 * one token's tape rendered under another's ticker.
 */
export function poolTradesCacheKey(network: string, pool: string): string {
  return `${network}:${pool}`;
}

type SuccessfulRead = Extract<PoolTradesRead, { status: 'read' }>;

/**
 * `storedAt` is `performance.now()` — a MONOTONIC counter, in milliseconds since
 * page load. It exists only to answer "is this older than the TTL". It is NOT a
 * timestamp and must never be rendered as one: it is unrelated to wall time and
 * unaffected by a clock change, which is precisely what a TTL wants and exactly
 * what a "last updated" line must not use. The wall-clock stamp a surface shows
 * lives on the entry itself, as `fetchedAt`.
 */
const cache = new Map<string, { storedAt: number; value: SuccessfulRead }>();

export interface ReadPoolTradesCachedOptions extends ReadPoolTradesOptions {
  ttlMs?: number;
}

/**
 * A cached read, so four surfaces on one screen ask the throttled upstream once.
 *
 * ONLY successful reads are cached. Caching a failure would turn one 429 into a
 * minute of manufactured silence, and — worse — would make the retry a user
 * triggers do nothing while still looking like it did.
 */
export async function readPoolTradesCached(
  network: string,
  pool: string,
  opts: ReadPoolTradesCachedOptions = {},
): Promise<PoolTradesRead> {
  const { ttlMs = 60_000, ...readOpts } = opts;
  if (!network || !pool) {
    return unread('not-attempted', 'No pool was named, so no trades were requested.');
  }

  const key = poolTradesCacheKey(network, pool);
  const hit = cache.get(key);
  if (hit && performance.now() - hit.storedAt < ttlMs) return hit.value;

  const result = await readPoolTrades(network, pool, readOpts);
  if (result.status === 'read') cache.set(key, { storedAt: performance.now(), value: result });
  return result;
}

/** Tests share a module instance; without this, one test's read feeds the next. */
export function __resetPoolTradesCacheForTests(): void {
  cache.clear();
}
