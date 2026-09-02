// The pool-LIST reader: new pools, trending pools, and "these exact pools".
//
// The market surfaces this venue owes its users (a terminal, a screener, a
// watchlist, a competition board) are all the same shape — many pools, few
// fields each — and they were all waiting on a Ponder indexer that is hosted
// nowhere. GeckoTerminal already answers that shape, is already read
// browser-direct from this app, and is already in the CSP's connect-src. What
// was missing was a reader with this codebase's honesty rules attached.
//
// TWO RULES DO ALL THE WORK HERE:
//
//  1. A ROW IS DROPPED, AND THE DROP IS COUNTED. An entry whose pool or base
//     token is not a well-formed address for its network is not rendered and
//     not silently swallowed — `rows.length + dropped` always equals the number
//     of entries upstream sent, so a caller can say "18 of 20 pools shown"
//     rather than presenting 18 as the whole truth.
//
//  2. A NUMBER IS WITHHELD, NEVER INVENTED. `createdAt` is `null` when the
//     upstream omits it. This is the one bug already living in this repo that
//     must not be repeated: lib/launcher/discovery.ts defaults a missing
//     `pool_created_at` to 0, which is 1970 — a pool with no known age sorts to
//     the top of "oldest" and renders as 56 years old. Absent is absent.

import {
  geckoTerminalPoolListSchema,
  parseOrNull,
} from '../schemas/geckoTerminal';
import { ETH_ADDRESS_RE, SOL_ADDRESS_RE } from '../scanner/scanner';
import { num } from './poolTrades';

/**
 * The networks this venue reads, as GeckoTerminal's API slugs.
 *
 * Closed on purpose, and identical to the union already inline on
 * `Bungalow.market.network`. The slug is interpolated straight into a URL where
 * a wrong one is a silent 404 rather than an error, so a typo has to be a
 * compile failure. 'eth' — never 'ethereum'.
 */
export type GeckoNetwork = 'eth' | 'base' | 'solana';

export const GECKO_NETWORKS: readonly GeckoNetwork[] = ['eth', 'base', 'solana'];

export function isGeckoNetwork(v: unknown): v is GeckoNetwork {
  return typeof v === 'string' && (GECKO_NETWORKS as readonly string[]).includes(v);
}

/** One pool as every market surface here renders it. */
export interface MarketRow {
  /** `${network}:${pool}` — stable across reads, safe as a React key. */
  key: string;
  network: GeckoNetwork;
  /** Pool (pair) address, validated against the network's address form. */
  pool: string;
  /** Base token address — the thing being priced. */
  token: string;
  /** Quote token address. Null when upstream did not name it. */
  quoteToken: string | null;
  name: string | null;
  /** DEX slug, e.g. 'uniswap_v3'. Null when absent. */
  dex: string | null;
  /** Unix SECONDS. Null when absent — never 0, which would read as 1970. */
  createdAt: number | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  fdvUsd: number | null;
  volume24hUsd: number | null;
  /** Signed: a fall is a negative number, not a missing one. */
  change24hPct: number | null;
  tx24h: { buys: number; sells: number } | null;
  tx5m: { buys: number; sells: number } | null;
  /**
   * True when the USD quartet above was suppressed because upstream's quote for
   * this pool is not believable. The row still renders — its identity, age and
   * trade counts are independent facts — but a surface must show the money
   * columns as unknown and say why.
   */
  withheld: boolean;
}

/** Address form for a network. EVM addresses are hex; Solana keys are base58. */
function addressRe(network: GeckoNetwork): RegExp {
  return network === 'solana' ? SOL_ADDRESS_RE : ETH_ADDRESS_RE;
}

/**
 * A Uniswap-v4 pool identifier: 32 bytes of hex, NOT a contract address.
 *
 * v4 holds every pool inside one singleton contract, so a pool has no address of
 * its own — GeckoTerminal identifies it by its 32-byte poolId and accepts that
 * id in the same URL slot. This is not a loosening of the address rule: the two
 * forms are checked separately, and only the POOL slot accepts this one. A
 * TOKEN is still required to be a real 20-byte address, because a token is a
 * contract and always has one.
 *
 * Found the hard way, in the very first live capture: two of the three newest
 * Ethereum pools were v4. Held to the address rule, the "new pools" surface
 * would have shown a third of Ethereum's new pools and called it the list.
 */
const EVM_POOL_ID_RE = /^0x[0-9a-fA-F]{64}$/;

/** Strip the JSON:API `{network}_` prefix (`eth_0xabc…`, `solana_31Zm…`). */
function stripNetworkPrefix(raw: string): string {
  return raw.includes('_') ? raw.slice(raw.lastIndexOf('_') + 1) : raw;
}

/**
 * Canonical form for an identifier this app will put in a URL.
 *
 * EVM values are lowercased so a checksummed upstream and a lowercase local
 * record are the same key. Solana keys are left VERBATIM: base58 is
 * case-sensitive and lowercasing one produces a different, valid-looking, wrong
 * address.
 */
function canonical(candidate: string, network: GeckoNetwork): string {
  return network === 'solana' ? candidate : candidate.toLowerCase();
}

/** A TOKEN address, strictly. Null when it is not one for this network. */
function parseAddress(raw: unknown, network: GeckoNetwork): string | null {
  if (typeof raw !== 'string') return null;
  const candidate = stripNetworkPrefix(raw);
  if (!addressRe(network).test(candidate)) return null;
  return canonical(candidate, network);
}

/** A POOL identifier: an address, or (EVM) a 32-byte v4 pool id. */
function parsePoolId(raw: unknown, network: GeckoNetwork): string | null {
  if (typeof raw !== 'string') return null;
  const candidate = stripNetworkPrefix(raw);
  if (addressRe(network).test(candidate)) return canonical(candidate, network);
  if (network !== 'solana' && EVM_POOL_ID_RE.test(candidate)) return candidate.toLowerCase();
  return null;
}

/**
 * `pool_created_at` as unix SECONDS, or null.
 *
 * Accepts the ISO-8601 form `new_pools` sends and an already-numeric unix value.
 * Returns NULL — not 0 — when it is absent or unparseable. See the file header:
 * the 0 default is the live bug this parser exists partly to avoid inheriting.
 */
function parseCreatedAt(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(raw);
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return null;
}

function txCounts(window: { buys?: number | null; sells?: number | null } | null | undefined) {
  if (!window) return null;
  const buys = window.buys;
  const sells = window.sells;
  // Half a count is not a count. Rendering "12 buys / — sells" invites the
  // reader to compute a ratio out of one real number and one absence.
  if (typeof buys !== 'number' || typeof sells !== 'number') return null;
  if (!Number.isFinite(buys) || !Number.isFinite(sells)) return null;
  return { buys, sells };
}

/**
 * Parse a pool-list response into rows.
 *
 * Returns null when the LIST ITSELF is unrecognisable (no `data` array) — that
 * is an unread, and the caller must say so. A recognisable list with unusable
 * entries is not an unread: it returns the rows it could trust plus the count it
 * could not, because "20 pools, 2 unreadable" is a fact worth showing and "18
 * pools" alone is a quiet lie.
 */
export function parseGeckoPoolList(
  raw: unknown,
  network: GeckoNetwork,
): { rows: MarketRow[]; dropped: number } | null {
  const parsed = parseOrNull(geckoTerminalPoolListSchema, raw);
  if (!parsed) return null;

  const rows: MarketRow[] = [];
  let dropped = 0;

  for (const entry of parsed.data) {
    const attrs = entry.attributes ?? null;
    const rel = entry.relationships ?? null;

    const pool = parsePoolId(attrs?.address, network) ?? parsePoolId(entry.id, network);
    const token = parseAddress(rel?.base_token?.data?.id, network);
    if (!pool || !token) {
      // A row with no addressable pool or no priced token cannot be linked,
      // charted or de-duplicated. It is counted, not rendered.
      dropped += 1;
      continue;
    }

    const priceUsd = num(attrs?.base_token_price_usd);
    const liquidityUsd = num(attrs?.reserve_in_usd);
    const fdvUsd = num(attrs?.fdv_usd);
    const volume24hUsd = num(attrs?.volume_usd?.h24);

    // All four money columns come from the SAME upstream quote for this pool. If
    // the two load-bearing ones are missing or impossible, the other two are not
    // independently trustworthy either — an FDV computed from a broken price is
    // a confident-looking wrong number. So the quartet moves together: shown, or
    // withheld with the reason visible.
    //
    // Not hypothetical. The 2026-09-02 capture of eth/new_pools contains a live
    // pool quoting `reserve_in_usd: "-100.058883136323"`. Negative liquidity is
    // not a number; printed, it is a $-100 pool sitting in a sorted list.
    const negative = [priceUsd, liquidityUsd, fdvUsd, volume24hUsd].some(
      (n) => n !== null && n < 0,
    );
    const withheld = priceUsd === null || liquidityUsd === null || negative;

    rows.push({
      key: `${network}:${pool}`,
      network,
      pool,
      token,
      quoteToken: parseAddress(rel?.quote_token?.data?.id, network),
      name: attrs?.name ?? null,
      // The dex id is a slug ('uniswap_v3'), not an address — no regex applies.
      dex: typeof rel?.dex?.data?.id === 'string' ? rel.dex.data.id : null,
      createdAt: parseCreatedAt(attrs?.pool_created_at),
      priceUsd: withheld ? null : priceUsd,
      liquidityUsd: withheld ? null : liquidityUsd,
      fdvUsd: withheld ? null : fdvUsd,
      volume24hUsd: withheld ? null : volume24hUsd,
      change24hPct: num(attrs?.price_change_percentage?.h24),
      tx24h: txCounts(attrs?.transactions?.h24),
      tx5m: txCounts(attrs?.transactions?.m5),
      withheld,
    });
  }

  return { rows, dropped };
}

// ─── URLs ────────────────────────────────────────────────────────────────────

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';

/** `pools/multi` takes at most 30 addresses per request (GeckoTerminal's cap). */
export const GECKO_POOLS_MULTI_MAX = 30;

export function geckoPoolsUrl(network: GeckoNetwork, view: 'new' | 'trending'): string {
  const path = view === 'new' ? 'new_pools' : 'trending_pools';
  return `${GECKO_BASE}/networks/${network}/${path}`;
}

/**
 * Look up specific pools in one request — the endpoint a watchlist needs, so a
 * list of twenty starred pairs is one call rather than twenty.
 *
 * Every address is validated for the network BEFORE it is interpolated. An
 * unvalidated address in a comma-joined path segment is a request-shaping hole:
 * a value containing '/' or ',' would silently change which endpoint is called.
 * Addresses that fail are simply not asked about; the caller compares what it
 * asked for against `rows` to see which came back.
 */
export function geckoPoolsMultiUrl(network: GeckoNetwork, pools: string[]): string {
  const valid: string[] = [];
  for (const p of pools) {
    if (typeof p !== 'string') continue;
    const id = parsePoolId(p.trim(), network);
    if (id === null) continue;
    // Already proven to be hex or base58, so the encode changes nothing — it
    // stays as the second lock, so that a future loosening of the ID rule
    // cannot become a path-injection at the same stroke.
    valid.push(encodeURIComponent(id));
    if (valid.length >= GECKO_POOLS_MULTI_MAX) break;
  }
  return `${GECKO_BASE}/networks/${network}/pools/multi/${valid.join(',')}`;
}

/**
 * The network a GeckoTerminal URL is asking about.
 *
 * `readGeckoPools` takes a URL rather than (network, view) so the three list
 * endpoints share one reader, which means the network has to come back out of
 * the URL. Reading it from the URL — rather than accepting it as a second
 * argument — makes it impossible to parse a Solana response under Ethereum's
 * address rules by passing mismatched arguments.
 */
function networkFromUrl(url: string): GeckoNetwork | null {
  const m = /\/networks\/([^/?#]+)/.exec(url);
  const slug = m?.[1];
  return isGeckoNetwork(slug) ? slug : null;
}

// ─── Reader ──────────────────────────────────────────────────────────────────

export type GeckoPoolsUnreadReason = 'http' | 'rate-limited' | 'schema' | 'network' | 'aborted';

export type GeckoPoolsRead =
  | { status: 'read'; rows: MarketRow[]; dropped: number; fetchedAt: number }
  | { status: 'unread'; reason: GeckoPoolsUnreadReason; detail: string };

export interface ReadGeckoPoolsOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function unread(reason: GeckoPoolsUnreadReason, detail: string): GeckoPoolsRead {
  return { status: 'unread', reason, detail };
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/**
 * Read one pool-list URL. Never rejects — see poolTrades.ts for why an escaping
 * rejection is an e2e-suite failure and not merely untidy.
 */
export async function readGeckoPools(
  url: string,
  opts: ReadGeckoPoolsOptions = {},
): Promise<GeckoPoolsRead> {
  const network = networkFromUrl(url);
  if (!network) {
    return unread('schema', 'That is not a GeckoTerminal pool-list URL for a network this venue reads.');
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const clock = opts.now ?? Date.now;

  let res: Response;
  try {
    res = await doFetch(url, { headers: { Accept: 'application/json' }, signal: opts.signal });
  } catch (err) {
    return isAbort(err, opts.signal)
      ? unread('aborted', 'The pool list request was cancelled before it finished.')
      : unread('network', 'The market feed could not be reached, so no pools are listed.');
  }

  if (res.status === 429) {
    return unread('rate-limited', 'The market feed is rate-limiting right now. Give it a moment and try again.');
  }
  if (!res.ok) {
    return unread('http', `The market feed refused this request (HTTP ${res.status}).`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return isAbort(err, opts.signal)
      ? unread('aborted', 'The pool list request was cancelled before it finished.')
      : unread('schema', 'The market feed returned something unreadable.');
  }

  const parsed = parseGeckoPoolList(body, network);
  if (!parsed) {
    return unread('schema', 'The market feed answered in a shape we will not render, so no pools are listed.');
  }

  return { status: 'read', rows: parsed.rows, dropped: parsed.dropped, fetchedAt: clock() };
}
