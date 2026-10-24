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
