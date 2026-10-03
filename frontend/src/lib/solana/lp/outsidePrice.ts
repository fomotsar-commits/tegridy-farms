import { PublicKey } from '@solana/web3.js';
import { JUPITER_PROXY_BASE, SOL_MINT } from '../../solana';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { clipDetail } from '../../launcher/solana/curve/read';
import { getMultipleAccounts } from './accounts';
import type { QuoteCoin } from './quotes';

/**
 * The token's price OUTSIDE our pools, to check a pool's price against before anyone
 * deposits into it.
 *
 * Why it matters: anyone can open a pool for any token at any price. Depositing into a
 * pool whose price is off hands the difference to the first arbitrage bot. So a pool
 * more than 3% away from the outside price is refused (poolHealth.ts), and a pool whose
 * outside price could not be read is "unchecked", never "fine".
 *
 * HOW. Two Jupiter quotes through our own proxy: 0.05 SOL into the token, then that many
 * tokens back into SOL. The buy price includes the route's fees and impact on one side,
 * the sell price on the other; their geometric mean cancels both, leaving the mid price.
 * No platform fee is asked for (no `platformFeeBps`), so our own fee does not bend it.
 *
 * NOT OUR OWN POOLS. Jupiter does not route through our pool program today, but if it
 * ever lists it, a pushed pool of ours could supply its own "outside" price and agree
 * with itself. So every pool a quote goes through (`routePlan[].swapInfo.ammKey`) is
 * read from the chain, and a quote through any account our pool program owns is not an
 * outside price. A quote without a readable route is not one either.
 *
 * NO ROUTE IS AN ANSWER. Our proxy turns Jupiter's own "no route" codes into a 404
 * with the fixed body `{"error":"No route","code":"NO_ROUTE"}` (api/aggregator.js
 * `noRouteErrorCodes`) and every other failure into a 502. Two rules decide `no-route`:
 *   1. only a 404 whose JSON body carries `code: "NO_ROUTE"`; any other 404 (a path off
 *      the proxy's allowlist, an unknown provider, a broken platform rewrite) is unread;
 *   2. only on the BUY quote. A priced buy proves the token has an outside market, so a
 *      sale back with no route is unread, not "no market".
 * Everything else is `unread`. The two must stay apart, because a launch pool falls
 * back to its own history only on `no-route` (poolHealth.ts); a down Jupiter is not "no
 * outside market".
 */

export const PROBE_LAMPORTS = 50_000_000n;
const LAMPORTS_PER_SOL = 1e9;
/** More pools than this in two quotes is not a route we can check in one read. */
const MAX_ROUTE_POOLS = 40;

export type OutsidePrice =
  | { kind: 'ok'; solPerToken: number; source: 'Jupiter' }
  /** Jupiter answered that it has no route for this token: no outside market it can reach. */
  | { kind: 'no-route'; detail: string }
  | { kind: 'unread'; detail: string };

class NoRoute extends Error {}

/** How to tell whether a route goes through our own pools: the chain, and our program. */
export interface OwnPoolGuard {
  rpc: SolanaRpc;
  programId: string;
}

interface QuoteShape {
  inputMint?: unknown;
  outputMint?: unknown;
  inAmount?: unknown;
  outAmount?: unknown;
  routePlan?: unknown;
}

function isAddress(s: unknown): s is string {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try {
    return new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
}

/** The proxy's "no route" answer: `{"error":"No route","code":"NO_ROUTE"}` (api/_lib/aggregator-proxy.js). */
async function isNoRouteBody(res: Response): Promise<boolean> {
  try {
    const body = (await res.json()) as { code?: unknown } | null;
    return body !== null && typeof body === 'object' && body.code === 'NO_ROUTE';
  } catch {
    return false;
  }
}

async function quote(
  inputMint: string,
  outputMint: string,
  amount: bigint,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ out: bigint; pools: string[] }> {
  const qs = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amount.toString(),
    slippageBps: '50',
    swapMode: 'ExactIn',
    restrictIntermediateTokens: 'true',
  });
  const res = await fetchImpl(`${JUPITER_PROXY_BASE}/quote?${qs.toString()}`, { headers: { Accept: 'application/json' }, signal });
  // Only our proxy's fixed answer is "no route". Any other 404 (a path off its
  // allowlist, an unknown provider, a platform rewrite gone wrong) is a failed read.
  if (res.status === 404 && (await isNoRouteBody(res))) throw new NoRoute('Jupiter has no route for this token');
  if (!res.ok) throw new Error(`Jupiter did not give a price (HTTP ${res.status})`);
  const q = (await res.json()) as QuoteShape;
  if (q.inputMint !== inputMint || q.outputMint !== outputMint || q.inAmount !== amount.toString()) {
    throw new Error('Jupiter answered for a different trade');
  }
  if (typeof q.outAmount !== 'string' || !/^\d{1,30}$/.test(q.outAmount)) throw new Error('Jupiter answered without an amount');
  const out = BigInt(q.outAmount);
  if (out <= 0n) throw new Error('Jupiter quoted nothing back');
  if (!Array.isArray(q.routePlan) || q.routePlan.length === 0) throw new Error('Jupiter answered without the pools its price came from');
  const pools: string[] = [];
  for (const step of q.routePlan as unknown[]) {
    const key = (step as { swapInfo?: { ammKey?: unknown } } | null)?.swapInfo?.ammKey;
    if (!isAddress(key)) throw new Error('Jupiter named a pool its price came from that is not an address');
    pools.push(key);
  }
  return { out, pools };
}

export async function readOutsidePrice(
  mint: string,
  tokenDecimals: number,
  guard: OwnPoolGuard,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<OutsidePrice> {
  if (mint === SOL_MINT) return { kind: 'unread', detail: 'SOL has no price in SOL' };
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 18) {
    return { kind: 'unread', detail: 'the token’s decimals were not read' };
  }
  let tokensOut: bigint;
  let lamportsBack: bigint;
  let pools: string[];
  const failed = (e: unknown): OutsidePrice => ({ kind: 'unread', detail: e instanceof Error ? e.message : String(e) });
  let buy: { out: bigint; pools: string[] };
  try {
    buy = await quote(SOL_MINT, mint, PROBE_LAMPORTS, fetchImpl, signal);
  } catch (e) {
    // "No route" counts only on the BUY: Jupiter answered that it cannot reach this token.
    if (e instanceof NoRoute) return { kind: 'no-route', detail: e.message };
    return failed(e);
  }
  try {
    const sell = await quote(mint, SOL_MINT, buy.out, fetchImpl, signal);
    tokensOut = buy.out;
    lamportsBack = sell.out;
    pools = [...new Set([...buy.pools, ...sell.pools])];
  } catch (e) {
    // A priced buy proves an outside market, so a sale with no route is a failed read
    // (an amount no route fills), never "no market".
    if (e instanceof NoRoute) return { kind: 'unread', detail: 'Jupiter priced a buy but not the sale back' };
    return failed(e);
  }
  if (pools.length > MAX_ROUTE_POOLS) return { kind: 'unread', detail: 'Jupiter’s price came through more pools than we can check' };
  try {
    const owners = await getMultipleAccounts(guard.rpc, pools);
    if (owners.some((a) => a?.owner === guard.programId)) {
      return { kind: 'unread', detail: 'Jupiter’s price came through our own pools, so it is not an outside price' };
    }
  } catch (e) {
    return { kind: 'unread', detail: `the pools behind Jupiter’s price could not be checked (${clipDetail(e)})` };
  }
  const tokens = Number(tokensOut) / 10 ** tokenDecimals;
  const buyPrice = Number(PROBE_LAMPORTS) / LAMPORTS_PER_SOL / tokens;
  const sellPrice = Number(lamportsBack) / LAMPORTS_PER_SOL / tokens;
  const mid = Math.sqrt(buyPrice * sellPrice);
  if (!Number.isFinite(mid) || mid <= 0) return { kind: 'unread', detail: 'Jupiter’s quotes did not give a usable price' };
  return { kind: 'ok', solPerToken: mid, source: 'Jupiter' };
}

/**
 * A token's outside price in a POOL'S OWN pairing coin: what a pool paired with USDC or
 * BAYLA is checked against. `perToken` is whole coins per whole token.
 */
export type QuotePrice =
  | { kind: 'ok'; perToken: number; source: 'Jupiter' }
  /** Jupiter answered that it has no route for the TOKEN. Never said about the coin. */
  | { kind: 'no-route'; detail: string }
  | { kind: 'unread'; detail: string };

/**
 * The token's outside price in `quote`, from SOL prices only: the token's own
 * (`readOutsidePrice`) and, for a coin that is not SOL, that coin's own, read the same
 * way. Both are the mid of a 0.05 SOL round trip, so their ratio is the token priced in
 * the coin with each route's fees cancelled, and no second kind of Jupiter read exists.
 *
 * For SOL the answer IS the token's price: `coin` is not looked at.
 *
 * `no-route` is only ever the TOKEN's: it means the token has no outside market, and a
 * launch pool then falls back to its own history (poolHealth.ts). A pairing coin that
 * could not be priced (not asked, a failed read, even "no route") is `unread`: the
 * token may well trade elsewhere, and unread is never a pass.
 */
export function priceInQuote(token: OutsidePrice, quote: QuoteCoin, coin: OutsidePrice | null): QuotePrice {
  if (token.kind !== 'ok') return token;
  if (quote.native) return { kind: 'ok', perToken: token.solPerToken, source: 'Jupiter' };
  if (!coin) return { kind: 'unread', detail: `the price of ${quote.symbol} was not read` };
  if (coin.kind !== 'ok') return { kind: 'unread', detail: `the price of ${quote.symbol} could not be read (${coin.detail})` };
  const perToken = token.solPerToken / coin.solPerToken;
  if (!Number.isFinite(perToken) || perToken <= 0) return { kind: 'unread', detail: `the price of ${quote.symbol} did not give a usable price` };
  return { kind: 'ok', perToken, source: 'Jupiter' };
}
