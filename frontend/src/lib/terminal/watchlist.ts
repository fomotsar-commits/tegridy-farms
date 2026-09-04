// The terminal watchlist — a local list of pool addresses, nothing more.
//
// Deliberately NOT a portfolio and not a position list. It stores addresses a
// trader marked, and no prices, balances, or PnL, because every one of those
// would be a number sitting in localStorage going stale with no way to tell. An
// address a user marked is the only durable fact here.
//
// KEYS ARE CHAIN-QUALIFIED: `eth:0x…`, `base:0x…`, `solana:<base58>`. They were
// bare 0x addresses when this page read one chain. The moment it reads three,
// a bare key is ambiguous in the way that matters most — the SAME 0x address is
// a different, unrelated pool on Ethereum and on Base, so a star set on one
// would light up the other and a watchlist read would request the wrong pool
// from the wrong network. Entries written by the old shape are migrated to
// `eth:` on read, which is what they meant when they were written.
//
// THE REGEX IS THE INJECTION GUARD. A watchlist key is the one value on this
// page that goes from localStorage into a fetch URL — `pools/multi/{a,b,c}`
// joins addresses into a PATH SEGMENT, where a value containing '/' or ',' would
// silently change which endpoint is called. Nothing reaches that builder without
// passing the network's own address regex here first, and the builder validates
// again (defence in depth, not redundancy: neither module may assume the other).
//
// Storage failures are visible rather than swallowed: `safeSetItem` can return
// false under quota pressure, and a star that silently un-stars on reload is a
// small lie that erodes the same trust the rest of this page is built on. The
// caller gets the boolean.

import { safeGetItem, safeSetItem, safeJsonParse } from '../storage';
import { ETH_ADDRESS_RE, SOL_ADDRESS_RE } from '../scanner/scanner';
import { isGeckoNetwork, type GeckoNetwork } from '../geckoTerminal/pools';

/**
 * Unchanged across the key-shape migration, on purpose.
 *
 * This is a storage key, not rendered copy, and changing it would silently empty
 * every existing watchlist — the entries would still be in the browser under a
 * name nothing reads. It is also listed in EVICTION_PROTECTED_KEYS (lib/storage.ts)
 * because a hand-built list is not a cache and nothing can re-derive it.
 */
export const WATCHLIST_STORAGE_KEY = 'tegridy-terminal-watchlist';

/**
 * Bounded so a runaway loop cannot fill the origin's quota and evict genuinely
 * expensive caches. Adding past the cap drops the OLDEST entry, so the most
 * recent intent always survives.
 */
export const WATCHLIST_MAX = 200;

/** A parsed key: which chain, and the address on it. */
export interface WatchKey {
  network: GeckoNetwork;
  address: string;
}

/**
 * Normalize to the canonical `network:address` form, or reject.
 *
 * EVM addresses are lowercased so a checksummed paste and a feed row are one
 * key. SOLANA KEYS ARE LEFT VERBATIM: base58 is case-sensitive, and lowercasing
 * one produces a different string that still looks like a valid address — the
 * star would point at nothing and no error would ever be raised. A malformed
 * entry is rejected rather than stored: it would never match a row and would
 * read as a watch that quietly does nothing.
 */
export function normalizeWatchKey(raw: string): string | null {
  const parsed = parseWatchKey(raw);
  return parsed ? `${parsed.network}:${parsed.address}` : null;
}

export function parseWatchKey(raw: string): WatchKey | null {
  const t = (raw ?? '').trim();
  if (!t) return null;

  const sep = t.indexOf(':');
  if (sep < 0) {
    // LEGACY MIGRATION. Before this page read three chains it stored bare 0x
    // pair addresses from the venue's own Ethereum indexer, so that is exactly
    // what they meant. Migrating on parse (and on toggle) means an existing
    // star keeps working rather than silently disappearing on the deploy that
    // added Base and Solana.
    return ETH_ADDRESS_RE.test(t) ? { network: 'eth', address: t.toLowerCase() } : null;
  }

  const network = t.slice(0, sep);
  const address = t.slice(sep + 1);
  if (!isGeckoNetwork(network)) return null;

  if (network === 'solana') {
    return SOL_ADDRESS_RE.test(address) ? { network, address } : null;
  }
  return ETH_ADDRESS_RE.test(address) ? { network, address: address.toLowerCase() } : null;
}

/** Build a key from parts the caller already trusts. Still validated. */
export function watchKeyFor(network: GeckoNetwork, address: string): string | null {
  return normalizeWatchKey(`${network}:${(address ?? '').trim()}`);
}

/** Parse whatever is in storage into a clean list. Never throws. */
export function parseWatchlist(raw: string | null): string[] {
  const parsed = safeJsonParse<unknown>(raw, null);
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry !== 'string') continue;
    const key = normalizeWatchKey(entry);
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= WATCHLIST_MAX) break;
  }
  return out;
}

export function loadWatchlist(): string[] {
  return parseWatchlist(safeGetItem(WATCHLIST_STORAGE_KEY));
}

/** Returns false when the write did not land, so the caller can say so. */
export function saveWatchlist(list: readonly string[]): boolean {
  return safeSetItem(WATCHLIST_STORAGE_KEY, JSON.stringify(list.slice(0, WATCHLIST_MAX)));
}

/** Pure: the list that results from toggling `key`. Input is not mutated. */
export function toggleWatch(list: readonly string[], key: string): string[] {
  const normalized = normalizeWatchKey(key);
  if (normalized === null) return [...list];
  if (list.includes(normalized)) return list.filter((a) => a !== normalized);
  const next = [...list, normalized];
  return next.length > WATCHLIST_MAX ? next.slice(next.length - WATCHLIST_MAX) : next;
}

export function isWatched(list: readonly string[], key: string): boolean {
  const normalized = normalizeWatchKey(key);
  return normalized !== null && list.includes(normalized);
}

/**
 * The watched addresses on ONE network, in stored order.
 *
 * The watchlist VIEW reads pools by address, and `pools/multi` takes one network
 * per request — so grouping is not a convenience, it is the only shape the
 * upstream accepts. Returning addresses (not keys) keeps the URL builder from
 * having to know this module's key format.
 */
export function watchedOn(list: readonly string[], network: GeckoNetwork): string[] {
  const out: string[] = [];
  for (const entry of list) {
    const parsed = parseWatchKey(entry);
    if (parsed && parsed.network === network) out.push(parsed.address);
  }
  return out;
}
