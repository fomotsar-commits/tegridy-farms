// The coins with $200 or more in one of our Solana pools, as /api/aggregator?resource=venue-tvl
// names them (`poolCoins`, api/_lib/venueTvl.js): the swap lists them as coins of ours (owner,
// 2026-11-01: "add the tokens of the pairs above 200$ in liquidity in our pools as the verified
// token"). Read once when the picker opens, then again at most every few minutes.
//
// A list that could not be read leaves the last one standing (empty on a first read): no coin is
// ever taken for ours on a guess, and a coin dropped from the list stops being ours at the next read.
import { useSyncExternalStore } from 'react';
import { VENUE_TVL_URL } from '../venueTvl';

/** The line, as the server draws it (POOL_COIN_USD): an answer under it is not taken. */
export const POOL_COIN_USD = 200;
const READ_EVERY_MS = 5 * 60_000;
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

let coins: ReadonlyMap<string, number> = new Map();
let readAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** The answer's coins, each a mint and its deepest pool's worth; null for an answer that is not one. */
export function parsePoolCoins(body: unknown): Map<string, number> | null {
  const list = (body as { poolCoins?: unknown } | null)?.poolCoins;
  if (!Array.isArray(list)) return null;
  const out = new Map<string, number>();
  for (const c of list as { mint?: unknown; usd?: unknown }[]) {
    if (typeof c?.mint === 'string' && MINT.test(c.mint) && typeof c.usd === 'number' && Number.isFinite(c.usd) && c.usd >= POOL_COIN_USD) {
      out.set(c.mint, Math.max(out.get(c.mint) ?? 0, c.usd));
    }
  }
  return out;
}

/** Reads the list, unless it was read in the last few minutes; never throws. */
export function loadPoolCoins(fetchImpl: typeof fetch = fetch): Promise<void> {
  if (Date.now() - readAt < READ_EVERY_MS) return Promise.resolve();
  inflight ??= (async () => {
    try {
      const r = await fetchImpl(VENUE_TVL_URL, { signal: AbortSignal.timeout(15_000) });
      const read = r.ok ? parsePoolCoins(await r.json()) : null;
      if (read) {
        coins = read;
        readAt = Date.now();
        for (const l of listeners) l();
      }
    } catch {
      /* the last list stands */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Its deepest pool's worth here, for a coin on the list; null for any other. */
export function poolCoinUsd(mint: string): number | null {
  return coins.get(mint) ?? null;
}

/** The listed mints, deepest pool first. */
export function poolCoinMints(): string[] {
  return [...coins].sort((a, b) => b[1] - a[1]).map(([m]) => m);
}

/** The list, kept current in a component: it draws again when a read lands. */
export function usePoolCoins(): ReadonlyMap<string, number> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => coins,
  );
}

/** Test seam: set the list, or clear it. */
export function __setPoolCoinsForTests(entries: readonly (readonly [string, number])[] = []): void {
  coins = new Map(entries);
  readAt = entries.length ? Date.now() : 0;
  inflight = null;
  for (const l of listeners) l();
}
