import type { QuoteCoin, QuoteSymbol } from './quotes';

/**
 * Dollar figures for the LP pages: a convenience for the eye, never a number a
 * transaction carries. Every figure is "about": a pairing coin is valued at Jupiter's
 * price for THAT coin as last read (USDC at its read price, never taken as $1), and a
 * token at the pool's OWN price into its coin, the only price a pool share can be taken
 * out at. A price that could not be read gives no figure at all (null), never "$0": a
 * visitor reads $0 as a value. Dollars never rank a pool and never cross coins.
 */

/**
 * Whether any dollar line is shown. Off until the owner rules on DESIGN open question
 * 7.36 (may "about $" lines be shown). Flipped in its own one-line commit on the owner's
 * word, like LP_WRITES (lpWriteFlag.ts); no env variable raises it. Off, every consumer
 * prints nothing and useUsdPrices.ts makes no Jupiter call.
 */
export const USD_LINES = 'off' as 'off' | 'on';

/** Jupiter's dollar price of each pairing coin as last read; null for a coin whose price was not read. */
export type UsdPerCoin = Readonly<Record<QuoteSymbol, number | null>>;

/** No coin priced: what every consumer holds until a read lands, and always while USD_LINES is off. */
export const NO_USD_PRICES: UsdPerCoin = Object.freeze({ SOL: null, USDC: null, BAYLA: null });

/** "about $1,234" / "about $12.34" / "under $0.01"; null for anything that is not a read number. */
export function usdText(usd: number | null): string | null {
  if (usd === null || !Number.isFinite(usd) || usd < 0) return null;
  if (usd > 0 && usd < 0.01) return 'under $0.01';
  const digits = usd >= 1000 ? 0 : 2;
  return `about $${usd.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** The coin's read price, or null when it was not read or is not a price (0, negative, NaN). */
function readPrice(quote: QuoteCoin, usdPerCoin: UsdPerCoin): number | null {
  const p = usdPerCoin[quote.symbol];
  return p !== null && Number.isFinite(p) && p > 0 ? p : null;
}

/** The dollar value of `raw` base units of a pairing coin, at that coin's own read price; null without one. */
export function usdOfCoin(raw: bigint, quote: QuoteCoin, usdPerCoin: UsdPerCoin): number | null {
  const price = readPrice(quote, usdPerCoin);
  if (price === null) return null;
  return (Number(raw) / 10 ** quote.decimals) * price;
}

/**
 * Some coin plus some tokens, the tokens valued at `pricePerToken` (the pool's own price,
 * in the coin) and then the coin at its read dollar price. Null when the token's decimals,
 * the pool's price or the coin's price is not known.
 */
export function usdOfPair(coinRaw: bigint, tokenRaw: bigint, tokenDecimals: number | null, pricePerToken: number | null, quote: QuoteCoin, usdPerCoin: UsdPerCoin): number | null {
  const coinValue = usdOfCoin(coinRaw, quote, usdPerCoin);
  if (coinValue === null || tokenDecimals === null || pricePerToken === null || !Number.isFinite(pricePerToken) || pricePerToken < 0) return null;
  const tokenInCoin = (Number(tokenRaw) / 10 ** tokenDecimals) * pricePerToken;
  return coinValue + tokenInCoin * (readPrice(quote, usdPerCoin) as number);
}

/**
 * A pool's liquidity: twice its coin side, at that coin's own read price. A constant-product
 * pool holds equal value on each side at its own price, so this is what it holds at that
 * price, not at any other.
 */
export function usdOfPool(quoteReserve: bigint, quote: QuoteCoin, usdPerCoin: UsdPerCoin): number | null {
  const side = usdOfCoin(quoteReserve, quote, usdPerCoin);
  return side === null ? null : side * 2;
}

/**
 * The line a card prints: the figure, the coin whose Jupiter price it used and how old
 * that read is. `readAt` is the read's time in ms (useUsdPrices.ts). Null without a
 * figure or without a read time: a dollar figure never appears unsourced.
 */
export function usdLine(usd: number | null, source: { quote: QuoteSymbol; readAt: number | null }, now: number = Date.now()): string | null {
  const text = usdText(usd);
  if (text === null || source.readAt === null) return null;
  const s = Math.max(0, Math.floor((now - source.readAt) / 1000));
  return `${text}, at Jupiter’s ${source.quote} price read ${s} s ago`;
}
