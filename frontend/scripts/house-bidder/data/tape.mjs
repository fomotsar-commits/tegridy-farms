/**
 * The sales tape (BUILD-SPEC 2.4 / 3.4.4): which past sales are allowed to set the house's price.
 *
 * A sale is dropped, with the first reason that applies, when:
 *  - 'currency'      it was not paid in ETH, WETH or Blur's BETH, so its amount is not ETH wei
 *                    (added to 2.4's list; saleEvents never returns such a sale, this guards other inputs)
 *  - 'house'         the house is the seller or the buyer (the house must never price off itself)
 *  - 'insider'       an insider wallet or venue contract is the seller or the buyer
 *  - 'self-trade'    seller and buyer are the same wallet
 *  - 'round-trip-30d' the same token went A -> B and back B -> A within 30 days (Dune's
 *                    back-and-forth wash rule, per token); both legs are dropped
 *  - 'tail-low' / 'tail-high' it is outside 0.67x to 1.5x of the median of the sales in the 14 days
 *                    before it (once the sales above are out). Only sales strictly earlier count,
 *                    so a sale is judged against what the market looked like when it happened, and a
 *                    batch dumped in one transaction cannot vouch for itself. With fewer than 3 such
 *                    sales there is no median to judge against and the sale is kept.
 *
 * Identity filters run before the wash and tail filters, so an insider's trade is reported as
 * 'insider' even when it was also a wash; `reasons` lists every identity/wash rule that matched.
 * Kept sales gain `kind`: 'bid' (paid in WETH or BETH: a seller hit a bid) or 'listing' (paid in ETH).
 * Sales after `now` are ignored as not having happened yet (backtests replay history).
 */
import { BLUR_POOL, NATIVE, WETH } from './constants.mjs';
import { addressSet, isAddress, medianBig, toBigInt, toUnixSec } from './util.mjs';

export const DEFAULT_TAPE_PARAMS = Object.freeze({
  roundTripDays: 30,
  tailWindowDays: 14,
  tailLow: 0.67,
  tailHigh: 1.5,
  tailMinSales: 3,
});

export const DROP_REASONS = Object.freeze(['currency', 'house', 'insider', 'self-trade', 'round-trip-30d', 'tail-low', 'tail-high']);

/** 'bid' | 'listing' | null from the payment token. */
export function saleKind(paymentToken) {
  const t = String(paymentToken ?? '').toLowerCase();
  if (t === NATIVE) return 'listing';
  if (t === WETH || t === BLUR_POOL) return 'bid';
  return null;
}

function normalize(s, i) {
  if (!s || typeof s !== 'object') throw new TypeError(`sale ${i} is not an object`);
  if (!Number.isFinite(s.time)) throw new TypeError(`sale ${i} has no time`);
  if (!isAddress(s.seller) || !isAddress(s.buyer)) throw new TypeError(`sale ${i} needs seller and buyer addresses`);
  if (s.tokenId == null) throw new TypeError(`sale ${i} has no tokenId`);
  return {
    ...s,
    time: toUnixSec(s.time),
    seller: s.seller.toLowerCase(),
    buyer: s.buyer.toLowerCase(),
    tokenId: String(s.tokenId),
    priceWei: toBigInt(s.priceWei, `sale ${i} priceWei`),
    kind: saleKind(s.paymentToken),
  };
}

/**
 * @param {object[]} sales  saleEvents() output (or anything with txHash, time, tokenId, priceWei,
 *   paymentToken, seller, buyer)
 * @param {object} o
 * @param {Iterable|object} [o.houseWallets] house addresses
 * @param {Iterable|object} [o.insiderWallets] addresses, or insiders.json itself (wallets + contracts)
 * @param {number} [o.now] ms or seconds
 * @param {object} [o.params] overrides of DEFAULT_TAPE_PARAMS
 * @returns {{ kept: object[], dropped: { sale: object, reason: string, reasons: string[] }[] }}
 */
export function buildTape(sales, { houseWallets, insiderWallets, now, params } = {}) {
  if (!Array.isArray(sales)) throw new TypeError('sales must be an array');
  const p = { ...DEFAULT_TAPE_PARAMS, ...params };
  const t = toUnixSec(now ?? Date.now());
  const house = addressSet(houseWallets, 'house wallet list');
  const insiders = addressSet(insiderWallets, 'insider list');
  const rows = sales
    .map((s, i) => ({ s: normalize(s, i), i }))
    .filter((r) => r.s.time <= t)
    .sort((a, b) => a.s.time - b.s.time || a.i - b.i);

  // Round trips, per token: a later sale whose seller was the earlier buyer and whose buyer was the
  // earlier seller, within the window. Every sale up to `now` can be a leg, dropped or not.
  const roundTrip = new Set();
  const byToken = new Map();
  for (const r of rows) {
    const key = `${r.s.contract ?? ''}:${r.s.tokenId}`;
    if (!byToken.has(key)) byToken.set(key, []);
    byToken.get(key).push(r);
  }
  const rtSpan = p.roundTripDays * 86_400;
  for (const legs of byToken.values()) {
    for (let a = 0; a < legs.length; a++) {
      for (let b = a + 1; b < legs.length; b++) {
        const x = legs[a].s;
        const y = legs[b].s;
        if (y.time - x.time > rtSpan) break;
        if (x.seller !== x.buyer && y.seller === x.buyer && y.buyer === x.seller) {
          roundTrip.add(legs[a]);
          roundTrip.add(legs[b]);
        }
      }
    }
  }

  const dropped = [];
  const candidates = [];
  for (const r of rows) {
    const { s } = r;
    const reasons = [];
    if (!s.kind) reasons.push('currency');
    if (house.has(s.seller) || house.has(s.buyer)) reasons.push('house');
    if (insiders.has(s.seller) || insiders.has(s.buyer)) reasons.push('insider');
    if (s.seller === s.buyer) reasons.push('self-trade');
    if (roundTrip.has(r)) reasons.push('round-trip-30d');
    if (reasons.length) dropped.push({ sale: s, reason: reasons[0], reasons });
    else candidates.push(s);
  }

  // Tails, against the median of the candidates strictly before each sale. Ratios are compared in
  // whole basis points so no float touches a wei amount.
  const lowBps = BigInt(Math.round(p.tailLow * 10_000));
  const highBps = BigInt(Math.round(p.tailHigh * 10_000));
  const tailSpan = p.tailWindowDays * 86_400;
  const kept = [];
  let lo = 0;
  for (let k = 0; k < candidates.length; k++) {
    const s = candidates[k];
    while (candidates[lo].time < s.time - tailSpan) lo++;
    const prior = [];
    for (let j = lo; j < k && candidates[j].time < s.time; j++) prior.push(candidates[j].priceWei);
    let reason = null;
    if (s.priceWei <= 0n) reason = 'tail-low';
    else if (prior.length >= p.tailMinSales) {
      const med = medianBig(prior);
      if (s.priceWei * 10_000n < med * lowBps) reason = 'tail-low';
      else if (s.priceWei * 10_000n > med * highBps) reason = 'tail-high';
    }
    if (reason) dropped.push({ sale: s, reason, reasons: [reason] });
    else kept.push(s);
  }
  dropped.sort((a, b) => a.sale.time - b.sale.time);
  return { kept, dropped };
}

/** How many sales each rule dropped (first reason only), for reports. */
export function dropCounts(tape) {
  const counts = Object.fromEntries(DROP_REASONS.map((r) => [r, 0]));
  for (const d of tape.dropped) counts[d.reason] = (counts[d.reason] ?? 0) + 1;
  return counts;
}
