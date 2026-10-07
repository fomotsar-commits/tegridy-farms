// Our pools for one swap pair, and the best of them for one amount.
// Ours: pools of the venue's pool program holding exactly the two mints, at any address
// (poolFinder.ts reads the launch pool, both tiers' standard addresses and the index).
// Each is quoted with its OWN fee tier on the chain's clock, never the viewer's. "No pool"
// is a finding only after a complete search; an unread index, a truncated one or an
// unread pool makes the search incomplete, and the caller must say so (law 8).

import { PublicKey } from '@solana/web3.js';
import { quoteOwnPool, type OwnPoolQuote } from '../cpswap/read';
import type { PoolSearchRead, PoolView, PoolsRead } from '../lp/poolFinder';
import { readPair, type QuoteCoin } from '../lp/quotes';
import type { TokenSafety } from '../lp/tokenSafety';

/** The reads this file needs, at 'confirmed' in the browser (components/solana/lp/readers.ts). */
export interface OwnPoolReaders {
  findPools(mint: PublicKey): Promise<PoolSearchRead>;
  readPools(addresses: string[]): Promise<PoolsRead>;
  safety(mints: string[]): Promise<Map<string, TokenSafety>>;
}

/** A pair our pools can hold: one side a pairing coin (quotes.ts), the other the token. */
export interface OwnPair {
  quote: QuoteCoin;
  tokenMint: string;
}

export function ownPair(inputMint: string, outputMint: string): OwnPair | null {
  const pair = readPair(inputMint, outputMint);
  return pair ? { quote: pair.quote, tokenMint: pair.tokenMint } : null;
}

export interface OwnSearch {
  pair: OwnPair;
  /** Pools of exactly this pair, and pools that could not be read (they may be this pair's). */
  addresses: string[];
  /** Why the search may have missed a pool. Empty only when every place was read in full. */
  gaps: string[];
  token: TokenSafety;
}

export type OwnSearchRead = { kind: 'ok'; search: OwnSearch } | { kind: 'unread'; detail: string };

export const OWN_GAPS = {
  index: (detail: string) => `our pool index could not be read (${detail})`,
  truncated: 'our pool index lists only the deepest pools for this token',
  unread: (n: number) => (n === 1 ? 'one of our pools could not be read' : `${n} of our pools could not be read`),
} as const;

/** Find our pools for the pair. The token is read with it, once, for the swap rules. */
export async function searchOwnPools(readers: OwnPoolReaders, pair: OwnPair): Promise<OwnSearchRead> {
  const [found, safety] = await Promise.all([readers.findPools(new PublicKey(pair.tokenMint)), readers.safety([pair.tokenMint])]);
  if (found.kind === 'unread') return { kind: 'unread', detail: found.detail };
  const s = found.search;
  const token = safety.get(pair.tokenMint) ?? { kind: 'unread', mint: pair.tokenMint, detail: 'the token was not read' };
  const addresses: string[] = [];
  for (const e of s.pools) {
    if (e.kind === 'unread') addresses.push(e.address);
    else if (e.view.quote.mint === pair.quote.mint) addresses.push(e.view.address);
  }
  const gaps: string[] = [];
  if (s.index.kind === 'unread') gaps.push(OWN_GAPS.index(s.index.detail));
  else if (s.index.truncated) gaps.push(OWN_GAPS.truncated);
  return { kind: 'ok', search: { pair, addresses, gaps, token } };
}

export const OWN_EXCLUDED = {
  tokenUnread: 'the token could not be read',
  tokenBlocked: 'this site does not build trades for this token',
  feesUnread: 'its fee settings could not be read',
  frozen: 'one of its vaults is frozen',
  clockUnread: "the network's clock could not be read",
  cannotPrice: 'it cannot price this trade: its swaps are off, or it is not open yet',
  paysNothing: 'it pays nothing for this amount',
} as const;

export interface OwnCandidate {
  view: PoolView;
  quote: OwnPoolQuote;
}

export interface OwnPick {
  best: OwnCandidate | null;
  excluded: { address: string; reason: string }[];
}

/**
 * The best of these pools for `amountIn` of `inputMint`: the most output, then the deeper
 * pairing-coin side, then the lower address. A pool that cannot fill says why.
 */
export function pickOwnPool(views: PoolView[], chainNow: bigint | null, token: TokenSafety, inputMint: string, amountIn: bigint): OwnPick {
  const excluded: OwnPick['excluded'] = [];
  const quoted: OwnCandidate[] = [];
  const tokenProblem = token.kind !== 'read' ? OWN_EXCLUDED.tokenUnread : token.verdict === 'blocked' ? OWN_EXCLUDED.tokenBlocked : null;
  for (const view of views) {
    const config = view.config;
    const reason = tokenProblem ?? (!config ? OWN_EXCLUDED.feesUnread : view.vaultsFrozen ? OWN_EXCLUDED.frozen : chainNow === null ? OWN_EXCLUDED.clockUnread : null);
    if (reason !== null || !config || chainNow === null) {
      excluded.push({ address: view.address, reason: reason ?? OWN_EXCLUDED.feesUnread });
      continue;
    }
    const quote = quoteOwnPool(view.snapshot, config, inputMint, amountIn, Number(chainNow));
    if (!quote) excluded.push({ address: view.address, reason: OWN_EXCLUDED.cannotPrice });
    else if (quote.outAmount <= 0n) excluded.push({ address: view.address, reason: OWN_EXCLUDED.paysNothing });
    else quoted.push({ view, quote });
  }
  quoted.sort((a, b) => {
    if (a.quote.outAmount !== b.quote.outAmount) return a.quote.outAmount > b.quote.outAmount ? -1 : 1;
    if (a.view.quoteReserve !== b.view.quoteReserve) return a.view.quoteReserve > b.view.quoteReserve ? -1 : 1;
    return a.view.address < b.view.address ? -1 : 1;
  });
  return { best: quoted[0] ?? null, excluded };
}

export interface OwnQuotes extends OwnPick {
  /** Pools of exactly this pair that were read, eligible or not. */
  found: number;
  gaps: string[];
}

export type OwnQuotesRead = { kind: 'ok'; quotes: OwnQuotes } | { kind: 'unread'; detail: string };

/** Read the searched pools again, fresh, with the chain's clock, and pick the best for this amount. */
export async function quoteOwnPools(readers: OwnPoolReaders, search: OwnSearch, inputMint: string, amountIn: bigint): Promise<OwnQuotesRead> {
  if (!search.addresses.length) return { kind: 'ok', quotes: { found: 0, gaps: search.gaps, best: null, excluded: [] } };
  const read = await readers.readPools(search.addresses);
  if (read.kind === 'unread') return { kind: 'unread', detail: read.detail };
  const views: PoolView[] = [];
  let unread = 0;
  for (const e of read.entries) {
    if (e.kind === 'unread') unread++;
    else if (e.kind === 'pool' && e.view.tokenMint === search.pair.tokenMint && e.view.quote.mint === search.pair.quote.mint) views.push(e.view);
  }
  const gaps = unread ? [...search.gaps, OWN_GAPS.unread(unread)] : search.gaps;
  return { kind: 'ok', quotes: { found: views.length, gaps, ...pickOwnPool(views, read.chainNow, search.token, inputMint, amountIn) } };
}
