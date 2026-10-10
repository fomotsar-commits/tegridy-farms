import { PublicKey } from '@solana/web3.js';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { clipDetail } from '../../launcher/solana/curve/read';
import { quoteOwnPool, type OwnPoolQuote } from '../cpswap/read';
import { getMultipleAccounts, type RawAccount } from '../lp/accounts';
import { findPools, type PoolView, type ReadPoolsOptions } from '../lp/poolFinder';
import { readPair, type QuoteCoin } from '../lp/quotes';
import { BUILDABLE_EXTENSIONS, decodeMintAccount, extensionPlain } from '../lp/tokenSafety';
import type { RouteCandidate } from '../route';

/**
 * Every pool of ours a swap of this pair could trade in, and what each one pays. A pair
 * has no single pool: the ones the /pools finder finds (`findPools`), each quoted with
 * ITS OWN fee settings. Kept apart: none was looked for (`not-searched`), none exists
 * (`absent`, only when every read answered), one may exist but went unread (`error`),
 * one was read and cannot be traded (`unquotable`).
 */

export type VenuePoolsRead =
  /** Neither side is a coin our pools pair a token with, so no pool was looked for. */
  | { kind: 'not-searched' }
  | { kind: 'unread'; detail: string }
  | {
      kind: 'ok';
      tokenMint: string;
      quote: QuoteCoin;
      /** This pair's pools that were read whole. */
      pools: PoolView[];
      /** False when the index or a pool went unread: "no pool" is then not a finding. */
      complete: boolean;
      /** Why no pool of this token can be priced exactly, or null. */
      tokenProblem: string | null;
      chainNow: bigint | null;
    };

/** Why a quote of this token would not be what a swap pays, or null. The builder's own rule. */
function tokenProblemOf(mint: RawAccount | null): string | null {
  if (!mint) return 'the token’s mint was not found';
  const d = decodeMintAccount(mint.owner, mint.data);
  if (!d.ok) return d.reason;
  const outside = d.value.extensions.find((e) => !BUILDABLE_EXTENSIONS.has(e));
  return outside === undefined ? null : `the token uses ${extensionPlain(outside)}`;
}

export async function readVenuePools(
  rpc: SolanaRpc,
  inputMint: string,
  outputMint: string,
  opts: ReadPoolsOptions & { fetchImpl?: typeof fetch },
): Promise<VenuePoolsRead> {
  const pair = readPair(inputMint, outputMint);
  if (!pair) return { kind: 'not-searched' };
  try {
    const [found, [mint]] = await Promise.all([
      findPools(rpc, new PublicKey(pair.tokenMint), opts),
      getMultipleAccounts(rpc, [pair.tokenMint]),
    ]);
    if (found.kind === 'unread') return { kind: 'unread', detail: found.detail };
    const { pools: entries, index, chainNow } = found.search;
    return {
      kind: 'ok',
      tokenMint: pair.tokenMint,
      quote: pair.quote,
      // The token's pools with another coin are another pair's.
      pools: entries.flatMap((e) => (e.kind === 'pool' && e.view.quote.mint === pair.quote.mint ? [e.view] : [])),
      complete: index.kind === 'ok' && !index.truncated && entries.every((e) => e.kind === 'pool'),
      tokenProblem: tokenProblemOf(mint ?? null),
      chainNow,
    };
  } catch (e) {
    return { kind: 'unread', detail: clipDetail(e) };
  }
}

/** Is this body a pool list as the index gives one (lp/poolIndex.ts reads the rest)? */
function isPoolList(body: string): boolean {
  try {
    const b = JSON.parse(body) as { pools?: unknown; truncated?: unknown } | null;
    return typeof b === 'object' && b !== null && Array.isArray(b.pools) && typeof b.truncated === 'boolean';
  } catch {
    return false;
  }
}

/**
 * A fetch that keeps each GOOD answer for `freshMs` and answers from it meanwhile: for
 * the pool index, whose scan budget is shared with the pools page. Which pools a token
 * has changes only when one is opened; what they hold is read from the chain each time.
 * Only a 2xx answer that IS a pool list is kept; anything else is asked again.
 */
export function rememberingFetch(freshMs: number, base: typeof fetch = fetch, now: () => number = Date.now, keep: (body: string) => boolean = isPoolList): typeof fetch {
  const kept = new Map<string, { at: number; status: number; body: string }>();
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const hit = kept.get(url);
    if (hit && now() - hit.at < freshMs) return new Response(hit.body, { status: hit.status, headers: { 'content-type': 'application/json' } });
    const res = await base(input, init);
    if (res.ok) {
      const body = await res.clone().text();
      if (keep(body)) kept.set(url, { at: now(), status: res.status, body });
    }
    return res;
  }) as typeof fetch;
}

export interface VenuePoolCandidate extends RouteCandidate {
  venue: 'own-pool';
  poolAddress: string;
  view: PoolView;
  quote: OwnPoolQuote;
}

export type OwnPoolsState = 'not-searched' | 'absent' | 'error' | 'unquotable' | 'quoted';

/**
 * Quote `amountIn` of `inputMint` in every pool that was read. A pool whose own fee
 * settings went unread gives no candidate and the answer is `error`. A pool read whole
 * that the program would refuse (a frozen vault, swaps off, not open yet, nothing to pay
 * out, a token whose transfers take a fee) gives `unquotable`. Neither is "no pool".
 */
export function quoteVenuePools(
  read: VenuePoolsRead,
  inputMint: string,
  amountIn: bigint,
  viewerNowSecs: number = Math.floor(Date.now() / 1000),
): { state: OwnPoolsState; candidates: VenuePoolCandidate[] } {
  if (read.kind === 'not-searched') return { state: 'not-searched', candidates: [] };
  if (read.kind === 'unread') return { state: 'error', candidates: [] };
  // The pool opens by the chain's clock. The viewer's stands in only for this estimate:
  // the builder reads the chain's again and refuses without it.
  const now = read.chainNow !== null ? Number(read.chainNow) : viewerNowSecs;
  const candidates: VenuePoolCandidate[] = [];
  let unread = 0;
  for (const view of read.pools) {
    if (!view.config) {
      unread++;
      continue;
    }
    if (read.tokenProblem !== null || amountIn <= 0n || view.vaultsFrozen) continue;
    const quote = quoteOwnPool(view.snapshot, view.config, inputMint, amountIn, now);
    if (!quote || quote.outAmount <= 0n) continue;
    candidates.push({ venue: 'own-pool', outAmount: quote.outAmount, label: 'venue pool', poolAddress: view.address, priceImpact: quote.priceImpact, view, quote });
  }
  if (candidates.length) return { state: 'quoted', candidates };
  if (read.pools.length === 0) return { state: read.complete ? 'absent' : 'error', candidates };
  return { state: unread > 0 ? 'error' : 'unquotable', candidates };
}
