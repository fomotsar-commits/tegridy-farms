// Whether visitors see the Cardano swap: its tab in the Swap section, its route, and its row
// in the network drop-down. Plain text only, like solana/clmm/programId.ts: the nav reads it
// in the main bundle, so it never imports the Cardano library to decide whether to show a tab.

/**
 * The owner's switch. Opened 2026-10-24 on the owner's word, after the chain-data key was set
 * on the server (api/cardano.js) and a real buy and a real sell were walked end to end on
 * mainnet. It opened WITHOUT a venue fee: the owner's call, until the two-key Cardano treasury
 * exists (venueFee.ts CARDANO_VENUE_FEE_ADDRESS is null, so no fee line is built or shown).
 */
export const CARDANO_SWAP_OPEN: boolean = true;

/**
 * Shown once opened; or in a build made with `--mode cardano-preview`, which is how the tab
 * is walked before it opens. Production builds use the mode 'production'.
 */
export function cardanoSwapVisible(open: boolean = CARDANO_SWAP_OPEN, mode: string = import.meta.env.MODE): boolean {
  return open || mode === 'cardano-preview';
}

/**
 * The owner's switch for the venue's OWN Cardano pools: the LP screens (open a pool, add,
 * remove, your positions) at /cardano-pools. Off: nothing is on chain yet (api/_lib/
 * cardano-own-pools.js is null). Even switched on, the screens build nothing until that
 * record is filled, and say so.
 */
export const CARDANO_OWN_POOLS_OPEN: boolean = false;

/** Shown once opened, or in a `--mode cardano-preview` build, as the swap was walked before it opened. */
export function cardanoOwnPoolsVisible(open: boolean = CARDANO_OWN_POOLS_OPEN, mode: string = import.meta.env.MODE): boolean {
  return open || mode === 'cardano-preview';
}
