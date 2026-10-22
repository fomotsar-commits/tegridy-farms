// Which kinds of transaction are range-position changes. Every place that asks asks HERE,
// as lpKinds.ts does for liquidity, so a new kind cannot slip past one of them.
//
// Web3-free (types only), so the UI may import it without loading the write layer.

import type { RangeKind } from './types';

export const RANGE_KINDS: Readonly<Record<RangeKind, true>> = {
  'range-open': true,
  'range-remove': true,
  'range-close': true,
};

export function isRangeKind(k: string | null | undefined): k is RangeKind {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(RANGE_KINDS, k);
}
