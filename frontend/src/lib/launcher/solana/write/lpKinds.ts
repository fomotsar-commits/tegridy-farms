// Which kinds of transaction go through one of our pools: adding, removing, opening a
// pool, or (`lp-swap`) a swap through one from the main swap page.
//
// Every place that asks "is this a liquidity kind?" asks HERE. A list written out by
// hand in each file is how a third kind slips past one of them: the decoder would send
// an opening to the withdrawal check, the failure copy would fall back to the swap's
// words, and a pending note would lose its pool. Because `LP_KINDS` is a Record over
// `LpKind`, a new kind does not compile until it is listed here.
//
// Web3-free (types only), so the UI may import it without loading the write layer.

import type { LpKind } from './types';

/** Every liquidity kind. A Record, so a new kind is a compile error here until it is listed. */
export const LP_KINDS: Readonly<Record<LpKind, true>> = {
  'lp-deposit': true,
  'lp-withdraw': true,
  'lp-create': true,
  // A swap through one of our pools from the main swap page. It is a pool kind: it is
  // judged against the pool's pins, gets the pool program's failure copy and keeps its
  // pool on a pending note.
  'lp-swap': true,
};

/** True for a liquidity kind, and for nothing else (an unknown string, null and undefined included). */
export function isLpKind(k: string | null | undefined): k is LpKind {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(LP_KINDS, k);
}
