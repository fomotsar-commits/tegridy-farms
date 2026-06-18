// Curated SPL token allowlist for the Solana swap surface (Surface A).
//
// SAFETY: this is a HAND-CURATED allowlist on purpose. The buy surface must NOT
// auto-list arbitrary mints — Solana has rampant honeypot / freeze-authority /
// Token-2022-transfer-hook scams. Every mint below is a verified canonical
// mainnet mint. OPERATOR: add your own hosted tokens (e.g. Jungle Bay) under
// BUY_TOKENS with a VERIFIED mint + decimals before relying on them in prod.

export interface SolToken {
  /** Base58 SPL mint address. */
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
}

// Native SOL (wrapped-SOL mint). Jupiter handles wrap/unwrap automatically.
export const SOL: SolToken = {
  mint: 'So11111111111111111111111111111111111111112',
  symbol: 'SOL',
  name: 'Solana',
  decimals: 9,
};

export const USDC: SolToken = {
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
};

export const USDT: SolToken = {
  mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  symbol: 'USDT',
  name: 'Tether USD',
  decimals: 6,
};

// Tokens the user PAYS WITH (input side). The platform fee is taken from the
// INPUT mint, so we only ever need a fee ATA for each of these — keep this set
// small (and pre-create those ATAs for the fee wallet, per the plan).
export const PAY_WITH_TOKENS: SolToken[] = [SOL, USDC];

// Tokens the user can BUY (output side). Canonical mints only.
// OPERATOR: add Jungle Bay + your hosted tokens here, e.g.
//   { mint: '<JUNGLE_BAY_MINT>', symbol: 'JBAY', name: 'Jungle Bay', decimals: <d> },
export const BUY_TOKENS: SolToken[] = [
  SOL,
  USDC,
  USDT,
  {
    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    symbol: 'JUP',
    name: 'Jupiter',
    decimals: 6,
  },
  {
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    symbol: 'BONK',
    name: 'Bonk',
    decimals: 5,
  },
];

export function findSolToken(mint: string): SolToken | undefined {
  return [...PAY_WITH_TOKENS, ...BUY_TOKENS].find((t) => t.mint === mint);
}
