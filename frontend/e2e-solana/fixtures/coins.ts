// The three coins a pool may pair a token with (owner ruling 2026-10-03): SOL, USDC and
// BAYLA. Written out by hand: each coin's mint, decimals and token program, the rank that
// decides which side of a pool is "the coin" (SOL before USDC before BAYLA), and how an
// amount of each is printed.
//
// Not imported from src/lib/solana/lp/quotes.ts on purpose. The specs use this table to say
// what the page SHOULD show and what the chain SHOULD hold, so a wrong row in the app's
// own table must not agree with itself here.
import type { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { formatSol, formatTokenAmount } from '../../src/lib/launcher/solana/curve/format';
import { BAYLA_MINT } from './bayla';
import { WSOL } from './chain';
import { USDC_MINT } from './usdc';

export interface Coin {
  symbol: 'SOL' | 'USDC' | 'BAYLA';
  /** The mint a pool holds for it: wrapped SOL for SOL. */
  mint: PublicKey;
  decimals: number;
  /** The token program its mint is under. */
  program: PublicKey;
  /** SOL goes in and out through a wrapped-SOL account. The other two are plain token accounts. */
  native: boolean;
}

// The mints are the addresses written out in chain.ts, usdc.ts and bayla.ts.
export const SOL_COIN: Coin = { symbol: 'SOL', mint: WSOL, decimals: 9, program: TOKEN_PROGRAM_ID, native: true };
export const USDC_COIN: Coin = { symbol: 'USDC', mint: USDC_MINT, decimals: 6, program: TOKEN_PROGRAM_ID, native: false };
export const BAYLA_COIN: Coin = { symbol: 'BAYLA', mint: BAYLA_MINT, decimals: 6, program: TOKEN_2022_PROGRAM_ID, native: false };

/** Rank order: when a pool pairs two of these, the EARLIER one is the coin and the other is the token. */
export const COINS: readonly Coin[] = [SOL_COIN, USDC_COIN, BAYLA_COIN];

/**
 * Which side of a pool is its pairing coin: the higher-ranked coin of the two mints. Null
 * when neither side is one (a pool this site does not show).
 */
export function coinOfPool(token0Mint: string, token1Mint: string): { coin: Coin; coinIs0: boolean } | null {
  const rank = (m: string) => COINS.findIndex((c) => c.mint.toBase58() === m);
  const r0 = rank(token0Mint);
  const r1 = rank(token1Mint);
  if (r0 < 0 && r1 < 0) return null;
  const coinIs0 = r1 < 0 || (r0 >= 0 && r0 < r1);
  return { coin: COINS[coinIs0 ? r0 : r1]!, coinIs0 };
}

/** An amount of a coin to its last digit, as a bound or an exact amount is printed: "0.5 SOL", "250 USDC". */
export const coinExact = (raw: bigint, c: Coin) => (c.native ? `${formatSol(raw, 9)} SOL` : `${formatTokenAmount(raw, c.decimals, c.decimals).text} ${c.symbol}`);
/** An amount of a coin as the review says "about" (TxFlowView's own rounding). */
export const coinAbout = (raw: bigint, c: Coin) => (c.native ? `${formatSol(raw)} SOL` : `${formatTokenAmount(raw, c.decimals).text} ${c.symbol}`);
