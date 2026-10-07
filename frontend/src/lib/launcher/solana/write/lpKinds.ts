// Which kinds of transaction are liquidity changes: adding, removing, or opening a pool.
//
// Every place that asks "is this a liquidity kind?" asks HERE. A list written out by
// hand in each file is how a third kind slips past one of them: the decoder would send
// an opening to the withdrawal check, the failure copy would fall back to the swap's
// words, and a pending note would lose its pool. Because `LP_KINDS` is a Record over
// `LpKind`, a new kind does not compile until it is listed here.
//
// Web3-free (types only), so the UI may import it without loading the write layer.

import type { LpKind, PoolKind } from './types';

/** Every liquidity kind. A Record, so a new kind is a compile error here until it is listed. */
export const LP_KINDS: Readonly<Record<LpKind, true>> = {
  'lp-deposit': true,
  'lp-withdraw': true,
  'lp-create': true,
};

/** True for a liquidity kind, and for nothing else (an unknown string, null and undefined included). */
export function isLpKind(k: string | null | undefined): k is LpKind {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(LP_KINDS, k);
}

/**
 * Every kind judged against `PoolPins`: the liquidity kinds, and a swap in one of our
 * pools. A swap is NOT a liquidity kind (`isLpKind` stays false for it), so the liquidity
 * copy, scope and pool note never apply to it.
 */
export const POOL_KINDS: Readonly<Record<PoolKind, true>> = { ...LP_KINDS, 'venue-swap': true };

/** True for a kind judged against `PoolPins`, and for nothing else. */
export function isPoolKind(k: string | null | undefined): k is PoolKind {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(POOL_KINDS, k);
}
