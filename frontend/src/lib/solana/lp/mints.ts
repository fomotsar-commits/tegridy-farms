/**
 * The token programs and the pairing coins' mints (quotes.ts), in a module that imports
 * nothing. tokenSafety.ts re-exports every one, so each is still read from there.
 *
 * WHY A MODULE OF THEIR OWN. quotes.ts builds its rows from these at load, and
 * tokenSafety.ts names the pairing coins in its copy from quotes.ts (`QUOTE_COINS_OR`).
 * Kept in tokenSafety.ts, that is an import cycle: a page that loaded tokenSafety.ts
 * first built every quote row with an undefined mint.
 */

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** BAYLA, the token of this site's Solana side (the same mint as bungalows.ts BAYLA_MINT, pinned by a test). */
export const BAYLA_MINT = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
/**
 * The island's other four Solana coins (bungalows.ts, each pinned to its entry by a test).
 * pump.fun mints under the classic token program; with BAYLA they are the coins a pool
 * here may pair a token with (quotes.ts).
 */
export const BOBO_MINT = '4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump';
export const SOY_MINT = '8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump';
export const BRAINLET_MINT = '4XKGjKaKowFvL5sYwh2AKx72vj9iwC8MNvpL44E9pump';
export const RIZZ_MINT = '5ad4puH6yDBoeCcrQfwV5s9bxvPnAeWDoYDj3uLyBS8k';
