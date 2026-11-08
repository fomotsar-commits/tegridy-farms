// Curated token list for swap – popular Ethereum mainnet ERC20s + TOWELI
// Users can also import any token by contract address

import { getAddress } from 'viem';
import { TOWELI_ADDRESS, WETH_ADDRESS, CHAIN_ID } from './constants';
import { EVM_BASKET } from './islandBasket';

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI: string;
  isNative?: boolean; // true for ETH
}

// ETH pseudo-address used by convention
export const NATIVE_ETH_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export const DEFAULT_TOKENS: TokenInfo[] = [
  {
    address: NATIVE_ETH_ADDRESS,
    symbol: 'ETH',
    name: 'Ether',
    decimals: 18,
    logoURI: '/tokens/eth.png',
    isNative: true,
  },
  {
    address: WETH_ADDRESS,
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    logoURI: '/tokens/weth.png',
  },
  {
    address: TOWELI_ADDRESS,
    symbol: 'TOWELI',
    name: 'Towelie',
    decimals: 18,
    logoURI: '/art/bobowelie.jpg',
  },
  {
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    logoURI: '/tokens/usdc.png',
  },
  {
    address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    logoURI: '/tokens/usdt.png',
  },
  {
    address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    decimals: 18,
    logoURI: '/tokens/dai.png',
  },
  {
    address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    symbol: 'WBTC',
    name: 'Wrapped BTC',
    decimals: 8,
    logoURI: '/tokens/wbtc.png',
  },
  {
    address: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
    symbol: 'LINK',
    name: 'Chainlink',
    decimals: 18,
    logoURI: '/tokens/link.png',
  },
  {
    address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
    symbol: 'UNI',
    name: 'Uniswap',
    decimals: 18,
    logoURI: '/tokens/uni.jpg',
  },
  {
    address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
    symbol: 'AAVE',
    name: 'Aave',
    decimals: 18,
    logoURI: '/tokens/aave.png',
  },
  {
    address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE',
    symbol: 'SHIB',
    name: 'Shiba Inu',
    decimals: 18,
    logoURI: '/tokens/shib.png',
  },
  {
    address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
    symbol: 'PEPE',
    name: 'Pepe',
    decimals: 18,
    logoURI: '/tokens/pepe.jpg',
  },
  {
    address: '0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0',
    symbol: 'MATIC',
    name: 'Polygon',
    decimals: 18,
    logoURI: '/tokens/matic.png',
  },
  {
    address: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84',
    symbol: 'stETH',
    name: 'Lido Staked ETH',
    decimals: 18,
    logoURI: '/tokens/steth.png',
  },
];

const ETH_TOKEN: TokenInfo = DEFAULT_TOKENS[0]!;

/**
 * The swap's starting list on each chain it serves. Ethereum keeps DEFAULT_TOKENS.
 * Base and Robinhood list only what was read on chain: native ETH, the chain's WETH,
 * and one dollar coin. On Base, Circle's USDC (Circle's mainnet table; symbol USDC, 6
 * decimals; read 2026-10-17). Circle lists no USDC on Robinhood Chain; there, Paxos's
 * Global Dollar (USDG), copied from the Uniswap Labs Default token list v22.27.0 and
 * read on chain 2026-10-18 (name "Global Dollar", symbol USDG, 6 decimals; its Uniswap
 * V2 pool with WETH held 88.5 WETH and 209,262 USDG). Any other token is added by
 * pasting its address, as on Ethereum, and stays a custom (exact-amount approval) token.
 */
const SWAP_TOKENS_BY_CHAIN: Readonly<Record<number, readonly TokenInfo[]>> = Object.freeze({
  8453: [
    ETH_TOKEN,
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, logoURI: '/tokens/weth.png' },
    { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoURI: '/tokens/usdc.png' },
  ],
  4663: [
    ETH_TOKEN,
    { address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, logoURI: '/tokens/weth.png' },
    { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', name: 'Global Dollar', decimals: 6, logoURI: '' },
  ],
});

/**
 * The Swap form's list: the chain's default tokens, plus on Base the island's own coins
 * (lib/islandBasket.ts, each read on chain with its pool), so BNKR is not "unverified" on
 * its own island and a copy of its ticker at another address is refused. Only the swap:
 * the pool forms keep defaultTokensFor.
 */
const BASE_SWAP_TOKENS: readonly TokenInfo[] = Object.freeze([
  ...SWAP_TOKENS_BY_CHAIN[8453]!,
  ...EVM_BASKET.base.map((c) => ({ address: c.token, symbol: c.symbol, name: c.symbol, decimals: c.decimals, logoURI: '' })),
]);
export function swapTokensFor(chainId: number): readonly TokenInfo[] {
  return chainId === 8453 ? BASE_SWAP_TOKENS : defaultTokensFor(chainId);
}

/** The swap's default tokens on `chainId`: Ethereum's list on Ethereum, none on a chain with no list. */
export function defaultTokensFor(chainId: number): readonly TokenInfo[] {
  return SWAP_TOKENS_BY_CHAIN[chainId] ?? (chainId === CHAIN_ID ? DEFAULT_TOKENS : []);
}

/**
 * The token the Swap and Pools forms open on beside ETH: TOWELI on Ethereum, else the
 * chain's first listed token that is not ETH or WETH (USDC on Base, USDG on Robinhood
 * Chain). Null on a chain with nothing else listed. One rule for both forms, so neither
 * opens on a token the other cannot read.
 */
export function headlineTokenFor(chainId: number): TokenInfo | null {
  const list = defaultTokensFor(chainId);
  if (chainId === CHAIN_ID) return list.find(t => t.symbol === 'TOWELI') ?? null;
  return list.find(t => !t.isNative && t.symbol !== 'WETH') ?? null;
}

// Helper to find a token by address (case-insensitive)
export function findToken(address: string, customTokens: TokenInfo[] = []): TokenInfo | undefined {
  const all = [...DEFAULT_TOKENS, ...customTokens];
  return all.find(t => t.address.toLowerCase() === address.toLowerCase());
}

// Check if address looks like a valid Ethereum address
export function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

// Validate and return EIP-55 checksummed address, or null if invalid.
// Uses viem's getAddress for EIP-55 checksum validation.
export function validateAddress(address: string): `0x${string}` | null {
  try {
    return getAddress(address as `0x${string}`);
  } catch {
    return null;
  }
}
