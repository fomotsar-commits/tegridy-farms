// THE COVENANT SPLIT — config-shaped, and DORMANT.
//
// "Covenant hooks, dormant: fee routing stays your architecture, covenant split
//  config-shaped and inactive until certified pools exist." (build directive §4)
//
// ## What "dormant" means here, precisely
//
// This module describes a split. It does not apply one. Nothing in the launch path
// imports `COVENANT_SPLIT` to compute anything, `resolveFeeConstitution` is untouched,
// and `isCovenantActive()` returns false with no env var that can flip it on. A future
// change that activates this must ALSO change the launch path, which is the point: the
// activation cannot happen by accident, from a dashboard, or from a typo in a .env file.
//
// ## Why it exists at all before it is used
//
// Two reasons, both about not being surprised later. First, the certified-soil lane is a
// THIRD launch tier carrying the island's split, not a tweak to our existing 70/10/15/5 —
// writing that down now stops it being discovered as a "small change" at the worst
// moment. Second, there is a real unresolved conflict below that needs the island's
// answer, and a file is a better place to keep an open question than a memory.
//
// ## ⚠️ THE UNRESOLVED CONFLICT — read before activating anything
//
// Doppler takes a HARD floor of >= 5% of streamed fees on the EVM rail. It is not
// negotiable and it is not ours to waive. The covenant below sums to 100%, so on the EVM
// rail Doppler's 5% has to come OUT OF one of these five slices — and which one is the
// island's decision, not ours. Until they answer, activating this on the EVM rail would
// mean silently taking that 5% from whichever slice our code happened to round down.
//
// The Solana rails have no such floor, so the covenant is expressible there exactly as
// written. That asymmetry is itself a reason the split must be per-rail config rather
// than one constant.

import type { FeeConstitutionLine } from './factSheet';

/** One slice of the covenant, as the island published it. */
export interface CovenantSlice {
  /** The island's own name for this slice. Rendered verbatim if it is ever rendered. */
  name: string;
  shareBps: number;
  /** What the slice is for, in the island's terms. */
  purpose: string;
}

/**
 * The island's 50/20/15/10/5 covenant for CERTIFIED pools.
 *
 * Declared `readonly` and never mutated. Sums to 10_000 bps — asserted by its test, so a
 * slice edited in isolation breaks a build rather than quietly rebalancing the split.
 */
export const COVENANT_SPLIT: readonly CovenantSlice[] = [
  { name: 'Creator', shareBps: 5000, purpose: 'the person who made the thing' },
  { name: 'Community', shareBps: 2000, purpose: 'the certified community the pool belongs to' },
  { name: 'Island', shareBps: 1500, purpose: 'the standard, its instrument and its enrollment' },
  { name: 'Venue', shareBps: 1000, purpose: 'the rail that carried the launch' },
  { name: 'Reserve', shareBps: 500, purpose: 'held against the covenant’s own obligations' },
] as const;

/**
 * Is the covenant split in force?
 *
 * ALWAYS FALSE, and deliberately not configurable. Certified pools do not exist yet — the
 * island's first certifications have not closed (see certification.ts), so there is no
 * pool this could correctly apply to. Making this an env flag would let a deploy activate
 * a fee split for pools that cannot be certified, which is worse than not shipping it.
 *
 * When it does activate it will be BECAUSE `isCertified(community)` returned an island
 * YES for a specific pool — a per-pool fact, not a global switch.
 */
export function isCovenantActive(): boolean {
  return false;
}

/**
 * The covenant expressed in the venue's own FeeConstitutionLine shape.
 *
 * PREVIEW AND DISCLOSURE ONLY. Provided so a "what would a certified launch pay?" panel
 * can render the real numbers without a second, drifting copy of them — NOT so a launch
 * path can consume it. Every caller of this must be display code; if one is not, the
 * dormancy above is a comment rather than a fact.
 */
export function covenantFeeConstitution(): FeeConstitutionLine[] {
  return COVENANT_SPLIT.map((s) => ({
    recipient: s.name,
    shareBps: s.shareBps,
    role: s.name === 'Creator' ? 'creator' : 'other',
  }));
}

/** Total bps of the covenant. Exists so the invariant is checkable from outside. */
export function covenantTotalBps(): number {
  return COVENANT_SPLIT.reduce((a, s) => a + s.shareBps, 0);
}
