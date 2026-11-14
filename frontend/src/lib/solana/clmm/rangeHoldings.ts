// What a range position HOLDS at a price it has not reached yet.
//
// A range position is not a fixed pair of amounts: as the price moves through the range the
// pool trades one coin for the other inside it, and past either edge the position is all one
// coin and earns nothing. This works out the two amounts at any price, with the program's own
// maths (math.ts) and rounded down as a withdrawal is, so the dial that draws it
// (components/solana/range/RangeHoldingsDial.tsx) never shows more than the position would
// return. Nothing is forecast: it is what the same liquidity is, at another price.
import { ClmmMathError, getDeltaAmount0Signed, getDeltaAmount1Signed, getSqrtPriceAtTick } from './math';
import { parsePrice, sqrtAtPrice, type Pair, type TickRange } from './rangeMath';

export interface Holdings {
  /** The token side, in its base units. */
  token: bigint;
  /** The pairing coin's side, in its base units. */
  coin: bigint;
  /** The price against the range, in coin per token: below it (all token), inside, above it (all coin). */
  where: 'below' | 'inside' | 'above';
  /** The token's share of the position's value at that price, 0 to 1. */
  tokenShare: number;
}

const abs = (v: bigint) => (v < 0n ? -v : v);

/** Null for a price that is not a positive number, no liquidity, or maths the program would refuse. */
export function holdingsAt(pair: Pair, r: TickRange, liquidity: bigint, price: number): Holdings | null {
  if (!(Number.isFinite(price) && price > 0) || liquidity <= 0n) return null;
  // The price as an exact fraction the pair's own conversion takes; 18 places is finer than any tick.
  const fraction = parsePrice(price.toFixed(18));
  if (!fraction) return null;
  try {
    const sqrt = sqrtAtPrice(pair, fraction);
    const lower = getSqrtPriceAtTick(r.tickLower);
    const upper = getSqrtPriceAtTick(r.tickUpper);
    // A withdrawal of all of it (negative liquidity), in the pool's own token order.
    let amount0 = 0n;
    let amount1 = 0n;
    if (sqrt <= lower) amount0 = abs(getDeltaAmount0Signed(lower, upper, -liquidity));
    else if (sqrt < upper) {
      amount0 = abs(getDeltaAmount0Signed(sqrt, upper, -liquidity));
      amount1 = abs(getDeltaAmount1Signed(lower, sqrt, -liquidity));
    } else amount1 = abs(getDeltaAmount1Signed(lower, upper, -liquidity));
    const [token, coin] = pair.tokenIsToken0 ? [amount0, amount1] : [amount1, amount0];
    const tokenValue = (Number(token) / 10 ** pair.tokenDecimals) * price;
    const coinValue = Number(coin) / 10 ** pair.quoteDecimals;
    const total = tokenValue + coinValue;
    return {
      token,
      coin,
      where: coin === 0n && token > 0n ? 'below' : token === 0n && coin > 0n ? 'above' : 'inside',
      tokenShare: total > 0 ? tokenValue / total : 0,
    };
  } catch (e) {
    if (e instanceof ClmmMathError) return null;
    throw e;
  }
}

/** How far past each edge the dial's axis runs, as a multiple of the edge's price. */
export const HOLDINGS_MARGIN = 1.6;
export const HOLDINGS_STOPS = 200;

/** The price at a stop: log-spaced from under the range's lowest price to over its highest. */
export function holdingsPrice(min: number, max: number, stop: number): number {
  const from = Math.log(min / HOLDINGS_MARGIN);
  const to = Math.log(max * HOLDINGS_MARGIN);
  const s = Math.max(0, Math.min(HOLDINGS_STOPS, stop));
  return Math.exp(from + ((to - from) * s) / HOLDINGS_STOPS);
}

/** The stop nearest a price, held to the axis. */
export function holdingsStop(min: number, max: number, price: number): number {
  const from = Math.log(min / HOLDINGS_MARGIN);
  const to = Math.log(max * HOLDINGS_MARGIN);
  if (!(Number.isFinite(price) && price > 0) || !(to > from)) return HOLDINGS_STOPS / 2;
  return Math.max(0, Math.min(HOLDINGS_STOPS, Math.round(((Math.log(price) - from) / (to - from)) * HOLDINGS_STOPS)));
}
