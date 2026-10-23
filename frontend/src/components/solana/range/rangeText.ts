import { formatSol, formatTokenAmount } from '../../../lib/launcher/solana/curve';
import { formatSolPrice } from '../../../lib/solana/lp/format';
import { quoteCoin } from '../../../lib/solana/lp/quotes';
import { priceNumber, type Pair, type Price } from '../../../lib/solana/clmm/rangeMath';

/** The token's name where this site knows it (BAYLA, USDC), else "tokens". */
export const tokenWord = (p: Pair): string => quoteCoin(p.tokenMint)?.symbol ?? 'tokens';

/** "BAYLA" or "The token", to open a sentence or a button. */
export const tokenName = (p: Pair): string => quoteCoin(p.tokenMint)?.symbol ?? 'The token';

export function tokenAmount(p: Pair, v: bigint): string {
  return `${formatTokenAmount(v, p.tokenDecimals, 6).text} ${tokenWord(p)}`;
}

export function coinAmount(p: Pair, v: bigint): string {
  return p.quote.native ? `${formatSol(v, 9)} SOL` : `${formatTokenAmount(v, p.quoteDecimals, 6).text} ${p.quote.symbol}`;
}

/** A price as "0.0003 SOL per BAYLA". */
export function priceText(p: Pair, price: Price): string {
  return priceNumberText(p, priceNumber(price));
}

/** A price already a number (the market's, from Jupiter), said the same way. */
export function priceNumberText(p: Pair, price: number): string {
  return `${formatSolPrice(price)} ${p.quote.symbol} per ${quoteCoin(p.tokenMint)?.symbol ?? 'token'}`;
}

/** Token 0 and token 1 amounts as this pair reads them: the token first, then the coin. */
export function bothAmounts(p: Pair, amount0: bigint, amount1: bigint): string {
  const [token, coin] = p.tokenIsToken0 ? [amount0, amount1] : [amount1, amount0];
  return `${tokenAmount(p, token)} and ${coinAmount(p, coin)}`;
}
