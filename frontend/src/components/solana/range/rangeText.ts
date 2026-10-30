import { formatSol, formatTokenAmount } from '../../../lib/launcher/solana/curve';
import { formatSolPrice } from '../../../lib/solana/lp/format';
import { quoteCoin } from '../../../lib/solana/lp/quotes';
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
