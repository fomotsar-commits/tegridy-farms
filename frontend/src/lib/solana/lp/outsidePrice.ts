import { JUPITER_PROXY_BASE, SOL_MINT } from '../../solana';

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
 * No platform fee is asked for (no `platformFeeBps`), so our own fee does not bend it,
 * and Jupiter does not route through our program, so the answer is not our own pools
 * quoting themselves.
 *
 * Production's proxy turns every upstream error into a 502, so "Jupiter has no route for
 * this token" and "Jupiter is down" look the same here. Both are `unread`, which is
 * honest: either way we have no outside price.
 */

export const PROBE_LAMPORTS = 50_000_000n;
const LAMPORTS_PER_SOL = 1e9;

export type OutsidePrice =
  | { kind: 'ok'; solPerToken: number; source: 'Jupiter' }
  | { kind: 'unread'; detail: string };

interface QuoteShape {
  inputMint?: unknown;
  outputMint?: unknown;
  inAmount?: unknown;
  outAmount?: unknown;
}

async function quote(
  inputMint: string,
  outputMint: string,
  amount: bigint,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<bigint> {
  const qs = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amount.toString(),
    slippageBps: '50',
    swapMode: 'ExactIn',
    restrictIntermediateTokens: 'true',
  });
  const res = await fetchImpl(`${JUPITER_PROXY_BASE}/quote?${qs.toString()}`, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) throw new Error(`Jupiter did not give a price (HTTP ${res.status})`);
  const q = (await res.json()) as QuoteShape;
  if (q.inputMint !== inputMint || q.outputMint !== outputMint || q.inAmount !== amount.toString()) {
    throw new Error('Jupiter answered for a different trade');
  }
  if (typeof q.outAmount !== 'string' || !/^\d{1,30}$/.test(q.outAmount)) throw new Error('Jupiter answered without an amount');
  const out = BigInt(q.outAmount);
  if (out <= 0n) throw new Error('Jupiter quoted nothing back');
  return out;
}

export async function readOutsidePrice(
  mint: string,
  tokenDecimals: number,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<OutsidePrice> {
  if (mint === SOL_MINT) return { kind: 'unread', detail: 'SOL has no price in SOL' };
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 18) {
    return { kind: 'unread', detail: 'the token’s decimals were not read' };
  }
  try {
    const tokensOut = await quote(SOL_MINT, mint, PROBE_LAMPORTS, fetchImpl, signal);
    const lamportsBack = await quote(mint, SOL_MINT, tokensOut, fetchImpl, signal);
    const tokens = Number(tokensOut) / 10 ** tokenDecimals;
    const buy = Number(PROBE_LAMPORTS) / LAMPORTS_PER_SOL / tokens;
    const sell = Number(lamportsBack) / LAMPORTS_PER_SOL / tokens;
    const mid = Math.sqrt(buy * sell);
    if (!Number.isFinite(mid) || mid <= 0) return { kind: 'unread', detail: 'Jupiter’s quotes did not give a usable price' };
    return { kind: 'ok', solPerToken: mid, source: 'Jupiter' };
  } catch (e) {
    return { kind: 'unread', detail: e instanceof Error ? e.message : String(e) };
  }
}
