// THE RANGE TAB'S ONLY WAY INTO THE WRITE LAYER (the pools page's is
// components/solana/lp/lpWriteApi.ts). Dynamic imports only, called once range pools show
// and LP's switch is not 'off', so no other visit fetches the range builders.
//
// The real functions are assigned into `RangeWriteApi` (curve/ports.ts) below, so a drift
// between the write layer and the UI is a type error here.

import type { RangeWriteApi } from '../curve/ports';

let cached: Promise<RangeWriteApi> | null = null;

export function loadRangeWriteApi(): Promise<RangeWriteApi> {
  if (!cached) {
    cached = build().catch((e: unknown) => {
      // A failed chunk load must be retryable, not cached forever.
      cached = null;
      throw e;
    });
  }
  return cached;
}

async function build(): Promise<RangeWriteApi> {
  const [config, range, submit, validate] = await Promise.all([
    import('../../../lib/launcher/solana/write/config'),
    import('../../../lib/launcher/solana/write/range'),
    import('../../../lib/launcher/solana/write/submit'),
    import('../../../lib/launchMetadata/validate.js'),
  ]);
  return {
    rangeWriteConfig: () => config.lpWriteConfig(),
    prepareRangeOpen: range.prepareRangeOpen,
    prepareRangeRemove: range.prepareRangeRemove,
    prepareRangeClose: range.prepareRangeClose,
    submitPrepared: submit.submitPrepared,
    recheckOutcome: (rpc, signature, opts) => submit.recheckOutcome(rpc, signature, opts ?? {}),
    explorerTxUrl: config.explorerTxUrl,
    meta: { displaySafe: validate.displaySafe },
  };
}
