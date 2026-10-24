// Whether visitors see the Cardano swap: its tab in the Swap section, its route, and its row
// in the network drop-down. Plain text only, like solana/clmm/programId.ts: the nav reads it
// in the main bundle, so it never imports the Cardano library to decide whether to show a tab.

/**
 * The owner's switch, committed off. Three things must be true before it flips: the venue's
 * Cardano fee address is registered (venueFee.ts), the chain-data key is set on the server
 * (api/cardano.js), and a real swap has been walked end to end on mainnet.
 */
export const CARDANO_SWAP_OPEN: boolean = false;

/**
 * Shown once opened; or in a build made with `--mode cardano-preview`, which is how the tab
 * is walked before it opens. Production builds use the mode 'production'.
 */
export function cardanoSwapVisible(open: boolean = CARDANO_SWAP_OPEN, mode: string = import.meta.env.MODE): boolean {
  return open || mode === 'cardano-preview';
}
