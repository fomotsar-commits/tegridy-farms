// THE COVENANT, config-shaped and DORMANT. The island's blueprint: "On every certified pool,
// the covenant splits venue fees onchain: stakers 50, liquidity 20, operations 15, creator
// grants 10, island commons 5." It splits the venue's fees only. Each launch's own fee table,
// the builder's, is separate and set at create. Nothing imports this to compute a fee, and
// isCovenantActive() is hard-coded off, so switching it on means changing the launch path too.
// Ask the island first how the EVM rail's Doppler floor (at least 5% of streamed fees) fits.

import type { FeeConstitutionLine } from './factSheet';

/** One slice of the covenant, as the island published it. */
export interface CovenantSlice {
  /** The island's own name for this slice. Rendered verbatim if it is ever rendered. */
  name: string;
  shareBps: number;
}

/** The island's 50/20/15/10/5 covenant for CERTIFIED pools. Its test pins the names and the
 *  sum, so a slice edited alone breaks the build rather than rebalancing the split. */
export const COVENANT_SPLIT: readonly CovenantSlice[] = [
  { name: 'stakers', shareBps: 5000 },
  { name: 'liquidity', shareBps: 2000 },
  { name: 'operations', shareBps: 1500 },
  { name: 'creator grants', shareBps: 1000 },
  { name: 'island commons', shareBps: 500 },
] as const;

/** ALWAYS FALSE, and deliberately not configurable: no pool is certified yet. A future switch
 *  must come from the island certifying a specific pool, never from an env var or a deploy. */
export function isCovenantActive(): boolean {
  return false;
}

/** The covenant in the venue's FeeConstitutionLine shape, for display only, never for a
 *  launch path. No slice is the launch's creator: the builder's fee table is separate. */
export function covenantFeeConstitution(): FeeConstitutionLine[] {
  return COVENANT_SPLIT.map((s) => ({ recipient: s.name, shareBps: s.shareBps, role: 'other' }));
}

/** Total bps of the covenant. Exists so the invariant is checkable from outside. */
export function covenantTotalBps(): number {
  return COVENANT_SPLIT.reduce((a, s) => a + s.shareBps, 0);
}
