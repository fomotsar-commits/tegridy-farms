// The loop: a tick every 60 seconds, and sooner when something happens (a stream event, a house
// fill, an admin change on a collection contract). One tick at a time; an event that arrives
// mid-tick is handled by the next one, except an integrity event, which closes the gate at once.
//
// A tick: STOP? -> house fills and chain events -> one chain snapshot (and books against it) ->
// listings and sales over REST -> fair value -> breakers -> expiries -> (shadow: replay sales
// against the standing bid) -> cancels that did not go through, asked again -> for each
// collection, keep, re-price, cancel or post one bid -> the WETH approval -> status.json.
// A tick whose chain snapshot could not be read decides nothing new and sets no approval: it
// cannot see the fills or approvals its decisions rest on. Its cancels and STOP still run.
//
// Shadow mode (the default) runs the same plan with the real data and never contacts the signer:
// a sale at or below the house's standing price is taken as a fill the house would have had.

import { DEFAULT_PARAMS } from '../brain/params.mjs';
import { planBid } from '../brain/planner.mjs';
import { CLOCK_SLACK_SEC, reseedExposure } from '../brain/exposure.mjs';
import { classifyAdmin, diffSnapshots, restoreRisk } from '../brain/risk.mjs';
import { checkFill, tapeInsiders } from '../brain/monitor.mjs';
import { reconcile } from '../brain/reconcile.mjs';
import { COLLECTIONS } from '../brain/constants.mjs';
import { addr, eth, jsonLine, toSec, toWei } from '../brain/util.mjs';
import { dailyTotals, diskRoom, holdingsFrom, knownFills, maxTxCostWei, stolenInMonth } from './ledger.mjs';

const DAY_SEC = 86_400;
const MARK_EVERY_MS = 10 * 60 * 1000;
const SALES_EVERY_MS = 5 * 60 * 1000;
const TREND_EVERY_MS = 60 * 60 * 1000;
const HOLDINGS_EVERY_MS = 60 * 60 * 1000;
const ADMIN_FIELDS = (snap) => ({ jbac: snap?.jbac ?? null, gnss: snap?.gnss ?? null });

const errText = (e) => (e?.kind ? `${e.kind}${e.status ? ` ${e.status}` : ''}: ${e.message ?? ''}` : e?.message ?? String(e));
const big = (v) => (v === null || v === undefined ? null : toWei(v, 'amount'));
const fillKeyOf = (f) => `${String(f.txHash).toLowerCase()}:${String(f.orderHash).toLowerCase()}:${f.tokenId}`;

/**
 * What a STOP ended with, in one line, and whether it ended clean. A kill that was needed and did
 * not go through (not sent, or sent and not all mined) is said in capitals, with every bid that
 * can still be filled, and the command exits as failed.
 * @param {{ killed?: boolean, needKill?: boolean, afterKill?: boolean, kill?: object }} r  executor.stopPath()
 * @param {object[]} live  the orders still live after it
 */
export function stopSummary(r, live) {
  if (r.afterKill) return { clean: true, line: 'STOP: this run had already killed on chain, which ended every house bid: nothing more to send' };
  if (!r.needKill) return { clean: true, line: 'STOP: every bid cancelled, no tail open' };
  if (r.killed) return { clean: true, line: 'STOP: a tail was open or a cancel failed, so the kill was sent and mined' };
  const list = live.length ? live.map((o) => `${o.orderHash} (${o.slug}, ${Math.max(0, o.qty - o.filled)} x ${eth(o.unitPriceWei)} WETH, ends ${new Date(o.endTime * 1000).toISOString()})`).join('; ') : 'none the bot knows of';
  const head = r.kill?.sent
    ? `STOP: the kill was sent but did NOT finish (${r.kill.reason ?? 'not all mined'}). Until it does, these bids can still be filled: ${list}. Check the house on a block explorer, then run the kill again`
    : `STOP: THE KILL WAS NOT SENT (${r.kill?.why ?? 'unknown'}). These bids can still be filled: ${list}. Run it yourself`;
  return { clean: false, line: `${head}: node tools/house-signer/src/cli.mjs kill` };
}

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
 * @param {(r: object) => void} [d.onExit]   after STOP, with stopPath's answer plus `clean` and the bids still `live`
 * @param {() => number} [d.diskFree]        bytes free on the keys folder's drive; none: not checked
 */
export function createLoop({ mode, config, params = DEFAULT_PARAMS, data, executor, exposure, risk, ledger, sets, stopRequested, readSignerOrders = () => [], now, log = () => {}, onExit = () => {}, timers = globalThis, diskFree }) {
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
    // Fills whose checks are not all done yet, by fill key: { fill, skip, tries, nextAt, reviewed }.
    unfinished: new Map(),
    snapshot: null,
    // True only when this tick's own snapshot read worked: nothing is decided or approved on an older one.
    snapshotFresh: false,
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
  /** A ledger line that must not stop what it records (a full disk): the console gets it instead. */
  function record(kind, fields) {
    try {
      return ledger.append(kind, fields);
    } catch (e) {
      log(`ledger line "${kind}" not written (${errText(e)}): ${jsonLine(fields)}`);
      return null;
    }
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

  /**
   * Screen a fill (insiders, provenance, the seller's code, OpenSea's flags). A check whose read
   * failed is tried again on later ticks, and until every check has passed no new bid is posted
   * ('checks-pending'): a token whose history could not be read could be an insider's. After
   * itemCheckRetries tries a person is told (a 'review' line), and the checks keep being tried
   * less often, until they pass or a person restarts with --ack-halt.
   */
  async function checkAndAct(fill, skip, tries = 0) {
    const key = fillKeyOf(fill);
    const res = await checkFill(fill, { sets, chain: data.chain, opensea: data.opensea, nowSec: nowSec(), provenanceDays: params.provenanceDays, skip });
    ledger.append('fill-check', { orderHash: fill.orderHash, tokenId: fill.tokenId, txHash: fill.txHash, verdict: res.verdict, findings: res.findings, integrity: res.integrity, pending: res.pending });
    if (res.stolen) ledger.append('quarantine', { slug: fill.slug, tokenId: fill.tokenId, orderHash: fill.orderHash, txHash: fill.txHash, why: 'OpenSea flags the item' });
    for (const i of res.integrity) await executor.halt(i.reason, i.detail);
    if (res.pending.length) {
      const n = tries + 1;
      const was = st.unfinished.get(key);
      const reviewed = was?.reviewed ?? false;
      if (n >= params.itemCheckRetries && !reviewed) ledger.append('review', { tokenId: fill.tokenId, txHash: fill.txHash, why: `checks not completed after ${n} tries: ${res.pending.join(', ')}; no new bid is posted until they pass or a person restarts with --ack-halt` });
      st.unfinished.set(key, { fill, skip: [...skip, ...res.passed], tries: n, nextAt: n >= params.itemCheckRetries ? now() + params.checksRetryEveryMs : 0, reviewed: reviewed || n >= params.itemCheckRetries, pending: res.pending });
    } else {
      st.unfinished.delete(key);
    }
    checksGate();
  }

  /** The 'checks-pending' gate follows the fills whose checks are unfinished. */
  function checksGate() {
    const open = [...st.unfinished.values()];
    risk.setChecksPending(open.length ? { count: open.length, detail: open.map((c) => `${COLLECTIONS[c.fill.slug]?.ticker ?? c.fill.slug} #${c.fill.tokenId} (${(c.pending ?? ['all']).join(', ')} unread)`).join('; ') } : null);
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

  const insiderWallets = () => tapeInsiders(sets);

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
      // A record only: a full disk must not end the tick before the breakers below are checked.
      record('mark', { slug, F: fv.F, S: fv.S, L: fv.L, cheapestFillable: fv.cheapestFillable, floorProxy: fv.floorProxy, n: fv.n, sellers: fv.sellers, reason: fv.reason, dropped: tape.dropped.length });
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
      risk.noteChainRead({ ok: false, at: now() });
      return null;
    }
    risk.noteChainRead({ ok: true, at: now() });
    st.snapshotFresh = true;
    for (const d of diffSnapshots(st.snapshot ?? st.restoredAdmin ?? null, snap)) await executor.halt(d.reason, d.detail);
    const before = JSON.stringify(ADMIN_FIELDS(st.snapshot ?? st.restoredAdmin), (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    const after = JSON.stringify(ADMIN_FIELDS(snap), (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    if (before !== after) record('chain', { block: snap.block, ...ADMIN_FIELDS(snap) });
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
   * the house look better funded, or its approval higher, than it is. An approval the house had
   * mined after the snapshot's block (by a post earlier in this tick) is what the allowance is
   * now, less the fills after it: the end-of-tick check must not send the same approval again.
   * Null when this tick's own snapshot read failed: nothing is approved from an older one.
   */
  function currentSnapshot() {
    const snap = st.snapshot;
    if (!snap || !st.snapshotFresh) return null;
    const fills = knownFills({ entries: ledger.read(), chainFills: [], shadow });
    const spentAfter = (block) => fills.reduce((s, f) => (f.block !== null && f.block !== undefined && Number(f.block) > block ? s + toWei(f.unitPriceWei, 'fill price') : s), 0n);
    const less = (v, by) => (v > by ? v - by : 0n);
    const newer = spentAfter(snap.block);
    let allowance = less(snap.house.allowance, newer);
    const a = executor.books?.lastApproval;
    if (a && a.block !== null && a.block !== undefined && a.block > snap.block) allowance = less(a.amountWei, spentAfter(a.block));
    if (newer === 0n && allowance === snap.house.allowance) return snap;
    return { ...snap, house: { ...snap.house, weth: less(snap.house.weth, newer), allowance } };
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
    // An approval of the house's own that the signer stopped waiting for may have been mined
    // since: its receipt says so, and at which block, before the allowance is called a mismatch.
    if (!r.ok && books.pendingApprovals?.length && typeof data.chain.receipt === 'function') {
      if (await executor.settleApprovals((txHash) => data.chain.receipt(txHash))) r = reconcile(args());
    }
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
   * bid would look like it leaves no room for itself). The room is counted as the signer counts
   * it (capUnits): a bid cancelled gaslessly still takes room until it ends, so a replacement asks
   * only for what is left, and the signer never has to refuse it.
   */
  function plan(slug, besides = null) {
    const fv = st.fv[slug];
    const own = besides ? Math.max(0, besides.qty - besides.filled) : 0;
    const p = planBid({
      slug,
      F: fv?.F ?? null,
      cheapestFillable: fv?.cheapestFillable ?? null,
      held: st.held[slug]?.size ?? 0,
      outstanding: Math.max(0, exposure.capUnits(slug, nowSec()) - own),
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
        const c = await executor.cancel(standing.orderHash, 'arbitrage-line');
        // No second bid beside one that could not be cancelled: it is asked again next tick.
        if (!c.ok) return;
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
        // The hour starts now, whether or not the replacement can post this tick.
        executor.noteReprice(slug);
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
        record('resume', { reason: e.reason, detail: e.detail });
        continue;
      }
      // Cancel first, then write it down: a full disk must not keep the cancels from going out.
      // The collection rides along, so a restart measures the next floor drop from this one.
      if (e.kind === 'market' || e.kind === 'halt') await executor.cancelAll('risk-halt');
      if (e.kind === 'cap') await executor.cancelAll('cap-reached');
      record('breaker', { breaker: e.kind, reason: e.reason, detail: e.detail, slug: e.slug ?? null });
    }
  }

  /**
   * Cancels that did not go through are asked again every tick: an order whose cancel failed
   * (the signer's pipe dropped, OpenSea and the chain both failed) is still live, and is no longer
   * the standing bid, so nothing else would look at it. A live bid above the arbitrage line that
   * is not the standing one is cancelled too.
   */
  async function retryCancels(slug) {
    const t = nowSec();
    const line = arbitrageLine(slug);
    const [standing] = exposure.active(slug, t);
    for (const o of exposure.live(t, slug)) {
      if (o.cancel?.method === 'asked') await executor.cancel(o.orderHash, o.cancel.reason);
      else if (!o.cancel && o !== standing && line !== null && o.unitPriceWei > line) await executor.cancel(o.orderHash, 'arbitrage-line');
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
    st.snapshotFresh = false;
    try {
      // A halt already under way finishes first: its kill writes STOP into the keys folder before
      // it sends anything, and STOP must then see that kill's result, not start a second one.
      while (st.pendingHalts.length) await st.pendingHalts.shift();
      if (stopRequested()) {
        log('STOP found: cancelling every house bid');
        const r = await executor.stopPath();
        const live = exposure.live(nowSec()).filter((o) => Boolean(o.shadow) === shadow);
        const s = stopSummary(r, live);
        log(s.line);
        stop();
        onExit({ ...r, clean: s.clean, live: s.clean ? [] : live.map((o) => o.orderHash) });
        return;
      }
      while (st.queue.length) {
        const ev = st.queue.shift();
        if (ev.type === 'fill') await handleFill(ev.fill);
      }
      for (const c of [...st.unfinished.values()]) if (now() >= c.nextAt) await checkAndAct(c.fill, c.skip, c.tries);

      const chainRead = (await readChain()) !== null;
      for (const slug of slugs) await readMarket(slug);

      const entries = ledger.read();
      const fills = knownFills({ entries, chainFills: [], shadow });
      const daily = dailyTotals({ entries, chainFills: [], dayMs: now(), shadow, gasPerTxWei });
      risk.evaluate({ streamLastMessageAt: data.stream?.lastMessageAt?.() ?? null, fills, daily, stolenThisMonth: stolenInMonth(entries, now(), shadow) });
      await actOnTrips(risk.takeEvents());

      // Records only, like 'mark' and 'chain': a full disk must not keep the cancels below from going out.
      for (const o of exposure.takeExpired(nowSec())) record('expiry', { orderHash: o.orderHash, slug: o.slug, filled: o.filled, qty: o.qty });
      if (shadow) for (const slug of slugs) await simulateFills(slug);

      for (const slug of Object.keys(policy.collections)) {
        try {
          await retryCancels(slug);
        } catch (e) {
          note(e, `${slug} cancels`);
        }
      }

      if (!chainRead) {
        // Blind to fills, mints and the house's own approval: nothing new is decided on old
        // numbers. After chainStaleMs of this the 'chain-stale' breaker cancels every bid.
        log('the chain snapshot was not read this tick: no new decision and no approval change');
      } else {
        for (const slug of slugs) {
          if (!policy.collections[slug].enabled && !shadow) continue;
          try {
            await decide(slug);
          } catch (e) {
            note(e, `${slug} decision`);
          }
        }
      }
      await actOnTrips(risk.takeEvents());
      // After every fill and re-price the approval comes back to its target (the chain's
      // inventory cap), here at the end of the tick, from this tick's own chain read.
      if (!shadow && chainRead) {
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
      record('error', { where: 'tick', error: errText(e) });
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
    // A ledger that cannot be written cannot record the cancels, fills and kills the bot makes.
    const disk = diskRoom(diskFree, params.minFreeDiskBytes);
    if (disk) throw new Error(`not starting: ${disk}. Free some space on that drive, then start again`);
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
    // An order already past its end, or already given its expiry line, gets no (other) expiry
    // line from this run: the report counts each order's end once.
    const expiryWritten = new Set(own.filter((e) => e.kind === 'expiry').map((e) => String(e.orderHash).toLowerCase()));
    for (const o of seeded.exposure.all()) {
      const added = exposure.add({ ...o, posted: o.posted, shadow });
      added.cancel = o.cancel;
      added.advisoryLiveUntil = o.advisoryLiveUntil;
      if (expiryWritten.has(added.orderHash) || nowSec() >= added.endTime + CLOCK_SLACK_SEC) added.expiryNoted = true;
    }
    // Every fill goes into the loop's own book through recordFill, so the book knows each fill it
    // has already counted (by transaction, order and token): a fill read again later (the books
    // re-reading the chain, or the chain watcher handing it over again) is not counted twice.
    for (const f of knownFills({ entries: own, chainFills })) exposure.recordFill(f);
    if (counter !== null) exposure.setCounter(counter);
    // A house fill the chain shows and the ledger does not (the file was restored from an older
    // copy, or the bot was down) is written back into the ledger and trades.csv (the per-NFT
    // public record), so the daily caps and the report count it: the chain is the record that
    // cannot be rolled back.
    const inLedger = new Set(knownFills({ entries, chainFills: [], shadow }).map(fillKeyOf));
    const unseen = chainFills.filter((f) => !inLedger.has(fillKeyOf(f)));
    for (const f of unseen) {
      ledger.append('fill', { ...f, reseeded: true });
      ledger.trade(f);
    }
    // Holdings: every token the house bought, from the ledger and the chain, less every one it
    // sent back to the funding wallet (what the owner does with it then is not the house's).
    for (const [slug, tokens] of Object.entries(holdingsFrom({ entries, chainFills, shadow }))) for (const id of tokens) st.held[slug]?.add(id);
    // The 5%-an-hour rise cap on fair value goes on from the last F the ledger marked (as the data
    // layer keeps it: the last F, timed at the last reading), so a restart cannot let F jump to a
    // raw figure the cap was holding back.
    for (const slug of slugs) {
      const marks = own.filter((e) => e.kind === 'mark' && e.slug === slug);
      const lastF = marks.findLast((e) => e.F !== null && e.F !== undefined);
      if (lastF) st.fvState[slug] = { version: 1, F: String(lastF.F), atSec: Math.floor(marks.at(-1).at / 1000) };
    }
    ledger.append('reseed', { orders: seeded.exposure.all().length, live: exposure.live(nowSec()).length, held: heldBySlug(), findings: seeded.findings });
    for (const f of seeded.findings) {
      if (f.code === 'unknown-fill' || f.code === 'unknown-offer' || f.code === 'overfill') await executor.halt('ledger-mismatch', f.detail);
    }
    if (!shadow && house) await checkHoldings();
    // Checks a fill never finished (the last run stopped first, or was still retrying them) keep
    // new bids closed, until they pass or a person who looked restarts with --ack-halt.
    const lastCheck = new Map();
    for (const e of own) {
      if (e.kind === 'fill-check') lastCheck.set(fillKeyOf(e), e);
      if (e.kind === 'ack-checks') for (const k of e.fills ?? []) lastCheck.set(k, { acked: true });
    }
    for (const f of knownFills({ entries: own })) {
      const c = lastCheck.get(fillKeyOf(f));
      if (!c || (!c.acked && c.pending?.length)) st.unfinished.set(fillKeyOf(f), { fill: f, skip: [], tries: 0, nextAt: 0, reviewed: false, pending: c?.pending ?? null });
    }
    if (ackHalt && st.unfinished.size) {
      ledger.append('ack-checks', { fills: [...st.unfinished.keys()] });
      log(`unfinished fill checks acknowledged by a person: ${[...st.unfinished.values()].map((c) => `${c.fill.slug} #${c.fill.tokenId}`).join(', ')}`);
      st.unfinished.clear();
    }
    checksGate();
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
        const sorted = [...moves].sort((a, b) => (toSec(a.time) ?? 0) - (toSec(b.time) ?? 0));
        // What happened to the token after the house last received it.
        const after = sorted.slice(sorted.findLastIndex((m) => addr(m.to) === house) + 1);
        if (!after.length) continue; // still the house's (or nothing read at all)
        // Back to the funding wallet is the one way out the signer allows (returnNftToFunding).
        // Whatever happens to the token after that (the owner sells it) is no longer the house's.
        const back = after.find((m) => addr(m.from) === house && addr(m.to) === policy.fundingWallet);
        if (back) {
          set.delete(tokenId);
          ledger.append('nft-returned', { slug, tokenId, to: addr(back.to), txHash: back.txHash, time: toSec(back.time) });
          continue;
        }
        // Anywhere else, the books are wrong or the key is not ours alone. It stays counted as
        // held (less room, never more) until a person has looked.
        const out = after[0];
        await executor.halt('ledger-mismatch', `${COLLECTIONS[slug]?.ticker ?? slug} #${tokenId} left the house (to ${addr(out.to)}, tx ${out.txHash}) with no ledger line`);
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
      chainStale: rs.chainStale,
      checksPending: rs.checksPending,
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
