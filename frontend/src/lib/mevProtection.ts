// MEV-protection RPC helpers.
//
// Battle-tested source: MEV Blocker (built by CoW DAO + Beaver Build + Agnostic
// Relay). Routing a wallet's Ethereum-mainnet RPC through a protected endpoint
// removes the public-mempool sandwich/frontrun surface and, on the `/fast`
// endpoint, returns 90% of any backrun MEV to the user via an order-flow auction.
//
// This module only BUILDS the request and CLASSIFIES the result. The wallet
// prompt itself is user-confirmed via EIP-3085 `wallet_addEthereumChain` — we
// never silently swap a user's RPC (the EIP explicitly warns that rpcUrls
// "cannot be assumed to be honest", so the user must approve).
//
// Refs: https://docs.mevblocker.io/  ·  https://eips.ethereum.org/EIPS/eip-3085

export const MEV_BLOCKER_FAST_RPC = 'https://rpc.mevblocker.io/fast' as const;
export const MEV_BLOCKER_INFO_URL = 'https://mevblocker.io' as const;
export const MAINNET_CHAIN_ID_HEX = '0x1' as const;

/** EIP-3085 `wallet_addEthereumChain` parameter shape. */
export interface AddEthereumChainParameter {
  chainId: string;
  chainName: string;
  rpcUrls: string[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
  blockExplorerUrls: string[];
}

/**
 * Build the `wallet_addEthereumChain` params that point Ethereum mainnet at the
 * MEV Blocker protected RPC. Returns a fresh object each call (no shared mutable
 * state). The canonical endpoint is pinned here — never proxy or rewrite it.
 */
export function buildMevBlockerChainParams(): AddEthereumChainParameter {
  return {
    chainId: MAINNET_CHAIN_ID_HEX,
    chainName: 'Ethereum (MEV Blocker)',
    rpcUrls: [MEV_BLOCKER_FAST_RPC],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorerUrls: ['https://etherscan.io'],
  };
}

/**
 * EIP-1193 user-rejection is code 4001 (some wallets surface the string
 * 'ACTION_REJECTED'). Distinguish a deliberate cancel from a wallet that
 * refuses/doesn't support the request, so the UI can stay quiet on a cancel
 * but fall back to manual instructions on a genuine refusal. Walks `.cause`
 * because viem/ethers wrap provider errors.
 */
export function isUserRejection(err: unknown): boolean {
  const code = extractErrorCode(err);
  return code === 4001 || code === 'ACTION_REJECTED';
}

function extractErrorCode(err: unknown, depth = 0): unknown {
  if (depth > 5 || typeof err !== 'object' || err === null) return undefined;
  const e = err as { code?: unknown; cause?: unknown };
  if (e.code !== undefined) return e.code;
  if (e.cause !== undefined) return extractErrorCode(e.cause, depth + 1);
  return undefined;
}
