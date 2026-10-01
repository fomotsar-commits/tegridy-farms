// ONE OF TWO FILES IN THE UI THAT LOAD THE WRITE LAYER; the other is
// `components/solana/lp/lpWriteApi.ts`, the pools page's liquidity path.
//
// Everything is a dynamic import, called only once the flag in
// lib/launcher/solana/curveWriteFlag.ts says writes may load. A production build
// with writes off therefore never fetches the transaction builders, the signer
// path or the upload client; they sit in chunks nothing requests.
//
// The real functions are assigned into `WriteApi` (ports.ts) below, so if the
// transaction or metadata layer drifts from the contract the UI was built against,
// this file stops compiling, and nothing else in the UI needs to change.

import type { WriteApi } from './ports';

let cached: Promise<WriteApi> | null = null;

export function loadWriteApi(): Promise<WriteApi> {
  if (!cached) {
    cached = build().catch((e: unknown) => {
      // A failed chunk load must be retryable, not cached forever.
      cached = null;
      throw e;
    });
  }
  return cached;
}

async function build(): Promise<WriteApi> {
  const [config, launch, trade, graduate, poolSwap, submit, metadata, list, pool, validate, upload] = await Promise.all([
    import('../../../lib/launcher/solana/write/config'),
    import('../../../lib/launcher/solana/write/launch'),
    import('../../../lib/launcher/solana/write/trade'),
    import('../../../lib/launcher/solana/write/graduate'),
    import('../../../lib/launcher/solana/write/poolSwap'),
    import('../../../lib/launcher/solana/write/submit'),
    import('../../../lib/launcher/solana/discover/metadata'),
    import('../../../lib/launcher/solana/discover/list'),
    import('../../../lib/launcher/solana/discover/pool'),
    import('../../../lib/launchMetadata/validate.js'),
    import('../../../lib/launchMetadata/upload'),
  ]);

  const api: WriteApi = {
    curveWriteConfig: () => config.curveWriteConfig(),
    readWriteGate: config.readWriteGate,
    writeActions: config.writeActions,
    explorerTxUrl: config.explorerTxUrl,

    quoteOpeningBuy: launch.quoteOpeningBuy,
    priceImpactBps: trade.priceImpactBps,

    prepareCreateLaunch: launch.prepareCreateLaunch,
    prepareCurveBuy: trade.prepareCurveBuy,
    prepareCurveSell: trade.prepareCurveSell,
    prepareMigrate: graduate.prepareMigrate,
    preparePoolSwap: poolSwap.preparePoolSwap,

    submitPrepared: submit.submitPrepared,
    recheckOutcome: (rpc, signature, opts) => submit.recheckOutcome(rpc, signature, opts ?? {}),

    readTokenMetadata: metadata.readTokenMetadata,
    listRecentLaunches: (rpc, cfg, opts) => list.listRecentLaunches(rpc, cfg, opts),
    listLaunchesByCreator: (rpc, cfg, creator, opts) => list.listLaunchesByCreator(rpc, cfg, creator, opts),
    readLaunchOrigin: list.readLaunchOrigin,
    readCreatorHolding: list.readCreatorHolding,
    readLaunchPool: pool.readLaunchPool,

    meta: {
      LIMITS: validate.LIMITS,
      checkName: validate.checkName,
      checkSymbol: validate.checkSymbol,
      checkDescription: validate.checkDescription,
      checkLinks: validate.checkLinks,
      checkContentUri: validate.checkContentUri,
      displaySafe: validate.displaySafe,
      impersonationWarning: validate.impersonationWarning,
      uploadsAvailable: () => upload.uploadsAvailable(),
      prepareLaunchImage: (file) => upload.prepareLaunchImage(file),
      uploadLaunchMetadata: (i) => upload.uploadLaunchMetadata(i),
      readLaunchMetadataJson: (uri, expectedMint) => upload.readLaunchMetadataJson(uri, expectedMint),
    },
  };
  return api;
}
