/**
 * Chain-aware block explorer URL helpers.
 *
 * Audit C-04: receipts/links were hardcoded to mainnet Etherscan, which breaks
 * on testnets and L2s. Always derive the explorer URL from the chain the tx was
 * submitted on — fall back to mainnet Etherscan if the chain is unknown so links
 * still resolve somewhere rather than 404.
 */

const EXPLORERS: Record<number, string> = {
  1: 'https://etherscan.io',
  5: 'https://goerli.etherscan.io',
  11155111: 'https://sepolia.etherscan.io',
  17000: 'https://holesky.etherscan.io',
  10: 'https://optimistic.etherscan.io',
  8453: 'https://basescan.org',
  84532: 'https://sepolia.basescan.org',
  42161: 'https://arbiscan.io',
  421614: 'https://sepolia.arbiscan.io',
  137: 'https://polygonscan.com',
  56: 'https://bscscan.com',
  43114: 'https://snowtrace.io',
};

const FALLBACK = 'https://etherscan.io';

/** Returns the block explorer base URL for the given chain, or mainnet Etherscan as a fallback. */
export function getExplorerBase(chainId?: number): string {
  if (!chainId) return FALLBACK;
  return EXPLORERS[chainId] ?? FALLBACK;
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
