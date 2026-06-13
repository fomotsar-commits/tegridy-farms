// Shared read-only JSON-RPC provider for the standalone nakamigos sub-app.
//
// These components use ethers directly (not wagmi), so they can't share the
// viem FallbackProvider in src/lib/wagmi.ts. This mirrors that config with an
// ethers FallbackProvider over the same healthy-RPC endpoint list, so a single
// dead endpoint no longer breaks ENS resolution / read-only on-chain calls.
// (llamarpc returned 503/521 — origin down — in prod on 2026-06-11, which took
// these surfaces down entirely since it was their only provider.)

// Same list and ordering as src/lib/wagmi.ts transports. Roster re-verified
// live 2026-06-13 (curl eth_chainId + Origin): publicnode, drpc, cloudflare-eth
// all return 0x1 with `access-control-allow-origin: *`. Dropped ankr (keyless
// now -32000 Unauthorized) and eth.merkle.io (Cloudflare 1015 / no ACAO).
// eth.llamarpc.com excluded (F511/F517): no ACAO header → browser CORS fail.
const RPC_ENDPOINTS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  "https://cloudflare-eth.com",
];

let cached = null;

/**
 * Returns a shared ethers FallbackProvider (mainnet) with RPC failover.
 *
 * quorum:1 makes this pure failover — the first healthy response wins rather
 * than requiring multiple nodes to agree — and priority follows list order, so
 * a stalled/erroring endpoint falls through to the next. Lazily imports ethers
 * to match the dynamic-import pattern these components already use, and caches
 * the instance across callers.
 */
export async function getReadProvider() {
  if (cached) return cached;
  const { ethers } = await import("ethers");
  const configs = RPC_ENDPOINTS.map((url, i) => ({
    provider: new ethers.JsonRpcProvider(url, "mainnet", { staticNetwork: true }),
    priority: i + 1, // lower = tried first; matches endpoint order above
    stallTimeout: 2000, // ms before falling through to the next endpoint
    weight: 1,
  }));
  cached = new ethers.FallbackProvider(configs, "mainnet", { quorum: 1 });
  return cached;
}
