import { BAYLA_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT, WSOL_MINT } from './tokenSafety';

/**
 * The coins a pool on this site may pair a token with: SOL, USDC and BAYLA (owner ruling
 * 2026-10-03). A short list on purpose, not "any coin with any coin": the price check,
 * the pool index and the transaction checker each know these three and nothing else, so
 * a pool of two unknown tokens is still `other-pair` and is never written to.
 *
 * ONE ROW PER COIN. Adding a coin is a row here, a row in the server's copy
 * (api/_lib/pool-index.js `QUOTE_COINS`, pinned to this list by a test) and nothing else.
 *
 * WHICH SIDE IS THE QUOTE. The list is in rank order. A pool that pairs two of these
 * coins is read as the LOWER-ranked one priced in the HIGHER-ranked one:
 *   BAYLA/SOL  → BAYLA priced in SOL        USDC/SOL → USDC priced in SOL
 *   BAYLA/USDC → BAYLA priced in USDC       X/BAYLA  → X priced in BAYLA
 * So every pool has exactly one reading, whichever token a search started from, and SOL
 * is never "the token" of a pool.
 *
 * `decimals` and `program` are what the chain says today, and a test pins them to each
 * mint's own bytes. The write layer never trusts them: it reads the quote's mint again
 * on every Review and refuses when either differs.
 */

export type QuoteSymbol = 'SOL' | 'USDC' | 'BAYLA';

export interface QuoteCoin {
  /** The mint a pool holds for it: wrapped SOL for SOL. */
  mint: string;
  symbol: QuoteSymbol;
  decimals: number;
  /**
   * SOL goes in and out through the wallet's wrapped-SOL account, opened and closed
   * around the transaction (write/wsol.ts). Every other coin is a plain token account.
   */
  native: boolean;
  /** The token program its mint is under. */
  program: string;
  /**
   * What pairing with THIS coin adds to the risks, in one plain sentence, or null when it
   * adds none. Said wherever the coin is chosen and again on the review, in these words.
   * A new coin must say what its issuer can do to a pool's account before it is listed.
   */
  risk: string | null;
}

/**
 * USDC's mint keeps a freeze authority (Circle's). A frozen pool account stops every
 * withdrawal from that pool (the pool program moves the coin out of it), so it is said
 * before anyone puts USDC in. BAYLA's mint has no freeze authority and no mint authority.
 */
const USDC_RISK =
  'USDC’s issuer (Circle) can freeze any USDC account, including a pool’s own. While a pool’s USDC account is frozen, nobody can take liquidity out of that pool, you included.';

export const SOL_QUOTE: QuoteCoin = { mint: WSOL_MINT, symbol: 'SOL', decimals: 9, native: true, program: TOKEN_PROGRAM, risk: null };
export const USDC_QUOTE: QuoteCoin = { mint: USDC_MINT, symbol: 'USDC', decimals: 6, native: false, program: TOKEN_PROGRAM, risk: USDC_RISK };
export const BAYLA_QUOTE: QuoteCoin = { mint: BAYLA_MINT, symbol: 'BAYLA', decimals: 6, native: false, program: TOKEN_2022_PROGRAM, risk: null };

/** Rank order: when a pool pairs two of these, the EARLIER one is the quote. */
export const QUOTE_COINS: readonly QuoteCoin[] = [SOL_QUOTE, USDC_QUOTE, BAYLA_QUOTE];

/** The pairing coins in words, for copy: "SOL, USDC or BAYLA". */
export const QUOTE_COINS_OR = `${QUOTE_COINS.slice(0, -1).map((q) => q.symbol).join(', ')} or ${QUOTE_COINS[QUOTE_COINS.length - 1]!.symbol}`;

const rankOf = (mint: string): number => QUOTE_COINS.findIndex((q) => q.mint === mint);

/** The pairing coin with this mint, or null. */
export function quoteCoin(mint: string): QuoteCoin | null {
  return QUOTE_COINS[rankOf(mint)] ?? null;
}

/**
 * How a pool of these two mints is read: its quote coin, which side that is, and the
 * token priced in it. Null when neither side is a pairing coin (`other-pair`), and when
 * both sides are the same mint.
 */
export function readPair(token0Mint: string, token1Mint: string): { quote: QuoteCoin; quoteIsToken0: boolean; tokenMint: string } | null {
  if (token0Mint === token1Mint) return null;
  const r0 = rankOf(token0Mint);
  const r1 = rankOf(token1Mint);
  if (r0 < 0 && r1 < 0) return null;
  // The higher rank (the smaller index) is the quote; a side that is no pairing coin never is.
  const quoteIsToken0 = r1 < 0 || (r0 >= 0 && r0 < r1);
  const quote = QUOTE_COINS[quoteIsToken0 ? r0 : r1]!;
  return { quote, quoteIsToken0, tokenMint: quoteIsToken0 ? token1Mint : token0Mint };
}

/**
 * The coins `tokenMint` can be paired with, in rank order: every pairing coin, or, for a
 * token that is itself one, only the coins that outrank it. SOL has none: it is never
 * the token of a pool.
 */
export function quotesFor(tokenMint: string): QuoteCoin[] {
  const r = rankOf(tokenMint);
  return r < 0 ? [...QUOTE_COINS] : QUOTE_COINS.slice(0, r);
}

/** Is a `tokenMint`/`quote` pool one this site reads that way round? */
export function canPair(tokenMint: string, quote: QuoteCoin): boolean {
  return quotesFor(tokenMint).some((q) => q.mint === quote.mint);
}
