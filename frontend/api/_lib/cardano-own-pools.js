// The venue's own Cardano pools (cardano/minswap-dex-v2: Minswap V2 copied with our patches,
// draft PRs #988 and #1016), where they are on chain. ONE record, read by the API's pinned reads
// (cardano-ops.js) and by the LP screens (src/lib/cardano/ownPools/deployment.ts).
//
// NULL UNTIL THE DEPLOY: no own-pool reads exist and the screens build nothing. Filled from our
// deploy's own record, never Minswap's (its hashes put our users in its pools); the screens
// refuse a record with any of Minswap's. No imports, no process.env: the browser bundles this.

/** @type {import('./cardano-own-pools').OwnPoolsDeploymentRecord | null} */
export const OWN_POOLS_DEPLOYMENT = null;
