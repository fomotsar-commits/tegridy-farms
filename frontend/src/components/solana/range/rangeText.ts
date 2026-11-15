import { formatSol, formatTokenAmount } from '../../../lib/launcher/solana/curve';
import { formatSolPrice } from '../../../lib/solana/lp/format';
import { quoteCoin } from '../../../lib/solana/lp/quotes';
import { registryToken } from '../../../lib/solana/lp/identity';
import { priceNumber, type Pair, type Price } from '../../../lib/solana/clmm/rangeMath';

/**
 * A pair with the token's name as the pool screens give it (identity.ts tokenTicker: ours
 * by mint, else the coin's own ticker, "fake SOY" for a copy), once its check was read.
 */
export type NamedPair = Pair & { tokenLabel?: string | null };

export const withTokenLabel = (p: Pair, tokenLabel: string | null): NamedPair => ({ ...p, tokenLabel });

const labelOf = (p: NamedPair): string | null => p.tokenLabel ?? quoteCoin(p.tokenMint)?.symbol ?? null;

/** The token's name (BAYLA, or the ticker it gives itself), else "tokens". */
export const tokenWord = (p: NamedPair): string => labelOf(p) ?? 'tokens';

/** "BAYLA" or "The token", to open a sentence or a button. */
export const tokenName = (p: NamedPair): string => labelOf(p) ?? 'The token';

export function tokenAmount(p: NamedPair, v: bigint): string {
  return `${formatTokenAmount(v, p.tokenDecimals, 6).text} ${tokenWord(p)}`;
}

export function coinAmount(p: Pair, v: bigint): string {
  return p.quote.native ? `${formatSol(v, 9)} SOL` : `${formatTokenAmount(v, p.quoteDecimals, 6).text} ${p.quote.symbol}`;
}

/** A price as "0.0003 SOL per BAYLA". */
export function priceText(p: NamedPair, price: Price): string {
  return priceNumberText(p, priceNumber(price));
}

/** A price already a number (the market's, from Jupiter), said the same way. */
export function priceNumberText(p: NamedPair, price: number): string {
  return `${formatSolPrice(price)} ${p.quote.symbol} per ${labelOf(p) ?? 'token'}`;
}

/** Token 0 and token 1 amounts as this pair reads them: the token first, then the coin. */
export function bothAmounts(p: NamedPair, amount0: bigint, amount1: bigint): string {
  const [token, coin] = p.tokenIsToken0 ? [amount0, amount1] : [amount1, amount0];
  return `${tokenAmount(p, token)} and ${coinAmount(p, coin)}`;
}

/** One of the site's own coins (a pairing coin or a listed room's), by its ticker alone; null for any other. */
export function siteCoin(mint: string): string | null {
  return quoteCoin(mint)?.symbol ?? registryToken(mint)?.symbol ?? null;
}

/**
 * A reward coin as the site names it: its ticker from the site's own list, else the ticker its
 * own check read (`ticker`, "fake X" for a copy) or "Unknown token", with its whole address.
 */
export function rewardCoin(mint: string, ticker?: string | null): string {
  return siteCoin(mint) ?? `${ticker ?? 'Unknown token'} · ${mint}`;
}

/** "48.2 BAYLA". With its mint unread, the amount in the coin's smallest units, said so. */
export function rewardAmount(amount: bigint, decimals: number | null, mint: string, ticker?: string | null): string {
  if (decimals === null) return `${amount} smallest units of ${rewardCoin(mint, ticker)}`;
  return `${formatTokenAmount(amount, decimals, 6).text} ${rewardCoin(mint, ticker)}`;
}

/** A chain time (unix seconds) as "14:02:11 UTC". */
export function utcClock(unix: bigint): string {
  return `${new Date(Number(unix) * 1000).toISOString().slice(11, 19)} UTC`;
}

/** A pause the team's vault set on a pool, as a position row says it (pool.rs `PoolStatusBitIndex`). */
export const PAUSED_TEXT = {
  removal:
    'Taking liquidity out of this pool is switched off by the venue’s vault right now, so Collect pays only what the position’s record held at its last change. What it earned since stays owed to it.',
  fees: 'Collecting fees from this pool is switched off by the venue’s vault right now. Its fees stay owed to it.',
  rewards: 'Collecting rewards from this pool is switched off by the venue’s vault right now. Its rewards stay owed to it.',
} as const;
