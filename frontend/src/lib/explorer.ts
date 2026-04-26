/**
 * Chain-aware block explorer URL helpers.
 *
 * Audit C-04: receipts/links were hardcoded to mainnet Etherscan, which breaks
 * on testnets and L2s. Always derive the explorer URL from the chain the tx was
 * submitted on — fall back to mainnet Etherscan if the chain is unknown so links
 * still resolve somewhere rather than 404.
 *
 * R040 follow-up: also exposes `getChainLabel` for UI badges that previously
 * hardcoded "Mainnet". The label table is a superset of the explorer table —
 * explorer fallback always lands on mainnet, but a UI label like "Chain 999999"
 * is more honest than calling it "Mainnet".
 */

const EXPLORERS: Record<number, string> = {
  1: 'https://etherscan.io',
  5: 'https://goerli.etherscan.io',
  11155111: 'https://sepolia.etherscan.io',
  17000: 'https://holesky.etherscan.io',
  10: 'https://optimistic.etherscan.io',
  11155420: 'https://sepolia-optimism.etherscan.io',
  8453: 'https://basescan.org',
  84532: 'https://sepolia.basescan.org',
  42161: 'https://arbiscan.io',
  421614: 'https://sepolia.arbiscan.io',
  137: 'https://polygonscan.com',
  80002: 'https://amoy.polygonscan.com',
  324: 'https://era.zksync.network',
  59144: 'https://lineascan.build',
  534352: 'https://scrollscan.com',
  5000: 'https://mantlescan.xyz',
  81457: 'https://blastscan.io',
  56: 'https://bscscan.com',
  43114: 'https://snowtrace.io',
};

const CHAIN_LABELS: Record<number, string> = {
  1: 'Mainnet',
  5: 'Goerli',
  11155111: 'Sepolia',
  17000: 'Holesky',
  10: 'Optimism',
  11155420: 'OP Sepolia',
  8453: 'Base',
  84532: 'Base Sepolia',
  42161: 'Arbitrum',
  421614: 'Arbitrum Sepolia',
  137: 'Polygon',
  80002: 'Polygon Amoy',
  324: 'zkSync Era',
  59144: 'Linea',
  534352: 'Scroll',
  5000: 'Mantle',
  81457: 'Blast',
  56: 'BNB Chain',
  43114: 'Avalanche',
};

const FALLBACK = 'https://etherscan.io';

/** Returns the block explorer base URL for the given chain, or mainnet Etherscan as a fallback. */
export function getExplorerBase(chainId?: number): string {
  if (!chainId) return FALLBACK;
  return EXPLORERS[chainId] ?? FALLBACK;
}

/**
 * Human-readable chain name for UI badges (transaction receipts, status pills).
 * Distinguishes "no chain set" (Unknown Network) from "chain we don't know"
 * (Chain 12345) so receipts don't lie about being on mainnet.
 */
export function getChainLabel(chainId?: number): string {
  if (!chainId) return 'Unknown Network';
  return CHAIN_LABELS[chainId] ?? `Chain ${chainId}`;
}

export function getTxUrl(chainId: number | undefined, hash: string): string {
  return `${getExplorerBase(chainId)}/tx/${hash}`;
}

export function getAddressUrl(chainId: number | undefined, address: string): string {
  return `${getExplorerBase(chainId)}/address/${address}`;
}

export function getBlockUrl(chainId: number | undefined, block: number | bigint): string {
  return `${getExplorerBase(chainId)}/block/${block.toString()}`;
}

export function getTokenUrl(chainId: number | undefined, tokenAddress: string): string {
  return `${getExplorerBase(chainId)}/token/${tokenAddress}`;
}
