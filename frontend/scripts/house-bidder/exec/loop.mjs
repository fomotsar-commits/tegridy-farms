// The loop: a tick every 60 seconds, and sooner when something happens (a stream event, a house
// fill, an admin change on a collection contract). One tick at a time; an event that arrives
// mid-tick is handled by the next one, except an integrity event, which closes the gate at once.
//
// A tick: STOP? -> house fills and chain events -> one chain snapshot (and books against it) ->
// listings and sales over REST -> fair value -> breakers -> expiries -> (shadow: replay sales
// against the standing bid) -> for each collection, keep, re-price, cancel or post one bid ->
// the WETH approval -> status.json.
//
// Shadow mode (the default) runs the same plan with the real data and never contacts the signer:
// a sale at or below the house's standing price is taken as a fill the house would have had.

import { DEFAULT_PARAMS } from '../brain/params.mjs';
import { planBid } from '../brain/planner.mjs';
import { reseedExposure } from '../brain/exposure.mjs';
import { classifyAdmin, diffSnapshots, restoreRisk } from '../brain/risk.mjs';
import { checkFill } from '../brain/monitor.mjs';
import { reconcile } from '../brain/reconcile.mjs';
import { COLLECTIONS } from '../brain/constants.mjs';
import { addr, toSec, toWei } from '../brain/util.mjs';
import { dailyTotals, knownFills, maxTxCostWei, stolenInMonth } from './ledger.mjs';

const DAY_SEC = 86_400;
const MARK_EVERY_MS = 10 * 60 * 1000;
const SALES_EVERY_MS = 5 * 60 * 1000;
const TREND_EVERY_MS = 60 * 60 * 1000;
const HOLDINGS_EVERY_MS = 60 * 60 * 1000;
const ADMIN_FIELDS = (snap) => ({ jbac: snap?.jbac ?? null, gnss: snap?.gnss ?? null });

const errText = (e) => (e?.kind ? `${e.kind}${e.status ? ` ${e.status}` : ''}: ${e.message ?? ''}` : e?.message ?? String(e));
const big = (v) => (v === null || v === undefined ? null : toWei(v, 'amount'));

/**
 * The data layer's fairValue/buildTape take a `now` whose unit the spec does not fix (the data
 * layer as built reads milliseconds or seconds). The whole bot calls them through these two lines,
 * in milliseconds like every other clock in the data layer (`now = Date.now`), so a change of mind
 * there is a change here only. fairValue also hears the house wallets: a house listing is never
 * L, the cheapest fillable listing or the floor proxy.
 */
export const callBuildTape = (buildTape, sales, opts) => buildTape(sales, { houseWallets: opts.houseWallets, insiderWallets: opts.insiderWallets, now: opts.nowMs });
export const callFairValue = (fairValue, args) => fairValue({ tape: args.tape, listings: args.listings, fillable: args.fillable, now: args.nowMs, prev: args.prev, params: args.params, houseWallets: args.houseWallets });

/**
 * @param {object} d
 * @param {'live'|'shadow'} d.mode
 * @param {object} d.config      brain/config.mjs
 * @param {object} d.data        { opensea, stream, chain, buildTape, fairValue } (2.4, real or fake)
 * @param {object} d.executor    exec/executor.mjs (live or shadow)
 * @param {object} d.exposure
 * @param {object} d.risk
 * @param {object} d.ledger
 * @param {object} d.sets        brain/monitor.mjs counterpartySets
 * @param {() => boolean} d.stopRequested
 * @param {() => object[]} [d.readSignerOrders]  the signer's order file, for the live re-seed
 * @param {() => void} [d.onExit]
 */
export function createLoop({ mode, config, params = DEFAULT_PARAMS, data, executor, exposure, risk, ledger, sets, stopRequested, readSignerOrders = () => [], now, log = () => {}, onExit = () => {}, timers = globalThis }) {
  const shadow = mode === 'shadow';
  const { policy } = config;
  const house = config.house;
  const slugs = Object.keys(policy.collections).filter((s) => shadow || policy.collections[s].enabled);
  const houseSet = new Set([...(config.houseWallets ?? []), ...(house ? [house] : [])]);
  const gasPerTxWei = maxTxCostWei(policy);

  const st = {
    started: false,
    stopped: false,
    busy: false,
    again: false,
    timer: null,
    queue: [],
    pendingHalts: [],
    pendingChecks: [],
    snapshot: null,
    prevSnapshot: null,
    prevWeth: null,
    sales: Object.fromEntries(slugs.map((s) => [s, new Map()])),
    salesReadAt: {},
    salesDirty: {},
    simulatedUpTo: {},
    listings: {},
    fv: {},
    fvState: {},
    trend: {},
    trendAt: {},
    plans: {},
    markAt: {},
    held: Object.fromEntries(Object.keys(policy.collections).map((s) => [s, new Set()])),
    errors: [],
    lastTickAt: null,
    accountOffersAt: 0,
    streamGaps: 0,
    lastWake: 0,
    nextAt: null,
  };
  const nowSec = () => Math.floor(now() / 1000);
  const heldBySlug = () => Object.fromEntries(Object.entries(st.held).map(([s, set]) => [s, set.size]));

  function note(e, where) {
    const line = `${where}: ${errText(e)}`;
    st.errors.push({ at: now(), line });
    if (st.errors.length > 20) st.errors.shift();
    log(line);
  }

  // ── events ──────────────────────────────────────────────────────────────────────────────
  /**
   * Run a tick soon: within `minGapMs` of the last one. A fill or an admin change uses the short
   * gap; a market event the longer one, so a book that relists every minute does not spend the
   * OpenSea read budget the site shares. An earlier tick already due is never pushed back.
   */
  function wake(minGapMs = params.minWakeMs) {
    if (st.stopped) return;
    // Mid-tick: the tick ends by scheduling the next one, soon, instead of in a minute.
    if (st.busy) {
      st.again = true;
      return;
    }
    const at = Math.max(now(), st.lastWake + minGapMs);
    if (st.nextAt !== null && st.nextAt <= at) return;
    timers.clearTimeout(st.timer);
    st.nextAt = at;
    st.timer = timers.setTimeout(() => void tick(), at - now());
  }
  /** An integrity event closes the gate now (executor.halt's first step is synchronous), and acts next tick. */
  function integrityNow(reason, detail) {
    st.pendingHalts.push(executor.halt(reason, detail).catch((e) => note(e, `halt (${reason})`)));
    wake();
  }
  const handlers = {
    onFill: (fill) => {
      st.queue.push({ type: 'fill', fill });
      wake();
    },
    onMint: (m) => integrityNow('mint', `${m.slug} token ${m.tokenId} minted to ${m.to} (tx ${m.txHash})`),
    onOwnerChange: (m) => integrityNow(m.slug === 'gnssart' ? 'gnss-owner' : 'jbac-owner', `${m.slug} owner ${m.from} -> ${m.to} (tx ${m.txHash})`),
    onAdmin: (a) => {
      const reason = classifyAdmin(a);
      // A burn (supply down) is recorded, not a breaker.
      if (reason) integrityNow(reason, `${a.field}: ${a.before} -> ${a.after}`);
      else ledger.append('chain-note', { field: a.field, before: a.before, after: a.after, block: a.block ?? null });
    },
  };

  function subscribeStream() {
    const s = data.stream;
    if (!s) return;
    // A gap closes the gate until the next tick's REST read (within a minute); it does not
    // wake the loop, since a quiet collection gaps every 30 seconds.
    s.on('gap', () => {
      st.streamGaps += 1;
      risk.noteGap(now());
    });
    for (const type of ['listed', 'cancelled', 'transferred', 'invalidated', 'revalidated']) s.on(type, () => wake(params.marketWakeMs));
    s.on('sold', (ev) => {
      if (ev?.slug) st.salesDirty[ev.slug] = true;
      wake(params.marketWakeMs);
    });
    s.on('invalidated', (ev) => {
      const o = ev?.orderHash ? exposure.get(ev.orderHash) : null;
      if (o) ledger.append('opensea-invalidated', { orderHash: o.orderHash, slug: o.slug });
    });
    // Other people's bids ('collection_offer', 'trait_offer') are deliberately not listened to.
  }

  // ── fills ───────────────────────────────────────────────────────────────────────────────
  async function handleFill(raw, { simulated = false } = {}) {
    let fill = raw;
    const r = exposure.recordFill(fill);
    if (!r.fresh) return;
    if (!r.known) {
      await executor.halt('ledger-mismatch', `a house fill of order ${fill.orderHash} that the house never signed (tx ${fill.txHash})`);
      return;
    }
    // A fill the chain watcher could not read as one known NFT for WETH is not one a house
    // order can produce.
    if (fill.anomaly) await executor.halt('ledger-mismatch', `the fill in tx ${fill.txHash} is not one known NFT for WETH (${fill.anomaly})`);
    if (fill.unitPriceWei === null || fill.unitPriceWei === undefined) {
      // Counted at the order's own price (the most it can have cost) so the caps still see it.
      fill = { ...fill, unitPriceWei: r.order.unitPriceWei };
      ledger.append('review', { txHash: fill.txHash, tokenId: fill.tokenId, why: 'the fill price could not be decoded: counted at the bid price' });
    }
    if (r.overfill || r.overpaid) {
      await executor.halt('ledger-mismatch', `order ${fill.orderHash} ${r.overfill ? 'filled more units than it was for' : 'paid more than its price'} (tx ${fill.txHash})`);
    }
    st.held[fill.slug]?.add(String(fill.tokenId));
    ledger.append('fill', { ...fill, simulated });
    ledger.trade(fill);
    await checkAndAct(fill, []);
    // The approval comes back to its target at the end of this tick, after a fresh chain read:
    // set from a snapshot taken before the fill, it would cost a transaction for nothing.
    st.fillSinceSync = true;
  }

  async function checkAndAct(fill, skip, tries = 0) {
    const res = await checkFill(fill, { sets, chain: data.chain, opensea: data.opensea, nowSec: nowSec(), provenanceDays: params.provenanceDays, skip });
    ledger.append('fill-check', { orderHash: fill.orderHash, tokenId: fill.tokenId, txHash: fill.txHash, verdict: res.verdict, findings: res.findings, integrity: res.integrity, pending: res.pending });
    if (res.stolen) ledger.append('quarantine', { slug: fill.slug, tokenId: fill.tokenId, orderHash: fill.orderHash, txHash: fill.txHash, why: 'OpenSea flags the item' });
    for (const i of res.integrity) await executor.halt(i.reason, i.detail);
    if (res.pending.length) {
      if (tries + 1 >= params.itemCheckRetries) ledger.append('review', { tokenId: fill.tokenId, txHash: fill.txHash, why: `checks not completed after ${tries + 1} tries: ${res.pending.join(', ')}` });
      else st.pendingChecks.push({ fill, skip: [...skip, ...res.passed], tries: tries + 1 });
    }
  }

  // ── reads ───────────────────────────────────────────────────────────────────────────────
  async function readSales(slug, { full = false } = {}) {
    const last = st.salesReadAt[slug];
    const dirty = st.salesDirty[slug];
    if (!full && last && !dirty && now() - last < SALES_EVERY_MS) return;
    const map = st.sales[slug];
    let after = nowSec() - params.tapeDays * DAY_SEC;
    if (!full && map.size) after = Math.max(after, Math.max(...[...map.values()].map((s) => toSec(s.time) ?? 0)) - params.salesOverlapSec);
    const got = await data.opensea.saleEvents(slug, { afterSec: after, beforeSec: nowSec() });
    for (const s of got) map.set(`${String(s.txHash).toLowerCase()}:${s.tokenId}`, s);
    const keepAfter = nowSec() - params.tapeDays * DAY_SEC;
    for (const [k, s] of map) if ((toSec(s.time) ?? 0) < keepAfter) map.delete(k);
    st.salesReadAt[slug] = now();
    st.salesDirty[slug] = false;
  }

  const insiderWallets = () => [...sets.people];

  async function readMarket(slug) {
    const startedAt = now();
    // Until this read succeeds the collection has no fair value: nothing new is posted on last
    // minute's numbers (a standing bid was priced on good data and ends within 30 minutes).
    st.fv[slug] = null;
    let listings;
    try {
      listings = await data.opensea.bestListings(slug, { limit: params.listingsLimit });
    } catch (e) {
      risk.noteRestRead({ ok: false, startedAt });
      note(e, `${slug} listings`);
      return null;
    }
    // The house's own listings never count (it lists nothing in v1; this keeps it so).
    listings = listings.filter((l) => !houseSet.has(addr(l.maker)));
    let fillable;
    try {
      fillable = await data.chain.listingFillable(listings);
    } catch (e) {
      risk.noteRestRead({ ok: false, startedAt });
      note(e, `${slug} listing check`);
      return null;
    }
    // Only a whole read (listings and whether each can be filled) lifts a data gap.
    risk.noteRestRead({ ok: true, startedAt });
    try {
      await readSales(slug);
    } catch (e) {
      note(e, `${slug} sales`);
    }
    const sales = [...st.sales[slug].values()];
    const nowMs = now();
    const tape = callBuildTape(data.buildTape, sales, { houseWallets: [...houseSet], insiderWallets: insiderWallets(), nowMs });
    const fv = callFairValue(data.fairValue, { tape: tape.kept, listings, fillable, nowMs, prev: st.fvState[slug] ?? null, params: undefined, houseWallets: [...houseSet] });
    st.fvState[slug] = fv.state;
    st.listings[slug] = { listings, fillable, at: nowMs };
    st.fv[slug] = { ...fv, dropped: tape.dropped.length };
    if (typeof fv.floorProxy === 'bigint') risk.noteFloor(slug, nowMs, fv.floorProxy);

    // S a day ago, from the same tape: the planner's 24-hour trend. Once an hour is plenty.
    if (!st.trendAt[slug] || nowMs - st.trendAt[slug] >= TREND_EVERY_MS) {
      const thenMs = nowMs - DAY_SEC * 1000;
      const before = tape.kept.filter((s) => (toSec(s.time) ?? 0) * 1000 <= thenMs);
      try {
        const old = callFairValue(data.fairValue, { tape: before, listings: [], fillable: new Map(), nowMs: thenMs, prev: null, params: undefined, houseWallets: [...houseSet] });
        st.trend[slug] = { then: typeof old.S === 'bigint' ? old.S : null, now: typeof fv.S === 'bigint' ? fv.S : null };
      } catch (e) {
        note(e, `${slug} trend`);
        st.trend[slug] = null;
      }
      st.trendAt[slug] = nowMs;
    } else if (st.trend[slug]) {
      st.trend[slug] = { ...st.trend[slug], now: typeof fv.S === 'bigint' ? fv.S : null };
    }

    if (!st.markAt[slug] || nowMs - st.markAt[slug] >= MARK_EVERY_MS) {
      st.markAt[slug] = nowMs;
      ledger.append('mark', { slug, F: fv.F, S: fv.S, L: fv.L, cheapestFillable: fv.cheapestFillable, floorProxy: fv.floorProxy, n: fv.n, sellers: fv.sellers, reason: fv.reason, dropped: tape.dropped.length });
    }
    return fv;
  }

  // ── chain ───────────────────────────────────────────────────────────────────────────────
  async function readChain() {
    let snap;
    try {
      snap = await data.chain.snapshot();
    } catch (e) {
      note(e, 'chain snapshot');
      return null;
    }
    for (const d of diffSnapshots(st.snapshot ?? st.restoredAdmin ?? null, snap)) await executor.halt(d.reason, d.detail);
    const before = JSON.stringify(ADMIN_FIELDS(st.snapshot ?? st.restoredAdmin), (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    const after = JSON.stringify(ADMIN_FIELDS(snap), (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    if (before !== after) ledger.append('chain', { block: snap.block, ...ADMIN_FIELDS(snap) });
    st.prevSnapshot = st.snapshot;
    st.snapshot = snap;
    if (!shadow && house) {
      const prevCounter = exposure.counter();
      exposure.setCounter(snap.house.counter);
      // Checked BEFORE the bot's own pending bump is marked seen: a bump the bot asked for is
      // expected, any other is a mismatch.
      await checkBooks(snap, prevCounter);
      if (prevCounter !== null && snap.house.counter > prevCounter) executor.noteCounterSeen();
    }
    return snap;
  }

  /**
   * The latest snapshot less the fills the bot already knows about that the snapshot's block does
   * not include yet: a fill pulls WETH and lowers the approval, and a lagging RPC must not make
   * the house look better funded, or its approval higher, than it is.
   */
  function currentSnapshot() {
    const snap = st.snapshot;
    if (!snap) return null;
    let newer = 0n;
    for (const f of knownFills({ entries: ledger.read(), chainFills: [], shadow })) {
      if (f.block !== null && f.block !== undefined && Number(f.block) > snap.block) newer += toWei(f.unitPriceWei, 'fill price');
    }
    if (newer === 0n) return snap;
    const less = (v) => (v > newer ? v - newer : 0n);
    return { ...snap, house: { ...snap.house, weth: less(snap.house.weth), allowance: less(snap.house.allowance) } };
  }

  /** Books against the chain; a mismatch is checked once more, after re-reading the house's fills, before it halts. */
  async function checkBooks(snap, expectedCounter) {
    const books = executor.books;
    const args = () => ({
      snapshot: snap,
      // null: never approved (the chain must show 0); undefined: approved at a block the bot
      // does not know, so the approval is not checked until the next one.
      lastApproval: !books.lastApproval ? null : books.lastApproval.block === null ? undefined : books.lastApproval,
      fills: knownFills({ entries: ledger.read(), chainFills: [] }).map((f) => ({ block: Number(f.block ?? 0), unitPriceWei: toWei(f.unitPriceWei, 'fill price') })),
      expectedCounter,
      counterBumpPending: books.counterBumpPending,
      prevWeth: st.prevWeth,
      ownTxs: books.ownTxs,
    });
    let r = reconcile(args());
    if (!r.ok) {
      try {
        const fills = await data.chain.houseFills({ sinceSec: nowSec() - params.reseedFillDays * DAY_SEC });
        for (const f of fills) await handleFill(f);
      } catch (e) {
        note(e, 're-reading house fills');
      }
      r = reconcile(args());
      if (!r.ok) await executor.halt('ledger-mismatch', r.mismatches.map((m) => `${m.field}: expected ${m.expected}, chain says ${m.actual}`).join('; '));
    }
    st.prevWeth = { weth: snap.house.weth, block: snap.block };
  }

  // ── decisions ───────────────────────────────────────────────────────────────────────────
  function standingPrices() {
    const out = {};
    for (const [slug, p] of Object.entries(st.plans)) if (p && !p.none) out[slug] = p.unitPriceWei;
    return out;
  }

  /**
   * The planner's bid for a collection. `besides` is the standing order being judged: its own
   * unfilled units are not counted against the room it is judged for (otherwise every standing
   * bid would look like it leaves no room for itself).
   */
  function plan(slug, besides = null) {
    const fv = st.fv[slug];
    const own = besides ? Math.max(0, besides.qty - besides.filled) : 0;
    const p = planBid({
      slug,
      F: fv?.F ?? null,
      cheapestFillable: fv?.cheapestFillable ?? null,
      held: st.held[slug]?.size ?? 0,
      outstanding: exposure.outstanding(slug, nowSec()) - own,
      policy,
      params,
      trend: st.trend[slug] ?? null,
    });
    st.plans[slug] = p.none ? p : { ...p, slug };
    return st.plans[slug];
  }

  function arbitrageLine(slug) {
    const c = st.fv[slug]?.cheapestFillable;
    return typeof c === 'bigint' ? (c * BigInt(params.arbitrageBps)) / 10_000n - params.arbitrageBufferWei : null;
  }

  async function decide(slug) {
    const t = nowSec();
    const ctx = { snapshot: currentSnapshot(), heldBySlug: heldBySlug() };
    const [standing] = exposure.active(slug, t);
    if (standing) {
      const line = arbitrageLine(slug);
      // Above the arbitrage line a flipper can buy the floor and sell it straight into the
      // house: cancel now, outside the hourly re-price limit.
      if (line !== null && standing.unitPriceWei > line) {
        await executor.cancel(standing.orderHash, 'arbitrage-line');
        const p = plan(slug);
        if (!p.none) await executor.post(p, { ...ctx, reprice: false });
        return;
      }
      const p = plan(slug, standing);
      if (p.none) {
        if (p.reason === 'no-room') await executor.cancel(standing.orderHash, 'cap-reached');
        // No fair value (thin data): the bid was priced on good data and expires within 30 minutes.
        return;
      }
      const diff = p.unitPriceWei > standing.unitPriceWei ? p.unitPriceWei - standing.unitPriceWei : standing.unitPriceWei - p.unitPriceWei;
      const far = diff * 10_000n > standing.unitPriceWei * BigInt(params.repriceBps);
      // A re-price that could not post its replacement (a closed gate) would only cancel: leave it.
      if (far && executor.mayReprice(slug) && risk.gate().canPost) {
        ledger.append('decision', { slug, action: 'reprice', from: standing.unitPriceWei, to: p.unitPriceWei });
        const c = await executor.cancel(standing.orderHash, 'fair-value-moved');
        if (!c.ok) return;
        // Re-plan: the old order's tail is now outstanding, so the new one bids for what is left.
        const p2 = plan(slug);
        if (!p2.none) await executor.post(p2, { ...ctx, reprice: true });
      }
      return;
    }
    const p = plan(slug);
    if (p.none) return;
    await executor.post(p, { ...ctx, reprice: false });
  }

  async function actOnTrips(events) {
    for (const e of events) {
      // An integrity trip is recorded and acted on by executor.halt itself (cancel, kill).
      if (e.kind === 'integrity') continue;
      if (e.kind === 'resume') {
        ledger.append('resume', { reason: e.reason, detail: e.detail });
        continue;
      }
      ledger.append('breaker', { breaker: e.kind, reason: e.reason, detail: e.detail });
      if (e.kind === 'market' || e.kind === 'halt') await executor.cancelAll('risk-halt');
      if (e.kind === 'cap') await executor.cancelAll('cap-reached');
    }
  }

  // ── shadow: replay real sales against the standing bid ─────────────────────────────────
  async function simulateFills(slug) {
    const from = st.simulatedUpTo[slug] ?? nowSec();
    const fresh = [...st.sales[slug].values()].filter((s) => (toSec(s.time) ?? 0) > from).sort((a, b) => toSec(a.time) - toSec(b.time));
    for (const s of fresh) {
      const t = toSec(s.time);
      st.simulatedUpTo[slug] = Math.max(st.simulatedUpTo[slug] ?? 0, t);
      if (houseSet.has(addr(s.seller))) continue;
      const price = big(s.priceWei);
      const order = exposure
        .all()
        .filter((o) => o.slug === slug && o.shadow && o.startTime <= t && t < o.endTime && o.filled < o.qty && (!o.cancel || o.cancel.at > t * 1000))
        .sort((a, b) => (a.unitPriceWei > b.unitPriceWei ? -1 : 1))[0];
      if (!order || price === null || price > order.unitPriceWei) continue;
      await handleFill(
        { txHash: s.txHash, block: null, time: t, orderHash: order.orderHash, slug, tokenId: String(s.tokenId), unitPriceWei: order.unitPriceWei, seller: addr(s.seller), fulfiller: addr(s.seller) },
        { simulated: true },
      );
    }
    if (st.simulatedUpTo[slug] === undefined) st.simulatedUpTo[slug] = from;
  }

  // ── the tick ────────────────────────────────────────────────────────────────────────────
  async function tick() {
    if (st.stopped) return;
    if (st.busy) {
      st.again = true;
      return;
    }
    st.busy = true;
    st.lastWake = now();
    st.nextAt = null;
    try {
      if (stopRequested()) {
        log('STOP found: cancelling every house bid');
        const r = await executor.stopPath();
        log(r.killed ? 'STOP: a tail was open or a cancel failed, so the kill was sent and mined' : 'STOP: every bid cancelled, no tail open');
        stop();
        onExit(r);
        return;
      }
      while (st.pendingHalts.length) await st.pendingHalts.shift();
      while (st.queue.length) {
        const ev = st.queue.shift();
        if (ev.type === 'fill') await handleFill(ev.fill);
      }
      const retry = st.pendingChecks.splice(0, st.pendingChecks.length);
      for (const c of retry) await checkAndAct(c.fill, c.skip, c.tries);

      await readChain();
      for (const slug of slugs) await readMarket(slug);

      const entries = ledger.read();
      const fills = knownFills({ entries, chainFills: [], shadow });
      const daily = dailyTotals({ entries, chainFills: [], dayMs: now(), shadow, gasPerTxWei });
      risk.evaluate({ streamLastMessageAt: data.stream?.lastMessageAt?.() ?? null, fills, daily, stolenThisMonth: stolenInMonth(entries, now(), shadow) });
      await actOnTrips(risk.takeEvents());

      for (const o of exposure.takeExpired(nowSec())) ledger.append('expiry', { orderHash: o.orderHash, slug: o.slug, filled: o.filled, qty: o.qty });
      if (shadow) for (const slug of slugs) await simulateFills(slug);

      for (const slug of slugs) {
        if (!policy.collections[slug].enabled && !shadow) continue;
        try {
          await decide(slug);
        } catch (e) {
          note(e, `${slug} decision`);
        }
      }
      await actOnTrips(risk.takeEvents());
      // After every fill and re-price the approval comes back to its target (the chain's
      // inventory cap), here at the end of the tick, from the fresh chain read.
      if (!shadow && st.snapshot) {
        await executor.syncAllowance({ snapshot: currentSnapshot(), heldBySlug: heldBySlug(), standing: standingPrices(), why: st.fillSinceSync ? 'after-fill' : 'tick' });
        st.fillSinceSync = false;
      }

      // What the house holds, against the chain, once an hour (and at every start).
      if (!shadow && house && now() - (st.holdingsCheckedAt ?? 0) >= HOLDINGS_EVERY_MS) await checkHoldings();

      // OpenSea's view of the house's offers: advisory, never trusted alone.
      if (!shadow && house && now() - st.accountOffersAt >= params.accountOffersEveryMs) {
        st.accountOffersAt = now();
        try {
          const offers = await data.opensea.accountOffers(house);
          for (const off of offers) {
            if (!exposure.get(off.orderHash)) await executor.halt('ledger-mismatch', `OpenSea lists a house offer ${off.orderHash} that the house never signed`);
          }
        } catch (e) {
          note(e, 'house offers');
        }
      }
    } catch (e) {
      note(e, 'tick');
      ledger.append('error', { where: 'tick', error: errText(e) });
    } finally {
      st.lastTickAt = now();
      try {
        ledger.writeStatus(status());
      } catch (e) {
        log(`status.json not written: ${errText(e)}`);
      }
      st.busy = false;
      if (!st.stopped) {
        timers.clearTimeout(st.timer);
        const wait = st.again ? params.minWakeMs : params.tickMs;
        st.nextAt = now() + wait;
        st.timer = timers.setTimeout(() => void tick(), wait);
        st.again = false;
      }
    }
  }

  // ── start: re-seed everything before the first post ─────────────────────────────────────
  async function start({ ackHalt = false, fresh = false } = {}) {
    let entries = ledger.read();
    if (shadow && fresh) ledger.append('shadow-reset', {});
    if (shadow) {
      const lastReset = entries.reduce((i, e, idx) => (e.kind === 'shadow-reset' && e.shadow ? idx : i), -1);
      entries = fresh ? [] : entries.slice(lastReset + 1);
    }
    ledger.append('start', { mode, house, slugs, policySha256: config.policySha256 ?? null });

    risk.restore(restoreRisk(entries, { nowMs: now(), params, shadow }));
    if (ackHalt && risk.halted()) {
      const was = risk.ackHalt();
      ledger.append('ack-halt', { reason: was?.reason ?? null, detail: was?.detail ?? null });
      log(`halt acknowledged by a person: ${was?.reason}`);
    }
    executor.restoreBooks(entries);
    const lastChain = [...entries].reverse().find((e) => e.kind === 'chain' && Boolean(e.shadow) === shadow);
    st.restoredAdmin = lastChain ? { jbac: lastChain.jbac, gnss: lastChain.gnss } : null;

    let chainFills = [];
    let accountOffers = null;
    let counter = null;
    if (!shadow && house) {
      try {
        chainFills = await data.chain.houseFills({ sinceSec: nowSec() - params.reseedFillDays * DAY_SEC });
      } catch (e) {
        note(e, 're-seed: house fills');
        throw new Error('the house fills could not be read from the chain: not starting (a live run must know what it already bought)', { cause: e });
      }
      try {
        accountOffers = await data.opensea.accountOffers(house);
      } catch (e) {
        note(e, 're-seed: house offers (advisory)');
      }
      try {
        const snap = await data.chain.snapshot();
        counter = snap.house.counter;
      } catch (e) {
        note(e, 're-seed: counter');
      }
    }
    // Shadow re-seeds from its own lines only, a live run from live lines only.
    const own = shadow ? entries.filter((e) => e.shadow).map((e) => ({ ...e, shadow: false })) : entries.filter((e) => !e.shadow);
    const seeded = reseedExposure({ signerOrders: shadow ? [] : readSignerOrders(), ledgerEntries: own, chainFills, accountOffers, counter, nowSec: nowSec() });
    for (const o of seeded.exposure.all()) {
      const added = exposure.add({ ...o, posted: o.posted, shadow });
      added.filled = o.filled;
      added.cancel = o.cancel;
      added.advisoryLiveUntil = o.advisoryLiveUntil;
    }
    if (counter !== null) exposure.setCounter(counter);
    // A house fill the chain shows and the ledger does not (the file was restored from an older
    // copy, or the bot was down) is written back into the ledger, so the daily caps and the
    // report count it: the chain is the record that cannot be rolled back.
    const inLedger = new Set(knownFills({ entries, chainFills: [], shadow }).map((f) => `${String(f.txHash).toLowerCase()}:${String(f.orderHash).toLowerCase()}:${f.tokenId}`));
    const unseen = chainFills.filter((f) => !inLedger.has(`${String(f.txHash).toLowerCase()}:${String(f.orderHash).toLowerCase()}:${f.tokenId}`));
    for (const f of unseen) ledger.append('fill', { ...f, reseeded: true });
    // Holdings: every token the house bought, from the ledger and the chain.
    for (const f of knownFills({ entries, chainFills, shadow })) st.held[f.slug]?.add(String(f.tokenId));
    ledger.append('reseed', { orders: seeded.exposure.all().length, live: exposure.live(nowSec()).length, held: heldBySlug(), findings: seeded.findings });
    for (const f of seeded.findings) {
      if (f.code === 'unknown-fill' || f.code === 'unknown-offer' || f.code === 'overfill') await executor.halt('ledger-mismatch', f.detail);
    }
    if (!shadow && house) await checkHoldings();
    // A fill made while the bot was not watching is screened like any other before anything is posted.
    for (const f of unseen) await checkAndAct(f, []);

    for (const slug of slugs) {
      try {
        await readSales(slug, { full: true });
      } catch (e) {
        note(e, `${slug} sales (start)`);
      }
      st.simulatedUpTo[slug] = nowSec();
    }
    subscribeStream();
    data.stream?.start?.();
    if (data.chain?.watch) data.chain.watch(handlers);
    st.started = true;
    await tick();
  }

  /** Every token the books say the house holds is checked on chain: one that left without a ledger line halts. */
  async function checkHoldings() {
    st.holdingsCheckedAt = now();
    for (const [slug, set] of Object.entries(st.held)) {
      for (const tokenId of [...set]) {
        let moves;
        try {
          moves = await data.chain.tokenProvenance(slug, tokenId, { sinceDays: params.provenanceDays });
        } catch (e) {
          note(e, `holding check ${slug} #${tokenId}`);
          continue; // unread is not proof it left: it stays counted as held
        }
        const last = [...moves].sort((a, b) => (toSec(a.time) ?? 0) - (toSec(b.time) ?? 0)).pop();
        if (!last || addr(last.to) === house) continue;
        // Back to the funding wallet is the one way out the signer allows (returnNftToFunding).
        if (addr(last.to) === policy.fundingWallet) {
          set.delete(tokenId);
          ledger.append('nft-returned', { slug, tokenId, to: addr(last.to), txHash: last.txHash });
          continue;
        }
        // Anywhere else, the books are wrong or the key is not ours alone. It stays counted as
        // held (less room, never more) until a person has looked.
        await executor.halt('ledger-mismatch', `${COLLECTIONS[slug]?.ticker ?? slug} #${tokenId} left the house (to ${addr(last.to)}, tx ${last.txHash}) with no ledger line`);
      }
    }
  }

  function stop() {
    st.stopped = true;
    timers.clearTimeout(st.timer);
    try {
      data.stream?.stop?.();
    } catch {
      // stopping anyway
    }
  }

  function status() {
    const t = nowSec();
    const gate = risk.gate();
    const rs = risk.snapshot();
    const entries = ledger.read();
    const daily = dailyTotals({ entries, chainFills: [], dayMs: now(), shadow, gasPerTxWei });
    return {
      at: new Date(now()).toISOString(),
      mode,
      house,
      gate,
      halted: rs.halted,
      paused: rs.paused,
      capped: rs.capped,
      dataGap: rs.dataGapSince !== null,
      trips: rs.trips.slice(-10),
      chain: st.snapshot ? { block: st.snapshot.block, weth: st.snapshot.house?.weth, allowance: st.snapshot.house?.allowance, counter: st.snapshot.house?.counter, eth: st.snapshot.house?.eth } : null,
      today: daily,
      stream: { lastMessageAt: data.stream?.lastMessageAt?.() ?? null, gaps: st.streamGaps },
      collections: Object.fromEntries(
        Object.keys(policy.collections).map((slug) => {
          const fv = st.fv[slug] ?? null;
          const [standing] = exposure.active(slug, t);
          return [
            slug,
            {
              ticker: COLLECTIONS[slug].ticker,
              enabled: policy.collections[slug].enabled,
              F: fv?.F ?? null,
              S: fv?.S ?? null,
              L: fv?.L ?? null,
              cheapestFillable: fv?.cheapestFillable ?? null,
              floorProxy: fv?.floorProxy ?? null,
              fairValueReason: fv?.reason ?? null,
              plan: st.plans[slug] ?? null,
              standing: standing ? { orderHash: standing.orderHash, unitPriceWei: standing.unitPriceWei, qty: standing.qty, filled: standing.filled, endTime: standing.endTime } : null,
              held: st.held[slug]?.size ?? 0,
              outstanding: exposure.outstanding(slug, t),
              tailUnits: exposure.tailUnits(slug, t),
            },
          ];
        }),
      ),
      lastTickAt: st.lastTickAt ? new Date(st.lastTickAt).toISOString() : null,
      errors: st.errors.slice(-5),
    };
  }

  return { start, tick, stop, status, handlers, state: st };
}
