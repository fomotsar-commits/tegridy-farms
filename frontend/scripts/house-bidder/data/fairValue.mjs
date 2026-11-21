/**
 * Fair value (BUILD-SPEC 2.4 / 3.4.4): a price that bait listings and fake sales cannot drag.
 *
 *  S  the sales value: the tape's sales in the last 14 days, each weighted by recency (7-day
 *     half-life) and 1.5x when a seller hit a bid. With 15 or more sales it is their weighted average
 *     (a VWAP: every ERC-721 sale is one unit). With fewer it is their weighted MEDIAN, which a
 *     couple of odd prints cannot move. Below 8 sales or 5 distinct sellers there is no S ('thin').
 *  L  the listing check: the 3rd cheapest of the per-seller cheapest listings that are FILLABLE
 *     (the chain says the maker still owns the NFT and has approved the operator), at least 30 minutes
 *     old, public, unexpired and not the house's. One seller can set at most one of the three.
 *  F  = min(S, L). It may fall at once but rises at most 5% an hour from the last F (`prev`), and
 *     the hours only accrue while F exists, so a spell of 'thin' cannot bank a jump.
 *  cheapestFillable  the cheapest fillable non-house listing of any age: the planner's arbitrage line.
 *  floorProxy  the breakers' floor: like L, but a listing whose fillability is merely unknown (the
 *     chain read failed) still counts, so the market breakers keep working when the chain read
 *     does not; one known to be unfillable never counts.
 *
 * A listing's age runs from the later of its startTime and OpenSea's createdAt: a maker can backdate
 * startTime but not the moment OpenSea received the order.
 *
 * Wei stays bigint throughout; weights are scaled to whole numbers before they touch an amount.
 */
import { addressSet, minBig, toBigInt, toUnixSec } from './util.mjs';

export const DEFAULT_FAIR_VALUE_PARAMS = Object.freeze({
  windowDays: 14,
  halfLifeDays: 7,
  bidWeight: 1.5,
  minSales: 8,
  minSellers: 5,
  medianBelow: 15,
  listingRank: 3,
  listingMinAgeMin: 30,
  riseCapPerHour: 0.05,
});

const WEIGHT_SCALE = 1e9;
const ETH_CURRENCIES = new Set(['ETH', 'WETH']);

/** The price where the cumulative weight first reaches half; the lower one on an exact tie. */
function weightedMedian(items) {
  const sorted = [...items].sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
  const total = sorted.reduce((s, x) => s + x.w, 0n);
  let acc = 0n;
  for (const x of sorted) {
    acc += x.w;
    if (acc * 2n >= total) return x.price;
  }
  return sorted[sorted.length - 1].price;
}

function lookup(fillable, orderHash) {
  if (!fillable || !orderHash) return undefined;
  if (fillable instanceof Map) return fillable.get(orderHash) ?? fillable.get(String(orderHash).toLowerCase());
  return fillable[orderHash] ?? fillable[String(orderHash).toLowerCase()];
}

/** Listings a buyer could take right now, with what the rules need; anything odd is left out. */
function liveListings(listings, t, house) {
  const out = [];
  for (const l of listings ?? []) {
    if (!l || typeof l.maker !== 'string') continue;
    const maker = l.maker.toLowerCase();
    if (house.has(maker)) continue;
    // A private listing names its buyer: nobody else can take it, so it is neither an ask nor an arbitrage.
    if (l.taker) continue;
    if (l.currency && !ETH_CURRENCIES.has(String(l.currency).toUpperCase())) continue;
    let price;
    try {
      price = toBigInt(l.priceWei);
    } catch {
      continue;
    }
    if (price <= 0n) continue;
    const start = Number(l.startTime);
    const end = Number(l.endTime);
    if (Number.isFinite(start) && start > t) continue;
    if (Number.isFinite(end) && end <= t) continue;
    const listedAt = Math.max(Number.isFinite(start) ? start : 0, Number.isFinite(Number(l.createdAt)) ? Number(l.createdAt) : 0);
    out.push({ orderHash: l.orderHash, maker, price, listedAt });
  }
  return out;
}

/** The rank-th cheapest of each seller's cheapest listing, or null when fewer sellers qualify. */
function rankBySeller(rows, rank) {
  const best = new Map();
  for (const r of rows) {
    const cur = best.get(r.maker);
    if (!cur || r.price < cur.price) best.set(r.maker, r);
  }
  const sorted = [...best.values()].sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
  return sorted.length >= rank ? sorted[rank - 1].price : null;
}

/**
 * @param {object} o
 * @param {object[]|{kept: object[]}} o.tape buildTape().kept (or the whole buildTape() result)
 * @param {object[]} o.listings bestListings() output
 * @param {Map<string,{fillable:boolean}>|object} o.fillable listingFillable() output
 * @param {number} o.now ms or seconds
 * @param {object|null} [o.prev] the `state` the previous call returned
 * @param {object} [o.params] overrides of DEFAULT_FAIR_VALUE_PARAMS
 * @param {Iterable} [o.houseWallets] added to 2.4: house listings are never L, cheapestFillable or
 *   floorProxy. Without it a house listing cannot be recognised (the house does not list in v1).
 */
export function fairValue({ tape, listings, fillable, now, prev, params, houseWallets } = {}) {
  const p = { ...DEFAULT_FAIR_VALUE_PARAMS, ...params };
  const t = toUnixSec(now ?? Date.now());
  const house = addressSet(houseWallets, 'house wallet list');
  const sales = Array.isArray(tape) ? tape : Array.isArray(tape?.kept) ? tape.kept : [];

  // ---- S: the last windowDays of the tape ----
  const from = t - p.windowDays * 86_400;
  const win = sales.filter((s) => {
    const st = toUnixSec(s.time);
    return st > from && st <= t;
  });
  const n = win.length;
  const sellers = new Set(win.map((s) => String(s.seller).toLowerCase())).size;
  let S = null;
  let method = null;
  if (n >= p.minSales && sellers >= p.minSellers) {
    const halfLifeSec = p.halfLifeDays * 86_400;
    const items = win.map((s) => {
      const age = Math.max(0, t - toUnixSec(s.time));
      const w = 2 ** (-age / halfLifeSec) * (s.kind === 'bid' ? p.bidWeight : 1);
      return { price: toBigInt(s.priceWei), w: BigInt(Math.max(1, Math.round(w * WEIGHT_SCALE))) };
    });
    if (n < p.medianBelow) {
      S = weightedMedian(items);
      method = 'median';
    } else {
      const totalW = items.reduce((a, x) => a + x.w, 0n);
      S = items.reduce((a, x) => a + x.price * x.w, 0n) / totalW;
      method = 'vwap';
    }
  }

  // ---- listings: L, cheapestFillable, floorProxy ----
  const live = liveListings(listings, t, house);
  const minAgeSec = p.listingMinAgeMin * 60;
  const known = (l) => lookup(fillable, l.orderHash);
  const fillableNow = live.filter((l) => known(l)?.fillable === true);
  const aged = (l) => t - l.listedAt >= minAgeSec;
  const L = rankBySeller(fillableNow.filter(aged), p.listingRank);
  const cheapestFillable = fillableNow.length ? fillableNow.reduce((m, l) => (l.price < m ? l.price : m), fillableNow[0].price) : null;
  const floorProxy = rankBySeller(live.filter((l) => known(l)?.fillable !== false && aged(l)), p.listingRank);

  // ---- F with the rise cap ----
  const Fraw = S != null && L != null ? minBig(S, L) : null;
  const reason = S == null ? 'thin' : L == null ? 'no-listings' : null;
  let F = Fraw;
  let capped = false;
  const prevF = prev?.F != null ? toBigInt(prev.F, 'prev.F') : null;
  const prevAt = Number.isFinite(prev?.atSec) ? prev.atSec : null;
  if (F != null && prevF != null && prevAt != null && F > prevF) {
    const hours = Math.max(0, (t - prevAt) / 3_600);
    const allowance = BigInt(Math.floor(p.riseCapPerHour * hours * WEIGHT_SCALE));
    const cap = prevF + (prevF * allowance) / BigInt(WEIGHT_SCALE);
    if (F > cap) {
      F = cap;
      capped = true;
    }
  }
  // While F is missing the clock is moved on but F is kept, so the cap restarts from the last F.
  const state = F != null ? { version: 1, F: F.toString(), atSec: t } : prevF != null ? { version: 1, F: prevF.toString(), atSec: t } : null;

  return { S, L, F, n, sellers, cheapestFillable, floorProxy, reason, state, Fraw, capped, method };
}
