// The backtest: saved sales replayed through the planner and the breakers, step by step, as if
// the bot had been running. A sale at or below the house's standing price counts as a fill the
// house would have had (the same rule as shadow mode), so the result leans toward MORE fills:
// it is a test of the caps and breakers, not a promise of profit.
//
// Listing history is not saved anywhere (OpenSea's API gives the book as it is now), so the
// listing side is rebuilt from the sales themselves: every listing that sold (paid in ETH) is
// taken as a listing that stood at that price, from its seller, for the day BEFORE it sold, and
// was gone once sold. Listings that never sold are missing, so the rebuilt floor sits a little
// high. It stands in for both the arbitrage line's "cheapest fillable listing" and the floor proxy
// the breakers watch; it is a stand-in, and the report says so.

import { DEFAULT_PARAMS } from './params.mjs';
import { planBid } from './planner.mjs';
import { createRisk } from './risk.mjs';
import { addr, toSec, toWei, utcDay } from './util.mjs';
import { SEAPORT_16, WETH, ZERO_ADDRESS } from './constants.mjs';

const DAY = 86_400;

/** One sale, from the data layer's shape or OpenSea's raw event (saved research files). */
export function normalizeSale(raw) {
  if (raw && raw.priceWei !== undefined) {
    return {
      txHash: String(raw.txHash).toLowerCase(),
      time: toSec(raw.time),
      tokenId: String(raw.tokenId),
      priceWei: toWei(raw.priceWei, 'sale price'),
      paymentToken: addr(raw.paymentToken) ?? ZERO_ADDRESS,
      seller: addr(raw.seller),
      buyer: addr(raw.buyer),
      orderHash: raw.orderHash ?? null,
    };
  }
  const qty = BigInt(raw?.quantity || 1);
  const total = toWei(raw?.payment?.quantity ?? '0', 'sale price');
  return {
    txHash: String(raw.transaction).toLowerCase(),
    time: toSec(raw.event_timestamp),
    tokenId: String(raw?.nft?.identifier ?? ''),
    priceWei: total / qty,
    paymentToken: addr(raw?.payment?.token_address) ?? ZERO_ADDRESS,
    seller: addr(raw.seller),
    buyer: addr(raw.buyer),
    orderHash: raw.order_hash ?? null,
  };
}

/**
 * One listing, from the data layer's shape or OpenSea's raw order (a saved listings file). A
 * listing still live when the file was saved was live from its start time on: a Seaport order
 * cannot be paused, so the saved book also tells which listings stood at every earlier moment.
 */
export function normalizeListing(raw) {
  if (raw && raw.priceWei !== undefined) {
    return { ...raw, priceWei: toWei(raw.priceWei, 'listing price'), maker: addr(raw.maker), startTime: toSec(raw.startTime), endTime: toSec(raw.endTime) };
  }
  const P = raw?.protocol_data?.parameters;
  if (!P) return null;
  const total = raw?.price?.current?.value !== undefined ? toWei(raw.price.current.value, 'listing price') : P.consideration.reduce((s, c) => s + toWei(c.startAmount, 'listing price'), 0n);
  const qty = BigInt(raw.remaining_quantity || 1);
  return {
    orderHash: String(raw.order_hash).toLowerCase(),
    tokenId: String(P.offer?.[0]?.identifierOrCriteria ?? raw?.asset?.identifier ?? ''),
    priceWei: total / qty,
    maker: addr(P.offerer),
    startTime: toSec(P.startTime),
    endTime: toSec(P.endTime),
    protocol: addr(raw.protocol_address) ?? SEAPORT_16,
    orderType: Number(P.orderType),
    zone: addr(P.zone) ?? ZERO_ADDRESS,
    taker: null,
  };
}

/**
 * The listings standing at `atSec`, rebuilt from listing sales (paid in ETH, not WETH): each one
 * stood for `standSec` before it sold and was gone once sold.
 */
export function pseudoListings(sales, { atSec, standSec = DAY }) {
  return sales
    .filter((s) => s.time > atSec && s.time - standSec <= atSec && s.paymentToken !== WETH && s.priceWei > 0n)
    .map((s) => ({
      orderHash: `bt-${s.txHash}-${s.tokenId}`,
      tokenId: s.tokenId,
      priceWei: s.priceWei,
      maker: s.seller,
      startTime: s.time - standSec,
      endTime: s.time,
      protocol: SEAPORT_16,
      orderType: 0,
      zone: ZERO_ADDRESS,
      taker: null,
    }));
}

/**
 * @param {object} a
 * @param {Record<string, object[]>} a.sales   per slug, any shape normalizeSale reads
 * @param {Record<string, object[]>} [a.listings]  per slug, a saved book (normalizeListing): each
 *   listing counts from its start time; listings that sold are rebuilt from the sales
 * @param {object} a.policy                    validated policy; every slug in `sales` is bid as if enabled
 * @param {Function} a.buildTape               the data layer's (2.4)
 * @param {Function} a.fairValue               the data layer's (2.4)
 * @param {number} a.days
 * @param {number} a.endSec
 * @param {number} [a.stepSec]                 600: ten-minute steps, fine enough for the 1-hour breaker
 */
export function runBacktest({ sales, listings = {}, policy, params = DEFAULT_PARAMS, buildTape, fairValue, days = 30, endSec, stepSec = 600, houseWallets = [], insiderWallets = [] }) {
  const out = { days, endSec, stepSec, collections: {}, note: 'no listing history exists: the book is the saved listings from their start times, plus listings that sold (each standing the day before it sold); listings cancelled before the save are missing' };
  const insiders = new Set(insiderWallets.map(addr).filter(Boolean));
  const houses = new Set(houseWallets.map(addr).filter(Boolean));
  for (const [slug, rawSales] of Object.entries(sales)) {
    if (!policy.collections[slug]) continue;
    const pol = { ...policy, collections: { ...policy.collections, [slug]: { ...policy.collections[slug], enabled: true } } };
    const all = rawSales.map(normalizeSale).filter((s) => s.time !== null).sort((a, b) => a.time - b.time);
    const saved = (listings[slug] ?? []).map(normalizeListing).filter((l) => l && l.maker && l.startTime !== null && !houses.has(l.maker));
    let tMs = 0;
    const risk = createRisk({ params, now: () => tMs });
    const r = { fills: [], held: 0, costWei: 0n, trips: {}, tripLog: [], posts: 0, stepsBidding: 0, lastF: null, lastS: null, integrity: [] };
    let order = null;
    let prev = null;
    let trend = null;
    let trendAt = -Infinity;
    let lastReprice = -Infinity;
    const start = endSec - days * DAY;
    for (let t = start; t <= endSec; t += stepSec) {
      tMs = t * 1000;
      const upTo = all.filter((s) => s.time <= t);
      const tape = buildTape(upTo, { houseWallets: [...houses], insiderWallets: [...insiders], now: tMs });
      // The book at t: saved listings already standing, and listings that sold later (they
      // stood at t, so this is not look-ahead).
      const book = [...saved.filter((l) => l.startTime <= t && t < l.endTime), ...pseudoListings(all, { atSec: t })];
      const fillable = new Map(book.map((l) => [l.orderHash, { fillable: true }]));
      const fv = fairValue({ tape: tape.kept, listings: book, fillable, now: tMs, prev, params: undefined });
      prev = fv.state;
      if (typeof fv.F === 'bigint') r.lastF = fv.F;
      if (typeof fv.S === 'bigint') r.lastS = fv.S;
      risk.noteRestRead({ ok: true, startedAt: tMs });
      if (typeof fv.floorProxy === 'bigint') risk.noteFloor(slug, tMs, fv.floorProxy);
      if (t - trendAt >= 3600) {
        const old = fairValue({ tape: tape.kept.filter((s) => toSec(s.time) <= t - DAY), listings: [], fillable: new Map(), now: tMs - DAY * 1000, prev: null, params: undefined });
        trend = { then: typeof old.S === 'bigint' ? old.S : null, now: typeof fv.S === 'bigint' ? fv.S : null };
        trendAt = t;
      }
      const today = utcDay(tMs);
      const todays = r.fills.filter((f) => utcDay(f.time * 1000) === today);
      risk.evaluate({ fills: r.fills, daily: { wethSpent: todays.reduce((s, f) => s + f.unitPriceWei, 0n), units: todays.length, gasSpent: 0n } });
      for (const e of risk.takeEvents()) {
        if (e.kind === 'resume') continue;
        r.trips[e.reason] = (r.trips[e.reason] ?? 0) + 1;
        r.tripLog.push({ at: new Date(tMs).toISOString(), kind: e.kind, reason: e.reason, detail: e.detail });
        order = null; // every trip cancels the standing bid
      }
      if (order && t >= order.until) order = null;
      const gate = risk.gate();
      const plan = planBid({ slug, F: fv.F ?? null, cheapestFillable: fv.cheapestFillable ?? null, held: r.held, outstanding: order ? order.qty - order.filled : 0, policy: pol, params, trend });
      if (order && typeof fv.cheapestFillable === 'bigint') {
        const line = (fv.cheapestFillable * BigInt(params.arbitrageBps)) / 10_000n - params.arbitrageBufferWei;
        if (order.unitPriceWei > line) order = null;
      }
      if (order && !plan.none) {
        const diff = plan.unitPriceWei > order.unitPriceWei ? plan.unitPriceWei - order.unitPriceWei : order.unitPriceWei - plan.unitPriceWei;
        if (diff * 10_000n > order.unitPriceWei * BigInt(params.repriceBps) && tMs - lastReprice >= params.repriceEveryMs) {
          order = null;
          lastReprice = tMs;
        }
      }
      if (!order && gate.canPost) {
        const p = planBid({ slug, F: fv.F ?? null, cheapestFillable: fv.cheapestFillable ?? null, held: r.held, outstanding: 0, policy: pol, params, trend });
        if (!p.none) {
          order = { unitPriceWei: p.unitPriceWei, qty: Math.min(p.qty, gate.maxQty ?? p.qty), filled: 0, until: t + params.bidLifetimeSec };
          r.posts += 1;
        }
      }
      if (!order) continue;
      r.stepsBidding += 1;
      for (const s of all) {
        if (s.time <= t || s.time > t + stepSec || order.filled >= order.qty) continue;
        if (houses.has(s.seller) || s.priceWei > order.unitPriceWei) continue;
        if (insiders.has(s.seller)) r.integrity.push({ at: new Date(s.time * 1000).toISOString(), reason: 'insider-fill', seller: s.seller });
        order.filled += 1;
        r.held += 1;
        r.costWei += order.unitPriceWei;
        r.fills.push({ time: s.time, tokenId: s.tokenId, unitPriceWei: order.unitPriceWei, salePriceWei: s.priceWei, seller: s.seller });
      }
      if (order.filled >= order.qty) order = null;
    }
    const mark = r.lastF ?? r.lastS ?? 0n;
    // What the holdings would fetch at fair value, less OpenSea's 1% on the way out.
    const markWei = (BigInt(r.held) * mark * 9_900n) / 10_000n;
    out.collections[slug] = {
      sales: all.filter((s) => s.time > start && s.time <= endSec).length,
      posts: r.posts,
      hoursBidding: (r.stepsBidding * stepSec) / 3600,
      units: r.fills.length,
      held: r.held,
      costWei: r.costWei,
      markWei,
      pnlWei: markWei - r.costWei,
      lastF: r.lastF,
      trips: r.trips,
      tripLog: r.tripLog,
      integrity: r.integrity,
      fills: r.fills,
    };
  }
  return out;
}
