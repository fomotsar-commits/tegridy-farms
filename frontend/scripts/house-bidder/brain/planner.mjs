// The bid planner: what one house bid should be, from fair value and the house's own position.
//
// It is a pure function of the bot's numbers. It is never given anyone else's bids, on purpose:
// a bot that prices off other bids ends up outbidding everyone by 0.0001 ETH every minute, and the
// house would set the price instead of honestly bidding under fair value (no tick-chasing).

import { DEFAULT_PARAMS } from './params.mjs';
import { COLLECTIONS } from './constants.mjs';
import { roundDownToTick, toWei } from './util.mjs';

/** Why a collection gets no bid this time. Closed list: the ledger and the report read these. */
export const NO_BID = Object.freeze(['unknown-collection', 'collection-disabled', 'no-fair-value', 'no-room', 'price-too-low']);

/** True when fair value is down more than `bps` on 24 hours ago. Unknown is not "down". */
export function trendIsDown(trend, bps) {
  if (trend === null || trend === undefined) return false;
  if (typeof trend === 'number') return Number.isFinite(trend) && trend * 10_000 < -bps;
  const { then, now } = trend;
  if (typeof then !== 'bigint' || typeof now !== 'bigint' || then <= 0n) return false;
  return now * 10_000n < then * BigInt(10_000 - bps);
}

function count(value, what) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${what} must be a whole number of NFTs, not ${value}`);
  return value;
}

/**
 * @param {object} a
 * @param {string} a.slug
 * @param {bigint|null} a.F                 fair value (wei per NFT), null when there is none
 * @param {bigint|null} a.cheapestFillable  the cheapest fillable listing by anyone but the house
 * @param {number} a.held                    NFTs of this collection the house holds
 * @param {number} a.outstanding             unfilled units on every order that is still live exposure
 * @param {object} a.policy                  policy.json (2.2)
 * @param {object} [a.params]                bot parameters (params.mjs)
 * @param {{then: bigint|null, now: bigint|null}|number|null} [a.trend]  S now against S 24 hours ago
 * @returns {{unitPriceWei: bigint, qty: number, edgeBps: number, binding: 'fair'|'arbitrage'|'ceiling', lines: object} | {none: true, reason: string}}
 */
export function planBid({ slug, F, cheapestFillable, held, outstanding, policy, params = DEFAULT_PARAMS, trend = null }) {
  const c = policy?.collections?.[slug];
  if (!c || !COLLECTIONS[slug]) return { none: true, reason: 'unknown-collection' };
  if (c.enabled !== true) return { none: true, reason: 'collection-disabled' };
  if (typeof F !== 'bigint' || F <= 0n) return { none: true, reason: 'no-fair-value' };

  count(held, 'held');
  count(outstanding, 'outstanding');
  // Room is what the house may still come to hold: its cap, less what it holds, less every unit
  // an order of its own could still be filled for (an old order's 5-minute tail included).
  const room = c.inventoryCap - held - outstanding;
  if (room <= 0) return { none: true, reason: 'no-room' };
  const qty = Math.min(c.maxQty, room);

  // The edge grows as the house fills up, and when the market is falling.
  const down = trendIsDown(trend, params.trendDownBps);
  const edgeBps = params.baseEdgeBps + params.perHeldEdgeBps * held + (down ? params.trendEdgeBps : 0);
  const fairLine = edgeBps >= 10_000 ? 0n : (F * BigInt(10_000 - edgeBps)) / 10_000n;

  // With no fillable listing there is nothing to sweep, so no arbitrage line.
  const arbLine = typeof cheapestFillable === 'bigint' && cheapestFillable > 0n
    ? (cheapestFillable * BigInt(params.arbitrageBps)) / 10_000n - params.arbitrageBufferWei
    : null;
  const ceiling = toWei(c.maxUnitPriceWei, `${slug} maxUnitPriceWei`);

  let price = fairLine;
  let binding = 'fair';
  if (arbLine !== null && arbLine < price) {
    price = arbLine;
    binding = 'arbitrage';
  }
  if (ceiling < price) {
    price = ceiling;
    binding = 'ceiling';
  }
  const unitPriceWei = roundDownToTick(price);
  if (unitPriceWei <= 0n) return { none: true, reason: 'price-too-low' };
  return { unitPriceWei, qty, edgeBps, binding, lines: { fair: fairLine, arbitrage: arbLine, ceiling } };
}
