import { useCallback, useEffect, useState } from 'react';
import { browserOwnPoolReaders } from '../solana/lp/readers';
import { ownPair, quoteOwnPools, searchOwnPools, type OwnPoolReaders, type OwnQuotesRead, type OwnSearchRead } from '../../lib/solana/swap/ownPools';
import type { OwnSide } from '../../lib/solana/swap/venueChoice';

// Our pools for the swap form on screen: one search per pair (cached 30 s, a failure only
// 15 s), then a fresh read of the pools found for each amount, after the same pause as
// the Jupiter quote. An answer counts only for the request it was asked for.

const SEARCH_TTL_MS = 30_000;
const FAILED_TTL_MS = 15_000;
export const OWN_QUOTE_DEBOUNCE_MS = 400;

const searches = new Map<string, { at: number; ok: boolean; read: Promise<OwnSearchRead> }>();

function searchFor(readers: OwnPoolReaders, inputMint: string, outputMint: string): Promise<OwnSearchRead> | null {
  const pair = ownPair(inputMint, outputMint);
  if (!pair) return null;
  const key = `${pair.tokenMint}|${pair.quote.mint}`;
  const hit = searches.get(key);
  if (hit && Date.now() - hit.at < (hit.ok ? SEARCH_TTL_MS : FAILED_TTL_MS)) return hit.read;
  const entry = { at: Date.now(), ok: true, read: Promise.resolve<OwnSearchRead>({ kind: 'unread', detail: '' }) };
  entry.read = searchOwnPools(readers, pair).then(
    (r) => {
      entry.ok = r.kind === 'ok';
      return r;
    },
    (e: unknown): OwnSearchRead => {
      entry.ok = false;
      return { kind: 'unread', detail: e instanceof Error ? e.message : String(e) };
    },
  );
  searches.set(key, entry);
  return entry.read;
}

/** Test-only: forget every search. */
export function forgetOwnPoolSearches(): void {
  searches.clear();
}

let browserReaders: OwnPoolReaders | null | undefined;
function defaultReaders(): OwnPoolReaders | null {
  if (browserReaders === undefined) browserReaders = browserOwnPoolReaders();
  return browserReaders;
}

export type OwnQuoteNow = OwnQuotesRead | { kind: 'absent' } | { kind: 'not-a-pair' };

/** Our pools for a pair and amount, read now: the search (cached), then the pools, fresh. */
export async function quoteOwnPoolsNow(readers: OwnPoolReaders | null, inputMint: string, outputMint: string, amountIn: bigint): Promise<OwnQuoteNow> {
  if (!readers) return { kind: 'absent' };
  const search = searchFor(readers, inputMint, outputMint);
  if (!search) return { kind: 'not-a-pair' };
  const s = await search;
  if (s.kind === 'unread') return s;
  try {
    return await quoteOwnPools(readers, s.search, inputMint, amountIn);
  } catch (e) {
    return { kind: 'unread', detail: e instanceof Error ? e.message : String(e) };
  }
}

function sideOf(r: OwnQuoteNow): OwnSide {
  if (r.kind === 'ok') return { kind: 'ok', quotes: r.quotes };
  return r.kind === 'unread' ? { kind: 'unread' } : r;
}

export interface OwnPoolRoute {
  own: OwnSide;
  /** Read our pools for this pair and amount again, now. The Buy press uses it. */
  quoteNow(): Promise<OwnQuoteNow>;
}

export function useOwnPoolRoute(a: {
  inputMint: string;
  outputMint: string;
  amountIn: bigint | null;
  /** Bumped to read again for the same form (after a trade, or Try again). */
  nonce?: number;
  /** Tests pass their own; the browser reads through /api/solrpc and /api/pools. */
  readers?: OwnPoolReaders | null;
}): OwnPoolRoute {
  const readers = a.readers === undefined ? defaultReaders() : a.readers;
  const { inputMint, outputMint, amountIn } = a;
  const nonce = a.nonce ?? 0;
  const key = `${inputMint}|${outputMint}|${amountIn ?? ''}|${nonce}`;
  const [read, setRead] = useState<{ key: string; own: OwnSide } | null>(null);
  const settled: OwnSide | null = !readers ? { kind: 'absent' } : !ownPair(inputMint, outputMint) ? { kind: 'not-a-pair' } : null;

  useEffect(() => {
    if (settled || amountIn === null || amountIn <= 0n) return;
    let live = true;
    const t = setTimeout(() => {
      void quoteOwnPoolsNow(readers, inputMint, outputMint, amountIn).then((r) => {
        if (live) setRead({ key, own: sideOf(r) });
      });
    }, OWN_QUOTE_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // `settled` is derived from the readers and the pair, both already here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readers, inputMint, outputMint, amountIn, key]);

  const quoteNow = useCallback(
    () => (amountIn === null || amountIn <= 0n ? Promise.resolve<OwnQuoteNow>({ kind: 'unread', detail: 'no amount' }) : quoteOwnPoolsNow(readers, inputMint, outputMint, amountIn)),
    [readers, inputMint, outputMint, amountIn],
  );
  const own: OwnSide = settled ?? (read && read.key === key ? read.own : { kind: 'pending' });
  return { own, quoteNow };
}
