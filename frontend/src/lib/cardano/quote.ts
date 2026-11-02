// A Cardano swap quote: one Minswap V2 pool, read from the chain, priced with Minswap's own
// maths. What the trader gets is what the batcher must pay if the pool has not moved; the
// minimum written into the order is that less the slippage.

import { calculateAmountOut, minimumReceive, priceImpactBps } from './math';
import { isAda, sameAsset, tradingFeeFor, type CardanoAsset, type PoolState } from './minswapV2';
import { venueFeeFor, type VenueFee } from './venueFee';

export interface SwapQuote {
  pool: PoolState;
  assetIn: CardanoAsset;
  assetOut: CardanoAsset;
  amountIn: bigint;
  expectedOut: bigint;
  minimumReceive: bigint;
  slippageBps: number;
  /** The pool's trading fee on this side, in 10,000ths of the amount paid in. */
  poolFeeNumerator: bigint;
  /** Of that fee, the share Minswap keeps for itself (10,000ths of the fee); null when off. */
  minswapShareNumerator: bigint | null;
  priceImpactBps: number;
  /** The swap's ADA side, the venue fee's basis; null on a token-for-token pair. */
  adaSide: bigint | null;
  venueFee: VenueFee;
}

export type QuoteResult = { kind: 'quote'; quote: SwapQuote } | { kind: 'refused'; reason: string };

export function quoteSwap(
  pool: PoolState,
  assetIn: CardanoAsset,
  amountIn: bigint,
  slippageBps: number,
  venueFeeMinLovelace: bigint,
  feeOpts?: Parameters<typeof venueFeeFor>[2],
): QuoteResult {
  if (amountIn <= 0n) return { kind: 'refused', reason: 'Enter an amount.' };
  const aToB = sameAsset(assetIn, pool.assetA);
  if (!aToB && !sameAsset(assetIn, pool.assetB)) return { kind: 'refused', reason: 'That coin is not in this pool.' };
  if (pool.allowDynamicFee) {
    return { kind: 'refused', reason: 'This pool lets its batcher add a fee to each trade, so the price cannot be known in advance. This page does not trade there.' };
  }
  const assetOut = aToB ? pool.assetB : pool.assetA;
  const reserveIn = aToB ? pool.reserveA : pool.reserveB;
  const reserveOut = aToB ? pool.reserveB : pool.reserveA;
  const fee = tradingFeeFor(pool, assetIn);
  const expectedOut = calculateAmountOut(reserveIn, reserveOut, amountIn, fee);
  if (expectedOut <= 0n) return { kind: 'refused', reason: 'This amount is too small to buy anything from the pool.' };
  const min = minimumReceive(expectedOut, slippageBps);
  if (min <= 0n) return { kind: 'refused', reason: 'This amount is too small for its minimum to be above zero.' };
  const adaSide = isAda(assetIn) ? amountIn : isAda(assetOut) ? expectedOut : null;
  return {
    kind: 'quote',
    quote: {
      pool,
      assetIn,
      assetOut,
      amountIn,
      expectedOut,
      minimumReceive: min,
      slippageBps,
      poolFeeNumerator: fee,
      minswapShareNumerator: pool.feeSharingNumerator,
      priceImpactBps: priceImpactBps(reserveIn, reserveOut, amountIn, expectedOut, fee),
      adaSide,
      venueFee: venueFeeFor(adaSide, venueFeeMinLovelace, feeOpts),
    },
  };
}
