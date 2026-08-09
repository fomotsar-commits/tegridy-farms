// Network boundary for the Heat oracle, browser side.
//
// Goes through OUR proxy (`/api/aggregator?resource=heat`), never the upstream
// directly — memetics.wtf answers with `Access-Control-Allow-Origin:
// https://junglebayisland.lat`, so a direct browser fetch is CORS-blocked and no
// client-side workaround exists. See api/_lib/heat.js.
//
// Fail-closed: every failure path returns an ERROR, never a zero-degree reading.
// "We could not ask" and "you are cold" are different facts and must never collapse
// into each other.

import { heatEnvelopeFailure, parseHeatReading, type HeatReading } from './heatOracle';

/** Matches the proxy's own validation, so an obviously-bad address never leaves the browser. */
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isSupportedHeatAddress(address: string): boolean {
  const a = address.trim();
  return ETH_ADDRESS_RE.test(a) || SOLANA_ADDRESS_RE.test(a);
}

export class HeatUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeatUnavailableError';
  }
}

/**
 * Hard ceiling, per the directive's "hard timeout (<=6s)".
 *
 * The proxy's own upstream budget (UPSTREAM_TIMEOUT_MS in api/_lib/heat.js) is set
 * BELOW this on purpose, so a hanging island surfaces as our honest 502 rather than as
 * a client-side abort we cannot describe. Keep that ordering if either number moves.
 */
const CLIENT_TIMEOUT_MS = 6000;

/**
 * TTL cache — "small TTL cache (minutes, never days)", directive §2.
 *
 * MINUTES IS A CEILING, NOT A TARGET. The freshness law already refuses a reading
 * reckoned more than 7 days ago; this cache is about not re-asking a third party's
 * quota for the same wallet on every render, and nothing more. A long TTL here would
 * quietly become a second, invisible staleness window layered under the island's own —
 * so it is deliberately far shorter than anything the gate reasons about.
 *
 * SUCCESSES ONLY. A failure is never cached: an outage that cached itself would keep
 * denying a wallet after the instrument came back, turning a blip into a lockout.
 */
const CACHE_TTL_MS = 3 * 60_000;

/** Bounded so a page that reads many wallets (the explorer) cannot grow this forever. */
const CACHE_MAX_ENTRIES = 64;

const cache = new Map<string, { reading: HeatReading; storedAt: number }>();

/** Cache key. Lower-cased for EVM; Solana base58 is case-SIGNIFICANT, so only fold `0x…`. */
function cacheKey(address: string): string {
  const a = address.trim();
  return ETH_ADDRESS_RE.test(a) ? a.toLowerCase() : a;
}

/**
 * Drop every cached reading. Call after an action that could have changed a wallet's
 * standing, and in tests. Cheap — the cache is at most CACHE_MAX_ENTRIES entries.
 */
export function clearHeatCache(): void {
  cache.clear();
}

export interface FetchHeatOptions {
  signal?: AbortSignal;
  /**
   * Skip the TTL cache and re-read the instrument.
   *
   * The GATE PATH sets this. A cached pass is a fine thing to render on a dashboard,
   * but the moment a decision hangs on it we want the instrument's live answer and an
   * `as_of_unix` we fetched ourselves — not one that has been sitting in a tab for
   * three minutes.
   */
  fresh?: boolean;
}

export async function fetchHeat(address: string, opts: FetchHeatOptions = {}): Promise<HeatReading> {
  if (!isSupportedHeatAddress(address)) {
    throw new HeatUnavailableError('That is not an Ethereum or Solana address.');
  }

  const key = cacheKey(address);
  if (!opts.fresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.storedAt < CACHE_TTL_MS) return hit.reading;
    if (hit) cache.delete(key);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CLIENT_TIMEOUT_MS);
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener('abort', onAbort);

  let res: Response;
  try {
    res = await fetch(`/api/aggregator?resource=heat&address=${encodeURIComponent(address.trim())}`, {
      headers: { Accept: 'application/json' },
      signal: ac.signal,
    });
  } catch {
    // Network error or timeout. The instrument is unreachable — say so; do not guess.
    throw new HeatUnavailableError('The instrument is unreachable. Try again in a moment.');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }

  if (res.status === 400) throw new HeatUnavailableError('That is not an Ethereum or Solana address.');
  if (res.status === 429) throw new HeatUnavailableError('Too many readings requested. Try again shortly.');
  if (!res.ok) throw new HeatUnavailableError('The instrument is unreachable. Try again in a moment.');

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new HeatUnavailableError('The instrument returned something unreadable.');
  }

  // A 200 with a malformed body is an OUTAGE, not a low score.
  const failure = heatEnvelopeFailure(payload);
  if (failure) throw new HeatUnavailableError(failure);

  const reading = parseHeatReading(payload);
  // Evict oldest-first when full. Map preserves insertion order, so the first key is
  // the least recently STORED — good enough for a 64-entry read cache, and it keeps
  // this a cache rather than a leak.
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { reading, storedAt: Date.now() });
  return reading;
}
