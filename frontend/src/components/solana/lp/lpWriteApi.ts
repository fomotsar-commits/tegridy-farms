// The pools page's and the swap page's only way into the LP write layer (the launch page
// has curve/writeApi.ts). Everything is a dynamic import, loaded only once LP's switch is
// not 'off', so such a build never fetches the builders or the signer path, and never the
// launch page's upload or metadata clients. The real functions are assigned into
// `LpWriteApi` (curve/ports.ts) below, so a drift between the layer and the UI is a type error.

import type { LpWriteApi } from '../curve/ports';

let cached: Promise<LpWriteApi> | null = null;

export function loadLpWriteApi(): Promise<LpWriteApi> {
  if (!cached) {
    cached = build().catch((e: unknown) => {
      // A failed chunk load must be retryable, not cached forever.
      cached = null;
      throw e;
    });
  }
  return cached;
}

async function build(): Promise<LpWriteApi> {
  const [config, liquidity, createPool, venueSwap, submit, validate] = await Promise.all([
    import('../../../lib/launcher/solana/write/config'),
    import('../../../lib/launcher/solana/write/liquidity'),
    import('../../../lib/launcher/solana/write/createPool'),
    import('../../../lib/launcher/solana/write/venueSwap'),
    import('../../../lib/launcher/solana/write/submit'),
    import('../../../lib/launchMetadata/validate.js'),
  ]);
  const api: LpWriteApi = {
    lpWriteConfig: () => config.lpWriteConfig(),
    readLpGate: (rpc, cfg) => config.readLpGate(rpc, cfg),
    readCreateFacts: config.readCreateFacts,
    prepareLpDeposit: liquidity.prepareLpDeposit,
    prepareLpWithdraw: liquidity.prepareLpWithdraw,
    prepareLpCreate: createPool.prepareLpCreate,
    prepareVenueSwap: venueSwap.prepareVenueSwap,
    submitPrepared: submit.submitPrepared,
    recheckOutcome: (rpc, signature, opts) => submit.recheckOutcome(rpc, signature, opts ?? {}),
    explorerTxUrl: config.explorerTxUrl,
    meta: { displaySafe: validate.displaySafe },
  };
  return api;
}
