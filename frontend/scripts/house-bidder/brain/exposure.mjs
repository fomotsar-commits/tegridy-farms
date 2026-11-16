// Exposure: every order the house ever signed, and which of them can still be filled.
//
// The rule (BUILD-SPEC 3.5 step 3) is deliberately pessimistic. A signed order is live exposure
// until the EARLIEST of: its end time passed; an on-chain cancel of it was mined; the house's
// Seaport counter moved past the counter it was signed with; or a gasless cancel was confirmed
// AND the last fill signature OpenSea issued before that cancel has expired. Nothing else ends it:
// not OpenSea saying it is gone, not the bot having failed to post it, not a restart. Outstanding
// units (what the house can still be made to buy) are the unfilled units of live orders, and the
// planner subtracts them from the room left under the inventory cap.

import { toSec, toWei } from './util.mjs';

/** Seconds of slack on every clock comparison: a block's timestamp is not the bot's clock. */
export const CLOCK_SLACK_SEC = 60;

function normalOrder(o) {
  const orderHash = String(o.orderHash ?? o.hash ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(orderHash) && !/^shadow-/.test(orderHash)) throw new Error('an order without a 32-byte order hash');
  const qty = Number(o.qty);
  if (!Number.isInteger(qty) || qty < 1) throw new Error(`order ${orderHash}: quantity ${o.qty} is not a whole number of NFTs`);
  const endTime = toSec(o.endTime ?? o.parameters?.endTime);
  if (endTime === null) throw new Error(`order ${orderHash}: no end time`);
  const counterRaw = o.counter ?? o.parameters?.counter;
  return {
    orderHash,
    slug: String(o.slug),
    qty,
    unitPriceWei: toWei(o.unitPriceWei, `order ${orderHash} unit price`),
    startTime: toSec(o.startTime ?? o.parameters?.startTime) ?? 0,
    endTime,
    // An order whose counter is unknown can never be proven dead by a counter bump.
    counter: counterRaw === undefined || counterRaw === null ? null : toWei(counterRaw, `order ${orderHash} counter`),
    signedAt: o.signedAt ?? null,
    posted: o.posted ?? null,
    shadow: o.shadow === true,
    filled: 0,
    cancel: null,
    expiryNoted: false,
    advisoryLiveUntil: null,
  };
}

export function createExposure() {
  /** @type {Map<string, ReturnType<typeof normalOrder>>} */
  const book = new Map();
  const fillKeys = new Set();
  let counter = null;

  function deadReason(o, nowSec) {
    // Chain facts first: a full fill, the end time, a mined cancel, a counter bump.
    if (o.filled >= o.qty) return 'filled';
    if (nowSec >= o.endTime + CLOCK_SLACK_SEC) return 'expired';
    if (o.cancel?.method === 'on-chain' && o.cancel.mined) return 'cancelled-on-chain';
    if (counter !== null && o.counter !== null && counter > o.counter) return 'counter';
    // A gasless cancel is OpenSea's word, so OpenSea still listing the order keeps it live
    // (reseed below): its word can only ever make the house more careful.
    if (o.cancel?.method === 'gasless' && o.cancel.confirmed) {
      const until = o.cancel.validUntil;
      const tailOver = until === null || nowSec >= until + CLOCK_SLACK_SEC;
      const stillListed = o.advisoryLiveUntil !== null && nowSec < o.advisoryLiveUntil + CLOCK_SLACK_SEC;
      if (tailOver && !stillListed) return 'cancelled-gasless';
    }
    return null;
  }

  const api = {
    /** Add a signed order (from signBid, the signer's order file or the ledger). A repeat is merged, never reset. */
    add(order) {
      const o = normalOrder(order);
      const had = book.get(o.orderHash);
      if (had) {
        if (had.posted === null && o.posted !== null) had.posted = o.posted;
        if (had.counter === null && o.counter !== null) had.counter = o.counter;
        return had;
      }
      book.set(o.orderHash, o);
      return o;
    },
    get: (orderHash) => book.get(String(orderHash).toLowerCase()) ?? null,
    all: () => [...book.values()],

    /**
     * One unit filled (one Fill per NFT). Returns whether the order is one of the house's,
     * whether the fill is new, and whether it filled more units than the order was for or
     * paid more than its price (neither can happen on Seaport; either means the books are wrong).
     */
    recordFill(fill) {
      const orderHash = String(fill.orderHash ?? '').toLowerCase();
      const key = `${String(fill.txHash).toLowerCase()}:${orderHash}:${fill.tokenId}`;
      const o = book.get(orderHash);
      if (!o) return { known: false, fresh: !fillKeys.has(key), order: null };
      if (fillKeys.has(key)) return { known: true, fresh: false, order: o };
      fillKeys.add(key);
      o.filled += 1;
      const overfill = o.filled > o.qty;
      const overpaid = fill.unitPriceWei !== undefined && toWei(fill.unitPriceWei, 'fill price') > o.unitPriceWei;
      return { known: true, fresh: true, order: o, overfill, overpaid };
    },

    /** A gasless cancel OpenSea confirmed. `lastSignatureValidUntil` null means no fill signature was issued. */
    recordGaslessCancel(orderHash, { at, lastSignatureValidUntil }) {
      const o = book.get(String(orderHash).toLowerCase());
      if (!o) return null;
      const until = lastSignatureValidUntil === null || lastSignatureValidUntil === undefined ? null : toSec(lastSignatureValidUntil);
      o.cancel = { method: 'gasless', confirmed: true, at, validUntil: until === 0 ? null : until };
      return o;
    },
    /** An on-chain cancel sent; `mined` true once it is in a block. Until then the order is live. */
    recordOnChainCancel(orderHash, { at, txHash, mined }) {
      const o = book.get(String(orderHash).toLowerCase());
      if (!o) return null;
      o.cancel = { method: 'on-chain', at, txHash, mined: mined === true };
      return o;
    },
    /** A cancel was ASKED for but not confirmed: the order stays live, and is no longer the standing bid. */
    recordCancelAsked(orderHash, { at, reason }) {
      const o = book.get(String(orderHash).toLowerCase());
      if (!o || o.cancel) return o ?? null;
      o.cancel = { method: 'asked', at, reason };
      return o;
    },
    /** The house's Seaport counter as read on chain. It only ever goes up. */
    setCounter(value) {
      const c = toWei(value, 'counter');
      if (counter === null || c > counter) counter = c;
      return counter;
    },
    counter: () => counter,

    isLive: (o, nowSec) => deadReason(o, nowSec) === null,
    deadReason,
    live(nowSec, slug) {
      return [...book.values()].filter((o) => (slug === undefined || o.slug === slug) && deadReason(o, nowSec) === null);
    },
    /** Units the house can still be made to buy on this collection. */
    outstanding(slug, nowSec) {
      return api.live(nowSec, slug).reduce((n, o) => n + Math.max(0, o.qty - o.filled), 0);
    },
    /** The standing bid(s): live and never asked to cancel. The loop keeps at most one per collection. */
    active(slug, nowSec) {
      return api.live(nowSec, slug).filter((o) => !o.cancel);
    },
    /** Units on live orders that are being cancelled but can still be filled (the tail). */
    tailUnits(slug, nowSec) {
      return api.live(nowSec, slug).filter((o) => o.cancel).reduce((n, o) => n + Math.max(0, o.qty - o.filled), 0);
    },
    highestLivePrice(slug, nowSec) {
      let best = null;
      for (const o of api.live(nowSec, slug)) if (best === null || o.unitPriceWei > best) best = o.unitPriceWei;
      return best;
    },
    /** Orders that ran out since the last call, each returned once (for the ledger's expiry lines). */
    takeExpired(nowSec) {
      const out = [];
      for (const o of book.values()) {
        if (!o.expiryNoted && deadReason(o, nowSec) === 'expired') {
          o.expiryNoted = true;
          out.push(o);
        }
      }
      return out;
    },
    /** Every live gasless-cancelled order whose tail is still open. */
    openTails(nowSec) {
      return api.live(nowSec).filter((o) => o.cancel?.method === 'gasless' && o.cancel.validUntil !== null && nowSec < o.cancel.validUntil + CLOCK_SLACK_SEC);
    },
    /** OpenSea says this order is still live: never ends exposure, may only extend it to its end time. */
    noteAdvisoryLive(orderHash, untilSec) {
      const o = book.get(String(orderHash).toLowerCase());
      if (!o) return null;
      const until = toSec(untilSec);
      if (until !== null && (o.advisoryLiveUntil === null || until > o.advisoryLiveUntil)) o.advisoryLiveUntil = Math.min(until, o.endTime);
      return o;
    },
  };
  return api;
}

/**
 * The WETH approval the house should have: for each collection, the room left under its
 * inventory cap times the highest unit price it bids at (its live orders, and `standing`: the
 * price it is about to post or keeps re-posting). With the approval held to this, the chain itself
 * caps what the house can be made to buy, whatever the bot's books say: at full inventory it is 0.
 *
 * @returns {{ target: bigint, minPrice: bigint | null }}  minPrice: the cheapest unit any collection with room bids at
 */
export function allowanceTarget({ policy, exposure, heldBySlug, nowSec, standing = {} }) {
  let target = 0n;
  let minPrice = null;
  for (const [slug, c] of Object.entries(policy.collections)) {
    const room = Math.max(0, c.inventoryCap - (heldBySlug[slug] ?? 0));
    let price = exposure.highestLivePrice(slug, nowSec) ?? 0n;
    if (typeof standing[slug] === 'bigint' && standing[slug] > price) price = standing[slug];
    if (room > 0 && price > 0n) {
      target += BigInt(room) * price;
      if (minPrice === null || price < minPrice) minPrice = price;
    }
  }
  return { target, minPrice };
}

/** WETH the house must hold for its live orders to be fully funded (every unfilled unit at its price). */
export function fundingNeeded({ exposure, nowSec, extra = null }) {
  let need = 0n;
  for (const o of exposure.live(nowSec)) need += BigInt(Math.max(0, o.qty - o.filled)) * o.unitPriceWei;
  if (extra) need += BigInt(extra.qty) * extra.unitPriceWei;
  return need;
}

/**
 * Rebuild the book on start (BUILD-SPEC 3.5 step 3): the signer's own order file first, then
 * the bot's ledger, then the chain's house fills; OpenSea's list of the house's offers last and
 * advisory only. OpenSea can make the book MORE careful (an order it still shows is kept live to
 * its end time) but never less, and an offer it shows that the house never signed is a finding
 * the caller treats as a broken ledger.
 *
 * @returns {{ exposure: ReturnType<typeof createExposure>, findings: {code: string, detail: string}[] }}
 */
export function reseedExposure({ signerOrders = [], ledgerEntries = [], chainFills = [], accountOffers = null, counter = null, nowSec }) {
  const exposure = createExposure();
  const findings = [];
  const signed = new Set();
  for (const line of signerOrders) {
    const o = exposure.add({ ...line, posted: null });
    signed.add(o.orderHash);
  }
  for (const e of ledgerEntries) {
    if (e.shadow) continue;
    if (e.kind === 'post' || e.kind === 'signed') {
      const o = exposure.add({ ...e, posted: e.kind === 'post' });
      if (!signed.has(o.orderHash) && signerOrders.length) findings.push({ code: 'ledger-only-order', detail: `${o.orderHash} is in the bot's ledger but not in the signer's order file` });
    }
  }
  for (const e of ledgerEntries) {
    if (e.shadow) continue;
    if (e.kind === 'cancel' && e.method === 'gasless' && e.confirmed) exposure.recordGaslessCancel(e.orderHash, { at: e.at, lastSignatureValidUntil: e.lastSignatureValidUntil ?? null });
    if (e.kind === 'cancel' && e.method === 'on-chain') exposure.recordOnChainCancel(e.orderHash, { at: e.at, txHash: e.txHash, mined: e.mined === true });
    if (e.kind === 'fill') exposure.recordFill(e);
  }
  for (const f of chainFills) {
    const r = exposure.recordFill(f);
    if (!r.known) findings.push({ code: 'unknown-fill', detail: `the chain shows a house fill of order ${f.orderHash} that the house never signed` });
    else if (r.overfill) findings.push({ code: 'overfill', detail: `order ${f.orderHash} filled more units than it was for` });
  }
  if (counter !== null) exposure.setCounter(counter);
  if (accountOffers) {
    for (const off of accountOffers) {
      const o = exposure.get(off.orderHash);
      if (!o) {
        findings.push({ code: 'unknown-offer', detail: `OpenSea lists a house offer ${off.orderHash} that the house never signed` });
        continue;
      }
      const end = toSec(off.endTime);
      if (end !== null && end > nowSec && (off.remainingQty ?? 1) > 0 && !exposure.isLive(o, nowSec)) {
        exposure.noteAdvisoryLive(o.orderHash, end);
        findings.push({ code: 'opensea-says-live', detail: `OpenSea still lists ${o.orderHash}: kept as live until it ends` });
      }
      if (typeof off.remainingQty === 'number' && off.remainingQty < o.qty - o.filled) {
        findings.push({ code: 'fills-unseen', detail: `OpenSea shows ${off.remainingQty} left on ${o.orderHash}; the chain shows ${o.qty - o.filled}` });
      }
    }
  }
  return { exposure, findings };
}
