import type { OutsidePrice } from '../lp/outsidePrice';
import { PRICE_TOLERANCE } from '../lp/poolHealth';
import { MAX_SQRT_PRICE_X64, MIN_SQRT_PRICE_X64, getDeltaAmountsSigned, getTickAtSqrtPrice } from './math';
import { priceAtSqrt, priceNumber, sqrtAtPrice, type Pair, type TickRange } from './rangeMath';

/**
 * A range pool's price against the outside market, before money goes in. Anyone can open a
 * range pool at any price, and a deposit lands at the pool's price: when that is off the
 * market, arbitrage moves it back and takes value from the deposit. This says the gap and
 * an estimate of that loss, the way the LP deposit does (poolHealth.ts, 3% tolerance).
 */

export type RangePriceCheck =
  | { state: 'agrees'; pool: number; reference: number; diff: number }
  | { state: 'disagrees'; pool: number; reference: number; diff: number; lossQuote: bigint | null }
  | { state: 'no-market'; detail: string }
  | { state: 'unread'; detail: string };

/** The outside price in the pool's coin per token: SOL directly, any other coin through its own SOL price. */
function referenceOf(pair: Pair, token: OutsidePrice, coin: OutsidePrice | null): number | Exclude<RangePriceCheck, { pool: number }> {
  if (token.kind === 'no-route') return { state: 'no-market', detail: token.detail };
  if (token.kind === 'unread') return { state: 'unread', detail: token.detail };
  if (pair.quote.native) return token.solPerToken;
  if (!coin) return { state: 'unread', detail: `${pair.quote.symbol}'s own price was not asked` };
  if (coin.kind === 'no-route') return { state: 'no-market', detail: coin.detail };
  if (coin.kind === 'unread') return { state: 'unread', detail: coin.detail };
  return token.solPerToken / coin.solPerToken;
}

/**
 * What a move back to `reference` would cost this deposit, in the coin's base units: the
 * deposit valued at the outside price, less what the position would hold once the pool's
 * price is there, valued the same way. Null when it cannot be worked out.
 */
function lossAt(pair: Pair, range: TickRange, liquidity: bigint, amount0: bigint, amount1: bigint, reference: number): bigint | null {
  try {
    const scale = 10n ** 18n;
    const den = scale;
    const num = BigInt(Math.round(reference * 1e18));
    if (num <= 0n) return null;
    let sqrt = sqrtAtPrice(pair, { num, den });
    if (sqrt <= MIN_SQRT_PRICE_X64) sqrt = MIN_SQRT_PRICE_X64 + 1n;
    if (sqrt >= MAX_SQRT_PRICE_X64) sqrt = MAX_SQRT_PRICE_X64 - 1n;
    const [h0, h1] = getDeltaAmountsSigned(getTickAtSqrtPrice(sqrt), sqrt, range.tickLower, range.tickUpper, -liquidity);
    const value = (a0: bigint, a1: bigint) => {
      const [token, coin] = pair.tokenIsToken0 ? [a0, a1] : [a1, a0];
      return Number(coin) / 10 ** pair.quoteDecimals + (Number(token) / 10 ** pair.tokenDecimals) * reference;
    };
    const loss = value(amount0, amount1) - value(h0 < 0n ? -h0 : h0, h1 < 0n ? -h1 : h1);
    if (!Number.isFinite(loss)) return null;
    return loss <= 0 ? 0n : BigInt(Math.ceil(loss * 10 ** pair.quoteDecimals));
  } catch {
    return null;
  }
}

export function rangePriceCheck(a: {
  pair: Pair;
  sqrtPriceX64: bigint;
  range: TickRange;
  liquidity: bigint;
  amount0: bigint;
  amount1: bigint;
  outside: OutsidePrice;
  coinOutside: OutsidePrice | null;
}): RangePriceCheck {
  const reference = referenceOf(a.pair, a.outside, a.coinOutside);
  if (typeof reference !== 'number') return reference;
  if (!Number.isFinite(reference) || reference <= 0) return { state: 'unread', detail: 'the outside price is not a positive number' };
  const pool = priceNumber(priceAtSqrt(a.pair, a.sqrtPriceX64));
  const diff = pool / reference - 1;
  if (Math.abs(diff) <= PRICE_TOLERANCE) return { state: 'agrees', pool, reference, diff };
  return { state: 'disagrees', pool, reference, diff, lossQuote: lossAt(a.pair, a.range, a.liquidity, a.amount0, a.amount1, reference) };
}
