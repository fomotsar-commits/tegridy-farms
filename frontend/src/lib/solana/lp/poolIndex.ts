import { PublicKey } from '@solana/web3.js';

/**
 * The browser side of `/api/pools`, the server's list of pool ADDRESSES for a token.
 *
 * The browser cannot list pools itself: `getProgramAccounts` stays off the `/api/solrpc`
 * proxy (an open scan against a keyed RPC). So one server function does that single
 * filtered scan, caches it, and returns addresses only. Nothing it says is trusted as a
 * fact about a pool: every address is then read from the chain in the browser and
 * checked (owned by the pool program, decodes as a pool, trades this token against SOL).
 * A wrong index can therefore hide a pool, which the page says it might, but it cannot
 * put words in a pool's mouth.
 */

export const POOL_INDEX_PATH = '/api/pools';
/** The server returns at most this many; more means `truncated`. */
export const POOL_INDEX_MAX = 50;

export type PoolIndexRead =
  | { kind: 'ok'; pools: string[]; truncated: boolean }
  /** The index did not answer, or answered with something we did not expect. */
  | { kind: 'unread'; detail: string };

export type PoolIndexQuery = { mint: string } | { lpMint: string };

function isAddress(s: unknown): s is string {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try {
    return new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
}

export async function readPoolIndex(query: PoolIndexQuery, fetchImpl: typeof fetch = fetch): Promise<PoolIndexRead> {
  const [key, value] = 'mint' in query ? ['mint', query.mint] : ['lpMint', query.lpMint];
  if (!isAddress(value)) return { kind: 'unread', detail: 'that is not a Solana address' };
  let res: Response;
  try {
    res = await fetchImpl(`${POOL_INDEX_PATH}?${key}=${encodeURIComponent(value)}`, { headers: { Accept: 'application/json' } });
  } catch (e) {
    return { kind: 'unread', detail: `the pool index did not answer (${e instanceof Error ? e.message : String(e)})` };
  }
  if (!res.ok) {
    return { kind: 'unread', detail: res.status === 429 ? 'the pool index is busy (too many lookups); try again in a minute' : `the pool index answered HTTP ${res.status}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: 'unread', detail: 'the pool index answered with something that is not JSON' };
  }
  const b = body as { pools?: unknown; truncated?: unknown; [k: string]: unknown };
  if (typeof body !== 'object' || body === null || !Array.isArray(b.pools) || typeof b.truncated !== 'boolean') {
    return { kind: 'unread', detail: 'the pool index answered in an unexpected shape' };
  }
  if (b[key] !== value) return { kind: 'unread', detail: 'the pool index answered about a different token' };
  if (b.pools.length > POOL_INDEX_MAX || !b.pools.every(isAddress)) {
    return { kind: 'unread', detail: 'the pool index answered with an invalid address list' };
  }
  return { kind: 'ok', pools: [...new Set(b.pools as string[])], truncated: b.truncated };
}
