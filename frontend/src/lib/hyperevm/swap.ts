import { encodeFunctionData } from 'viem';
import { poolSide, type HyperEvmToken, type HyperEvmVenue } from '../chains/hyperEvm';
import { QUOTER_V2_READ_ABI, v3MidOut } from '../evm/islandV3Route';
import { UNIVERSAL_ROUTER_ABI, buyWithEth, portion, sellForEth, swapTokens, swapTokensFeeOnInput, type PermitSingle } from '../evm/universalRouter';
import type { HyperEvmReader, V3Pool } from './pools';

/**
 * A swap on our HyperEVM pools: quoted by our QuoterV2, sent through our Universal Router,
 * which pays the site fee to the treasury Safe in the same transaction (PAY_PORTION). The
 * sequences are universalRouter.ts's, the ones Base's swap signs, at the router's six-field
 * encoding. Only our pools are quoted: no other venue is ever compared or routed to.
 *
 * Where the site fee is taken: from the HYPE going in when HYPE is spent (the router pays it
 * before wrapping); from the coin going in when the coin coming out is one the site does not
 * list (a coin someone opened a pool for), so the treasury is never paid in it; else from the
 * coin coming out (the router holds the output, pays the fee, and sends the rest). Either way
 * `out` below is what the wallet receives, after that fee.
 */
export interface SwapQuote {
  pool: V3Pool;
  from: HyperEvmToken;
  to: HyperEvmToken;
  amountIn: bigint;
  /** What the wallet receives, after the pool's fee and the site fee. */
  out: bigint;
  /** The site fee: its amount and the coin it is paid in. */
  siteFee: { amount: bigint; token: HyperEvmToken };
  /** What `amountIn` is worth at the pool's price before any fee, for the price-impact line. */
  midOut: bigint;
}

export type QuoteResult =
  | { ok: true; best: SwapQuote; all: SwapQuote[] }
  | { ok: false; why: 'same-coin' | 'wrap' | 'no-pool' | 'unread' | 'zero' };

/** Whether the site fee comes out of the coin going in: HYPE spent, or a coin off the list coming out. */
export function siteFeeOnInput(from: HyperEvmToken, to: HyperEvmToken): boolean {
  return !!from.isNative || (!!to.unlisted && !from.unlisted);
}

function sameSide(a: HyperEvmToken, b: HyperEvmToken): boolean {
  return poolSide(a).toLowerCase() === poolSide(b).toLowerCase();
}

/** The pools that hold both coins, with liquidity in range. */
export function poolsFor(pools: readonly V3Pool[], from: HyperEvmToken, to: HyperEvmToken): V3Pool[] {
  const a = poolSide(from).toLowerCase();
  const b = poolSide(to).toLowerCase();
  return pools.filter((p) => {
    const t0 = p.token0.address.toLowerCase();
    const t1 = p.token1.address.toLowerCase();
    return p.liquidity > 0n && ((t0 === a && t1 === b) || (t0 === b && t1 === a));
  });
}

/**
 * Quote every pool of the pair and take the one that pays the wallet most. A pool whose quote
 * fails is left out; if every one fails, the quote is unread, never zero.
 */
export async function quoteSwap(reader: HyperEvmReader, venue: HyperEvmVenue, pools: readonly V3Pool[], from: HyperEvmToken, to: HyperEvmToken, amountIn: bigint): Promise<QuoteResult> {
  if (from.address.toLowerCase() === to.address.toLowerCase()) return { ok: false, why: 'same-coin' };
  if (sameSide(from, to)) return { ok: false, why: 'wrap' };
  if (amountIn <= 0n) return { ok: false, why: 'zero' };
  const candidates = poolsFor(pools, from, to);
  if (candidates.length === 0) return { ok: false, why: 'no-pool' };
  const tokenIn = poolSide(from);
  const tokenOut = poolSide(to);
  const onInput = siteFeeOnInput(from, to);
  const feeIn = onInput ? portion(amountIn, venue.siteFeeBps) : 0n;
  const swapped = amountIn - feeIn;
  const quotes = await Promise.all(candidates.map(async (pool): Promise<SwapQuote | null> => {
    try {
      const { result } = await reader.simulateContract({
        address: venue.quoterV2, abi: QUOTER_V2_READ_ABI, functionName: 'quoteExactInputSingle',
        args: [{ tokenIn, tokenOut, amountIn: swapped, fee: pool.fee, sqrtPriceLimitX96: 0n }],
      });
      const gross = (result as readonly [bigint, ...unknown[]])[0];
      const feeOut = onInput ? 0n : portion(gross, venue.siteFeeBps);
      return {
        pool, from, to, amountIn,
        out: gross - feeOut,
        siteFee: onInput ? { amount: feeIn, token: from } : { amount: feeOut, token: to },
        midOut: v3MidOut(amountIn, pool.sqrtPriceX96, tokenIn, tokenOut),
      };
    } catch {
      return null;
    }
  }));
  const all = quotes.filter((q): q is SwapQuote => q !== null && q.out > 0n);
  if (all.length === 0) return { ok: false, why: 'unread' };
  const best = all.reduce((b, q) => (q.out > b.out ? q : b));
  return { ok: true, best, all };
}

/** The least the wallet accepts: the quote less the slippage it allowed, rounded down. */
export function minReceived(out: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) throw new Error('slippage out of range');
  return (out * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** Price impact in basis points: how far the fill is below the pool's price, fees included. */
export function priceImpactBps(q: SwapQuote): number {
  if (q.midOut <= 0n || q.out >= q.midOut) return 0;
  return Number(((q.midOut - q.out) * 10_000n) / q.midOut);
}

export interface SwapTx {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
}

/** The one transaction the wallet signs: our Universal Router's execute, with the site fee in it. */
export function buildSwapTx(a: {
  venue: HyperEvmVenue;
  quote: SwapQuote;
  minOut: bigint;
  deadline: bigint;
  permit?: { permit: PermitSingle; signature: `0x${string}` };
}): SwapTx {
  const { venue, quote, minOut } = a;
  const common = { chainId: venue.chainId, poolFee: quote.pool.fee, minOut, feeBips: venue.siteFeeBps, feeRecipient: venue.treasury };
  let call;
  if (quote.from.isNative) {
    call = buyWithEth({ ...common, coin: poolSide(quote.to), weth: venue.whype });
  } else if (quote.to.isNative) {
    call = sellForEth({ ...common, coin: quote.from.address, weth: venue.whype, amountIn: quote.amountIn, permit: a.permit });
  } else if (siteFeeOnInput(quote.from, quote.to)) {
    call = swapTokensFeeOnInput({ ...common, tokenIn: quote.from.address, tokenOut: quote.to.address, amountIn: quote.amountIn, permit: a.permit });
  } else {
    call = swapTokens({ ...common, tokenIn: quote.from.address, tokenOut: quote.to.address, amountIn: quote.amountIn, permit: a.permit });
  }
  return {
    to: venue.universalRouter,
    value: quote.from.isNative ? quote.amountIn : 0n,
    data: encodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [call.commands, call.inputs, a.deadline] }),
  };
}
