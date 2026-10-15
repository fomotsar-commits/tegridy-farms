// THE POOLS PAGE'S ONLY WAY INTO THE WRITE LAYER (the other loaders are
// components/solana/curve/writeApi.ts, the launch page's, and
// components/swap/venueSwapApi.ts, the swap page's).
//
// Everything is a dynamic import, called only once LP's own switch
// (lib/launcher/solana/lpWriteFlag.ts) is not 'off'. A production build with the
// switch 'off' therefore never fetches the liquidity builders or the signer path.
// It loads only what adding, removing and opening a pool need: the gate and the create
// facts, the builders, the send path and one display rule. Never the launch page's upload or metadata clients (D19).
//
// The real functions are assigned into `LpWriteApi` (curve/ports.ts) below, so a drift
// between the write layer and the UI is a type error here, and nowhere else.

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
  const [config, liquidity, createPool, submit, validate] = await Promise.all([
    import('../../../lib/launcher/solana/write/config'),
    import('../../../lib/launcher/solana/write/liquidity'),
    import('../../../lib/launcher/solana/write/createPool'),
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
    submitPrepared: submit.submitPrepared,
    recheckOutcome: (rpc, signature, opts) => submit.recheckOutcome(rpc, signature, opts ?? {}),
    explorerTxUrl: config.explorerTxUrl,
    explorerAddressUrl: config.explorerAddressUrl,
    meta: { displaySafe: validate.displaySafe },
  };
  return api;
}
