// The terminal watchlist — a local list of pair addresses, nothing more.
//
// Deliberately NOT a portfolio and not a position list. It stores addresses a
// trader marked, and no prices, balances, or PnL, because every one of those
// would be a number this build cannot read without the indexer and would sit in
// localStorage going stale with no way to tell. An address a user typed is the
// only durable fact here.
//
// Storage failures are visible rather than swallowed: `safeSetItem` can return
// false under quota pressure, and a star that silently un-stars on reload is a
// small lie that erodes the same trust the rest of this page is built on. The
// caller gets the boolean.

import { safeGetItem, safeSetItem, safeJsonParse } from '../storage';

/** Kebab prefix so lib/storage.ts's eviction sweeper can reclaim it. */
export const WATCHLIST_STORAGE_KEY = 'tegridy-terminal-watchlist';

/**
 * Bounded so a runaway loop cannot fill the origin's quota and evict genuinely
 * expensive caches. Adding past the cap drops the OLDEST entry, so the most
 * recent intent always survives.
 */
export const WATCHLIST_MAX = 200;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Normalize to the lowercase form the indexer's `t.hex()` columns store, so a
 * checksummed paste and an indexed row are the same key. A non-address is
 * rejected rather than stored: a malformed entry would never match a row and
 * would read as a watch that quietly does nothing.
 */
export function normalizeWatchKey(raw: string): string | null {
  const t = (raw ?? '').trim();
  return ADDRESS_RE.test(t) ? t.toLowerCase() : null;
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

/** Pure: the list that results from toggling `address`. Input is not mutated. */
export function toggleWatch(list: readonly string[], address: string): string[] {
  const key = normalizeWatchKey(address);
  if (key === null) return [...list];
  if (list.includes(key)) return list.filter((a) => a !== key);
  const next = [...list, key];
  return next.length > WATCHLIST_MAX ? next.slice(next.length - WATCHLIST_MAX) : next;
}

export function isWatched(list: readonly string[], address: string): boolean {
  const key = normalizeWatchKey(address);
  return key !== null && list.includes(key);
}
