// THE SWAP PAGE'S ONLY WAY INTO THE WRITE LAYER (its siblings: curve/writeApi.ts and
// lp/lpWriteApi.ts). All dynamic imports, asked for only once one of our own pools has
// quoted the pair on screen (useVenueSwap.ts): a visit that trades through the
// aggregator never fetches the swap builder. The functions are assigned into
// `VenueSwapApi` (curve/ports.ts), so a drift from the write layer is a type error here.

import type { VenueSwapApi } from '../solana/curve/ports';

let cached: Promise<VenueSwapApi> | null = null;

export function loadVenueSwapApi(): Promise<VenueSwapApi> {
  if (!cached) {
    cached = build().catch((e: unknown) => {
      // A failed chunk load must be retryable, not cached forever.
      cached = null;
      throw e;
    });
  }
  return cached;
}

async function build(): Promise<VenueSwapApi> {
  const [config, venueSwap, submit, validate] = await Promise.all([
    import('../../lib/launcher/solana/write/config'),
    import('../../lib/launcher/solana/write/venueSwap'),
    import('../../lib/launcher/solana/write/submit'),
    import('../../lib/launchMetadata/validate.js'),
  ]);
  const api: VenueSwapApi = {
    swapWriteConfig: () => config.swapWriteConfig(),
    readSwapGate: (rpc, cfg) => config.readSwapGate(rpc, cfg),
    prepareVenueSwap: venueSwap.prepareVenueSwap,
    submitPrepared: submit.submitPrepared,
    recheckOutcome: (rpc, signature, opts) => submit.recheckOutcome(rpc, signature, opts ?? {}),
    explorerTxUrl: config.explorerTxUrl,
    meta: { displaySafe: validate.displaySafe },
  };
  return api;
}
