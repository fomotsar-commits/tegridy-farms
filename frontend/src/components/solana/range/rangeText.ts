import { formatSol, formatTokenAmount } from '../../../lib/launcher/solana/curve';
import { formatSolPrice } from '../../../lib/solana/lp/format';
import { quoteCoin } from '../../../lib/solana/lp/quotes';
import { registryToken } from '../../../lib/solana/lp/identity';
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

/** A reward coin as the site names it: its ticker from the site's own list, else "Unknown token · <whole address>". */
export function rewardCoin(mint: string): string {
  return quoteCoin(mint)?.symbol ?? registryToken(mint)?.symbol ?? `Unknown token · ${mint}`;
}

/** "48.2 BAYLA". With its mint unread, the amount in the coin's smallest units, said so. */
export function rewardAmount(amount: bigint, decimals: number | null, mint: string): string {
  if (decimals === null) return `${amount} smallest units of ${rewardCoin(mint)}`;
  return `${formatTokenAmount(amount, decimals, 6).text} ${rewardCoin(mint)}`;
}

/** A chain time (unix seconds) as "14:02:11 UTC". */
export function utcClock(unix: bigint): string {
  return `${new Date(Number(unix) * 1000).toISOString().slice(11, 19)} UTC`;
}
