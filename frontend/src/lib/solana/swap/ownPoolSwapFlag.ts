// Whether the Solana swap may SEND a trade to one of our own pools. Web3-free, like
// lpWriteFlag.ts: the page reads it before any swap code is fetched. 'off', the line
// still compares our pools with Jupiter and says so, every trade goes through Jupiter,
// and the swap builder is never downloaded. One committed constant; no env changes it.

export type OwnPoolSwapMode = 'on' | 'off';

/** 'on' from the release that made the swap execute its own route (2026-10-06). */
export const OWN_POOL_SWAPS: OwnPoolSwapMode = 'on';

/** The mode for this build. `committed` is a parameter only so the rule stays testable. */
export function ownPoolSwapsOn(committed: OwnPoolSwapMode = OWN_POOL_SWAPS): boolean {
  return committed === 'on';
}
