// Curated token list for swap – popular Ethereum mainnet ERC20s + TOWELI
// Users can also import any token by contract address

import { getAddress } from 'viem';
import { TOWELI_ADDRESS, WETH_ADDRESS } from './constants';

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
    logoURI: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
    isNative: true,
  },
  {
    address: WETH_ADDRESS,
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    logoURI: 'https://assets.coingecko.com/coins/images/2518/small/weth.png',
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
    logoURI: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png',
  },
  {
    address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    logoURI: 'https://assets.coingecko.com/coins/images/325/small/Tether.png',
  },
  {
    address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    decimals: 18,
    logoURI: 'https://assets.coingecko.com/coins/images/9956/small/Badge_Dai.png',
  },
  {
    address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    symbol: 'WBTC',
    name: 'Wrapped BTC',
    decimals: 8,
    logoURI: 'https://assets.coingecko.com/coins/images/7598/small/wrapped_bitcoin_wbtc.png',
  },
  {
    address: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
    symbol: 'LINK',
    name: 'Chainlink',
    decimals: 18,
    logoURI: 'https://assets.coingecko.com/coins/images/877/small/chainlink-new-logo.png',
  },
  {
    address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
    symbol: 'UNI',
    name: 'Uniswap',
    decimals: 18,
    logoURI: 'https://assets.coingecko.com/coins/images/12504/small/uni.jpg',
  },
  {
    address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
    symbol: 'AAVE',
    name: 'Aave',
    decimals: 18,
    logoURI: 'https://assets.coingecko.com/coins/images/12645/small/aave-token-round.png',
  },
  {
    address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE',
    symbol: 'SHIB',
    name: 'Shiba Inu',
    decimals: 18,
    logoURI: 'https://assets.coingecko.com/coins/images/11939/small/shiba.png',
  },
  {
    address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
    symbol: 'PEPE',
    name: 'Pepe',
    decimals: 18,
    logoURI: 'https://assets.coingecko.com/coins/images/29850/small/pepe-token.jpeg',
  },
  {
    address: '0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0',
    symbol: 'MATIC',
    name: 'Polygon',
    decimals: 18,
    logoURI: 'https://assets.coingecko.com/coins/images/4713/small/polygon.png',
  },
  {
    address: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84',
    symbol: 'stETH',
    name: 'Lido Staked ETH',
    decimals: 18,
    logoURI: 'https://assets.coingecko.com/coins/images/13442/small/steth_logo.png',
  },
];

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
