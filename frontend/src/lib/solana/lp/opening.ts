import { PRICE_TOLERANCE, comparePrice, tokenReasons, type PriceCheck } from './poolHealth';
import { priceInQuote, type OutsidePrice } from './outsidePrice';
import { QUOTE_COINS_OR, SOL_QUOTE, canPair, type QuoteCoin } from './quotes';
import type { TokenSafety } from './tokenSafety';

/**
 * May a new pool open at this price? Pure: every input was read elsewhere.
 *
 * An opening sets the pool's first price. One far from the market is handed to the first
 * arbitrage trade out of the opener's deposit, and a pool that opens mispriced then
 * refuses every later depositor (they get the same deposit check, poolHealth.ts). So an
 * opening must start within the deposit check's own 3% of a fresh Jupiter price, and a
 * pool opened that way passes that check at once.
 *
 * THE PRICE IS IN THE POOL'S OWN PAIRING COIN (quotes.ts): SOL per token for a SOL pool,
 * USDC per token for a USDC pool, BAYLA per token for a BAYLA pool. The market price in
 * a coin that is not SOL is the token's SOL price over that coin's own SOL price
 * (`priceInQuote`), so an opening in USDC or BAYLA also needs the coin's price read.
 *
 * REFUSED: the token is absent, blocked, or copies a well-known name (the same
 * `tokenReasons` deposits use); it is SOL under the newer token program; the token
 * cannot be paired with that coin (a coin is only priced in the coins that outrank it);
 * the price is more than 3% from Jupiter's; Jupiter ANSWERED that it has no route for
 * the token (nobody here opens a pool for a token only its opener can price).
 * UNCHECKED, which never opens: the token, its decimals, Jupiter's price, or the pairing
 * coin's own price could not be read.
 */

/** SOL under the Token-2022 program (spl-token `NATIVE_MINT_2022`, pinned by a test). */
export const TOKEN_2022_NATIVE_MINT = '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP';

/** Whole pairing coins per whole token at these opening amounts, or null; the same formula as `poolPricePerToken`. */
export function openingPricePerToken(quoteAmount: bigint, token: bigint, tokenDecimals: number, quote: QuoteCoin): number | null {
  if (quoteAmount <= 0n || token <= 0n) return null;
  const p = Number(quoteAmount) / 10 ** quote.decimals / (Number(token) / 10 ** tokenDecimals);
  return Number.isFinite(p) && p > 0 ? p : null;
}

/** SOL per whole token at these opening amounts, or null: `openingPricePerToken` for a SOL pool. */
export function openingSolPerToken(sol: bigint, token: bigint, decimals: number): number | null {
  return openingPricePerToken(sol, token, decimals, SOL_QUOTE);
}

export interface OpeningCheck {
  verdict: 'allowed' | 'refused' | 'unchecked';
  price: PriceCheck | { state: 'empty' };
  reasons: string[];
}

export function assessOpening(a: {
  tokenMint: string;
  /** The coin the new pool pairs the token with. */
  quote: QuoteCoin;
  /** What goes in of that coin, in its own base units (lamports for SOL). */
  quoteAmount: bigint;
  token: bigint;
  tokenDecimals: number | null;
  /** The TOKEN's outside price, in SOL. */
  outside: OutsidePrice | null;
  /** The pairing coin's own outside price in SOL. A SOL opening never looks at it. */
  coinOutside?: OutsidePrice | null;
  safety: TokenSafety | null;
}): OpeningCheck {
  const t = tokenReasons(a.safety, 'pools');
  const refused = [...t.refused];
  const unchecked = [...t.unchecked];
  if (a.tokenMint === TOKEN_2022_NATIVE_MINT) refused.push(`This is SOL under the newer token program. Pools here pair a token with ${QUOTE_COINS_OR}.`);
  else if (!canPair(a.tokenMint, a.quote)) refused.push(`This site does not open a pool that prices this token in ${a.quote.symbol}.`);
  // The token's market price in the pool's own coin; null when Jupiter was not asked.
  const market = a.outside ? priceInQuote(a.outside, a.quote, a.coinOutside ?? null) : null;

  let price: OpeningCheck['price'];
  if (a.tokenDecimals === null) {
    price = { state: 'unread', pool: null, detail: 'the token’s decimals were not read' };
    unchecked.push('We could not read the token’s decimals, so we cannot work out the opening price.');
  } else if (a.quoteAmount < 1n || a.token < 1n) {
    // Nothing typed yet on one side: no price to judge, and no reason to give.
    price = { state: 'empty' };
  } else {
    const opening = openingPricePerToken(a.quoteAmount, a.token, a.tokenDecimals, a.quote);
    if (opening === null) {
      price = { state: 'unread', pool: null, detail: 'the opening price could not be worked out' };
      unchecked.push('We could not work out the opening price from these amounts.');
    } else if (market?.kind === 'ok') {
      price = comparePrice(opening, market.perToken, 'outside');
      if (price.state === 'disagrees') {
        refused.push(
          `Your opening price is ${gapText(price.diff)} the market price (Jupiter). Pools opened from this site must start within ${PRICE_TOLERANCE * 100}% of it.`,
        );
      }
    } else if (market?.kind === 'no-route') {
      price = { state: 'unread', pool: opening, detail: market.detail };
      refused.push('Jupiter has no market price for this token, so this site does not open a pool for it.');
    } else {
      const detail = market?.detail ?? 'not asked';
      price = { state: 'unread', pool: opening, detail };
      unchecked.push(`We could not get a market price from Jupiter (${detail}).`);
    }
  }

  return {
    verdict: refused.length ? 'refused' : unchecked.length ? 'unchecked' : 'allowed',
    price,
    reasons: [...refused, ...unchecked],
  };
}

/** "2.6% above" / "4.0% below". */
function gapText(diff: number): string {
  return `${(Math.abs(diff) * 100).toFixed(1)}% ${diff > 0 ? 'above' : 'below'}`;
}

/**
 * The other side of an opening at the market price, rounded to the nearest unit: keep the
 * side typed in last, set the other. `pricePerToken` is whole pairing coins per whole
 * token (`priceInQuote`), and `quote` says how many decimals that coin has. Null when the
 * answer is below one unit, or when the inputs cannot price anything.
 */
export function matchMarket(a: { keep: 'quote' | 'token'; amount: bigint; pricePerToken: number; tokenDecimals: number; quote: QuoteCoin }): bigint | null {
  if (a.amount < 1n || !(a.pricePerToken > 0) || !Number.isFinite(a.pricePerToken)) return null;
  const scale = 10 ** a.tokenDecimals;
  const quoteScale = 10 ** a.quote.decimals;
  const other =
    a.keep === 'quote'
      ? (Number(a.amount) / quoteScale / a.pricePerToken) * scale
      : (Number(a.amount) / scale) * a.pricePerToken * quoteScale;
  if (!Number.isFinite(other)) return null;
  const rounded = BigInt(Math.round(other));
  return rounded < 1n ? null : rounded;
}

/**
 * The largest opening at the market price that fits both balances: all the pairing coin
 * that can go in when the tokens cover it, else all the tokens and the coin that matches
 * them. Never above either balance. Null when either side would be empty.
 */
export function mostBothAtMarket(a: {
  spendableQuote: bigint;
  tokenBalance: bigint;
  pricePerToken: number;
  tokenDecimals: number;
  quote: QuoteCoin;
}): { quote: bigint; token: bigint } | null {
  if (a.spendableQuote < 1n || a.tokenBalance < 1n) return null;
  const tokenForAll = matchMarket({ keep: 'quote', amount: a.spendableQuote, pricePerToken: a.pricePerToken, tokenDecimals: a.tokenDecimals, quote: a.quote });
  // All the coin that can go in does not buy one token unit: nothing fits at this price.
  if (tokenForAll === null) return null;
  if (tokenForAll <= a.tokenBalance) return { quote: a.spendableQuote, token: tokenForAll };
  const quoteForAllTokens = matchMarket({ keep: 'token', amount: a.tokenBalance, pricePerToken: a.pricePerToken, tokenDecimals: a.tokenDecimals, quote: a.quote });
  if (quoteForAllTokens === null) return null;
  // Rounding to the nearest unit may land one over the coin that can go in.
  return { quote: quoteForAllTokens > a.spendableQuote ? a.spendableQuote : quoteForAllTokens, token: a.tokenBalance };
}

/**
 * What arbitrage would take from an opening at these amounts, in the pairing coin's base
 * units, if the pool's price were moved to the market: `x + y·m − 2·√(x·y·m)` in whole
 * coins, written as `(√x − √(y·m))²` so it is never negative. The trade fee is ignored,
 * so it is an upper bound. Display only.
 */
export function arbitrageLoss(a: { quoteAmount: bigint; token: bigint; tokenDecimals: number; marketPricePerToken: number; quote: QuoteCoin }): number {
  const quoteScale = 10 ** a.quote.decimals;
  const x = Number(a.quoteAmount) / quoteScale;
  const y = Number(a.token) / 10 ** a.tokenDecimals;
  const m = a.marketPricePerToken;
  if (!(x >= 0) || !(y >= 0) || !(m > 0) || !Number.isFinite(x * y * m)) return 0;
  const gap = Math.sqrt(x) - Math.sqrt(y * m);
  return gap * gap * quoteScale;
}
