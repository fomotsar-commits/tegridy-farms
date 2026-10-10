import { feeSplit } from '../cpswap/venue';
import type { PoolView } from './poolFinder';

/**
 * A constant-product position against just holding both tokens, when the token's price
 * against the pairing coin is `r` times what it was at the deposit: 2*sqrt(r)/(1+r) - 1.
 * 0 at r = 1, below 0 everywhere else, the same for r and 1/r. Fees are not in it. It is
 * arithmetic for x*y=k, true of any amounts: nothing is predicted and nothing is valued.
 * Null unless r is a positive, finite number.
 */
export function vsHolding(r: number): number | null {
  if (typeof r !== 'number' || !Number.isFinite(r) || r <= 0) return null;
  // Never above 0 in exact arithmetic: the cap only stops a float's last digit saying otherwise.
  return Math.min(0, (2 * Math.sqrt(r)) / (1 + r) - 1);
}

/** "the same", "about 5.7% less", "20% less": one decimal, and "about" unless that decimal is exact. */
function lessText(v: number): string {
  const pct = -v * 100;
  if (pct === 0) return 'the same';
  const shown = Math.round(pct * 10) / 10;
  if (shown === 0) return 'under 0.1% less';
  if (shown >= 100) return 'more than 99.9% less';
  return `${Math.abs(pct - shown) < 1e-9 ? '' : 'about '}${shown}% less`;
}

/** The moves the Add form shows. A move and its inverse cost the same, so each row names both. */
const MOVES: readonly { times: number; price: string }[] = [
  { times: 1, price: 'the same' },
  { times: 2, price: 'double or half' },
  { times: 4, price: '4 times or a quarter' },
];

export const PRICE_MOVE_TITLE = 'What if the price moves';

/** The Add form's fold: a table of at most three rows and one closing line. The form prints these and nothing of its own. */
export interface PriceMoveNote {
  priceHead: string;
  positionHead: string;
  rows: { price: string; position: string }[];
  tail: string;
}

/**
 * Null when the pool has no price to move (a side is empty) or its fee tier was not read:
 * the closing line is about fees, and it is never said of a tier nobody looked at. Every
 * figure is `vsHolding`'s. No price is forecast and no value in any currency is printed.
 */
export function priceMoveNote(view: PoolView): PriceMoveNote | null {
  if (view.quoteReserve <= 0n || view.tokenReserve <= 0n || !view.config) return null;
  const rows: PriceMoveNote['rows'] = [];
  for (const m of MOVES) {
    const v = vsHolding(m.times);
    if (v === null) return null;
    rows.push({ price: m.price, position: lessText(v) });
  }
  const fees =
    feeSplit(view.config).lpKeepsPct > 0
      ? 'Fees are not counted in this: trading fees are what is meant to make up for it.'
      : 'Fees are not counted in this, and on this pool’s fee tier liquidity providers keep none of the trade fee.';
  return {
    priceHead: `This token’s price in ${view.quote.symbol}, against when you added`,
    positionHead: 'Your position, against just holding both tokens',
    rows,
    tail: `${fees} It is arithmetic for this kind of pool, not a forecast.`,
  };
}
