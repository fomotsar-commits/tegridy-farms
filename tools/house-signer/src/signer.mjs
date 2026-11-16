// The signing service: holds the decrypted house key and answers the six requests of the
// IPC protocol (BUILD-SPEC section 2.3): hello, signBid, signCancel, sendTx, kill, status.
//
// Every answer is { ok: true, id, ... } or { ok: false, id, field, reason }. Every request
// and every decision is written to signer-audit.jsonl. The key never leaves this closure:
// it is not returned, logged, written or passed to anything but signDigest/signTx.
//
// STOP: while any file whose name starts with "stop" (any letter case: STOP, STOP.txt,
// stop-now, and the STOP.txt.txt Windows Explorer makes when it hides extensions) is in the
// keys folder, nothing new is signed or sent. Cancels, revokes, returns to the funding wallet
// and the kill still work; the kill writes STOP itself before it sends anything. The folder is
// watched with fs.watch so the log notices at once, and it is read again right before every
// signature, so a watch that misses an event cannot let a bid through.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BROADCAST_WINDOW_MS, CHAIN_ID } from './constants.mjs';
import { cancelDigest, orderDigest, SEAPORT_DOMAIN } from './eip712.mjs';
import { isLoopbackUrl } from './chain.mjs';
import { openLedger } from './ledger.mjs';
import { buildBidOrder, toJsonParameters } from './order.mjs';
import {
  checkBidOrder, checkBidRequest, checkCancelRequest, checkTx, checkTxRequest, normalFeeCap, reducesRisk,
} from './policy.mjs';
import { addressOf, signDigest } from './sign.mjs';
import { buildCall, gasLimitFor, signTx } from './tx.mjs';
import { bytesToBigint, eqAddr, isPlainObject } from './hex.mjs';

/** STOP is there, or the keys folder cannot be read (no proof the owner did not ask to stop). */
export function stopFilePresent(keysDir) {
  let names;
  try {
    names = fs.readdirSync(keysDir);
  } catch {
    return true;
  }
  return names.some((name) => name.toLowerCase().startsWith('stop'));
}

// The most pending house transactions the kill replaces with extra revokes. A node keeps about
// 16 pending per account; an endpoint that reports far more (a bug, or a lie) must not make the
// kill build or sign without end. A larger count is reported in the kill's answer instead.
export const KILL_MAX_PENDING = 16;

const padded = (steps, pendingCount) => {
  const out = [...steps];
  while (out.length < Math.min(pendingCount, KILL_MAX_PENDING)) out.push({ kind: 'revokeWeth', padding: true });
  return out;
};

/**
 * The kill, in order: stop WETH from moving (revoke the conduit's allowance), cancel every
 * Seaport order at once (bump the counter), then take back NFT approval for every enabled
 * collection. If more house transactions are pending than that, extra revokes follow so
 * every pending nonce is replaced (up to KILL_MAX_PENDING): otherwise a pending approval
 * could land after the revoke.
 */
export function killPlan(policy, pendingCount = 0) {
  const steps = [{ kind: 'revokeWeth' }, { kind: 'incrementCounter' }];
  for (const [slug, c] of Object.entries(policy.collections)) {
    if (c.enabled) steps.push({ kind: 'setNftApproval', slug, collection: c.address, approved: false });
  }
  return padded(steps, pendingCount);
}

// A bid counts against the inventory cap until a minute after its end time: a block's clock is
// not this PC's clock. Normal transactions count against the daily budget for 24 hours.
const ENDED_SLACK_SEC = 60;
const DAY_MS = 24 * 3600 * 1000;
const lowest = (xs) => xs.reduce((a, b) => (b < a ? b : a));
const highest = (xs) => xs.reduce((a, b) => (b > a ? b : a));

// A node that already holds this exact transaction answers with one of these: not a refusal.
const ALREADY_KNOWN = /already known|known transaction|already imported/i;

export function createSigner({
  privateKey,
  policy,
  policySha256,
  keysDir,
  chain,
  sendUrls,
  mode = 'live',
  pinCommit = null,
  version = '1.0.0',
  nowMs = () => Date.now(),
  randomBytes = crypto.randomBytes,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollMs = 2000,
  windowMs = BROADCAST_WINDOW_MS,
  watch = true,
  log = () => {},
}) {
  if (mode !== 'live' && mode !== 'dev') throw new Error('mode must be live or dev');
  const house = addressOf(privateKey);
  if (!eqAddr(house, policy.house)) throw new Error(`the keystore holds ${house}, but policy.house is ${policy.house}`);
  const ledger = openLedger(keysDir, { now: nowMs });
  const { orders, skipped } = ledger.loadOrders(house);
  if (skipped > 0) log(`signer-orders.jsonl: ${skipped} line(s) did not check out and were ignored`);

  let stopSeen = stopFilePresent(keysDir);
  let watcher = null;
  if (watch) {
    try {
      watcher = fs.watch(keysDir, () => {
        const now = stopFilePresent(keysDir);
        if (now !== stopSeen) {
          stopSeen = now;
          log(now ? 'STOP file found: nothing new will be signed' : 'STOP file removed');
          try {
            ledger.audit({ event: 'stop', stopped: now });
          } catch { /* the per-signature re-check below still holds */ }
        }
      });
    } catch {
      log('could not watch the keys folder; STOP is still checked before every signature');
    }
  }
  // Set when a kill could not write its STOP file: this signer then stops anyway, until restarted.
  let killLatched = false;
  // Set by close(): from then on only a kill is answered.
  let closing = false;
  // Authoritative: reads the folder every time, whatever the watcher saw.
  const stopped = () => {
    stopSeen = stopFilePresent(keysDir);
    return stopSeen || killLatched;
  };
  const nowSec = () => Math.floor(nowMs() / 1000);
  const refuse = (id, field, reason) => ({ ok: false, id, field, reason });

  const sendAllowed = () => Array.isArray(sendUrls) && sendUrls.length > 0 && (mode === 'live' || sendUrls.every(isLoopbackUrl));
  const DEV_SEND_REASON = 'dev mode only sends to a local test chain (127.0.0.1 or localhost), and HOUSE_SEND_URLS names another host or is empty';

  // Transactions this signer sent and has not yet seen mined: nonce -> { hash, raw, sentAt }.
  const own = new Map();
  // One at a time: transactions (so two never take the same nonce or the same daily budget)
  // and bids (so two never count the same room under the inventory cap).
  const serial = () => {
    let lock = Promise.resolve();
    return (fn) => {
      const run = lock.then(fn, fn);
      lock = run.catch(() => {});
      return run;
    };
  };
  const withTxLock = serial();
  const withBidLock = serial();

  // Normal transactions signed in the last 24 hours and the most each could cost in gas
  // (limit x max fee): the daily budget. The kill is never counted or held back.
  const sends = [];
  const recentSends = () => {
    while (sends.length > 0 && nowMs() - sends[0].at >= DAY_MS) sends.shift();
    return sends;
  };

  /**
   * NFTs of `collection` the house's own open bids can still buy: every order this signer
   * signed at the current counter that has not ended and is not cancelled on chain, less what
   * Seaport says is filled. A gasless cancel is OpenSea's word, which this signer cannot
   * check, so such an order counts until it ends. Read from the signed components only (they
   * hash to the order hash), never the ledger line's other fields, which an edit could change.
   */
  async function openUnits(collection, counter) {
    const live = [...orders.values()].filter((o) => {
      const c = o.components;
      return eqAddr(c.consideration[0]?.token, collection) && c.endTime + BigInt(ENDED_SLACK_SEC) > BigInt(nowSec()) && c.counter === counter;
    });
    const statuses = await Promise.all(live.map((o) => chain.orderStatus(o.orderHash)));
    let open = 0n;
    live.forEach((o, i) => {
      const s = statuses[i];
      if (s.isCancelled) return;
      const qty = o.components.consideration[0].startAmount;
      // Seaport keeps the filled share as totalFilled / totalSize; what is left rounds up.
      open += s.totalSize === 0n ? qty : (qty * (s.totalSize - s.totalFilled) + s.totalSize - 1n) / s.totalSize;
    });
    return open;
  }

  /** The most an approval may allow: per enabled collection, the NFTs still under its cap at its price ceiling. */
  async function approveRoom() {
    const enabled = Object.values(policy.collections).filter((c) => c.enabled);
    const held = await Promise.all(enabled.map((c) => chain.nftBalance(c.address, house)));
    return enabled.reduce((room, c, i) => {
      const left = BigInt(c.inventoryCap) - held[i];
      return left > 0n ? room + left * c.maxUnitPriceWei : room;
    }, 0n);
  }

  // --- signBid --------------------------------------------------------------------------
  async function signBid(req, id) {
    const r = checkBidRequest(req, { policy, nowSec: nowSec(), stopped: stopped() });
    if (!r.ok) return refuse(id, r.field, r.reason);
    return withBidLock(() => signCheckedBid(r, id));
  }

  async function signCheckedBid(r, id) {
    let counter;
    let code;
    try {
      [counter, code] = await Promise.all([chain.counter(house), chain.code(house)]);
    } catch (e) {
      return refuse(id, e.kind === 'disagree' ? 'counter' : 'rpc', `could not read the house's Seaport counter (${e.message})`);
    }
    if (code !== '0x') return refuse(id, 'P2.code', 'the house address has code on chain (an EIP-7702 delegation?), so Seaport would not treat its signatures as plain signatures; nothing is signed'); // PIN:P2.code
    // The inventory cap, on what the chain says: NFTs held, plus what open bids can still buy, plus this bid.
    const c = policy.collections[r.slug];
    let held;
    let open;
    try {
      [held, open] = await Promise.all([chain.nftBalance(c.address, house), openUnits(c.address, counter)]);
    } catch (e) {
      return refuse(id, e.kind === 'disagree' ? 'inventory' : 'rpc', `could not read what the house holds and has open in ${r.slug} (${e.message})`);
    }
    if (held + open + BigInt(r.qty) > BigInt(c.inventoryCap)) return refuse(id, 'P8.cap', `the house holds ${held} and its open bids can still buy ${open}; ${r.qty} more could pass ${r.slug}'s inventoryCap of ${c.inventoryCap}`); // PIN:P8.cap
    // Seaport bumps a counter by a quasi-random amount (the previous block hash), so an
    // order signed for a counter the house does not have yet cannot be made valid later.
    const salt = bytesToBigint(randomBytes(32));
    const order = buildBidOrder({
      policy, slug: r.slug, qty: r.qty, unitPriceWei: r.unitPriceWei, startTime: r.startTime, endTime: r.endTime, nftLine: r.nftLine, house, salt, counter,
    });
    const v = checkBidOrder(order, { policy, house, domain: SEAPORT_DOMAIN, slug: r.slug, nftLine: r.nftLine, salt, counter, nowSec: nowSec() });
    if (!v.ok) return refuse(id, v.field, v.reason);
    const { orderHash, digest } = orderDigest(order);
    if (stopped()) return refuse(id, 'P15.sign', 'a STOP file appeared while the bid was being prepared; nothing was signed'); // PIN:P15.sign
    const sig = signDigest({ digest, privateKey, expected: house });
    if (!sig.ok) return refuse(id, sig.field, sig.reason);
    const parameters = toJsonParameters(order);
    try {
      ledger.recordOrder({ orderHash, slug: r.slug, qty: r.qty, unitPriceWei: r.unitPriceWei.toString(), endTime: r.endTime, counter: counter.toString(), parameters });
    } catch {
      return refuse(id, 'L.order', 'the order could not be written to signer-orders.jsonl, so its signature is not returned (an unrecorded order could not be cancelled later)'); // PIN:L.order
    }
    orders.set(orderHash, { orderHash, slug: r.slug, qty: r.qty, unitPriceWei: r.unitPriceWei.toString(), endTime: r.endTime, components: order });
    return { ok: true, id, orderHash, signature: sig.signature, parameters, counter: counter.toString() };
  }

  // --- signCancel -----------------------------------------------------------------------
  function signCancel(req, id) {
    const r = checkCancelRequest(req, { knownOrders: orders });
    if (!r.ok) return refuse(id, r.field, r.reason);
    const sig = signDigest({ digest: cancelDigest(r.orderHash), privateKey, expected: house });
    if (!sig.ok) return refuse(id, sig.field, sig.reason);
    return { ok: true, id, signature: sig.signature };
  }

  // --- transactions ---------------------------------------------------------------------
  async function nextNonce() {
    const [latest, pending] = await Promise.all([chain.nonce(house, 'latest'), chain.nonce(house, 'pending')]);
    let next = pending > latest ? pending : latest;
    for (const [n, t] of own) {
      if (n < latest) {
        own.delete(n);
        continue;
      }
      // A transaction no longer being re-sent may have been dropped; do not queue behind it.
      if (nowMs() - t.sentAt > windowMs) continue;
      if (n + 1n > next) next = n + 1n;
    }
    return next;
  }

  async function normalFees() {
    const base = await chain.nextBaseFee();
    const tip = policy.gas.priorityWei;
    const cap = normalFeeCap(policy);
    const want = base * 2n + tip;
    return { maxFeePerGas: want > cap ? cap : want, maxPriorityFeePerGas: tip };
  }

  async function prepareAndSend(plan, { kill, nonce: fixedNonce }) {
    const call = buildCall(plan, { policy, house });
    let nonce = fixedNonce;
    let fees;
    try {
      if (nonce === undefined) nonce = await nextNonce();
      // A kill spends the whole fee cap and the kill tip; normal transactions stay inside a
      // share of the cap, so a kill always out-prices whatever it has to replace.
      fees = kill ? { maxFeePerGas: policy.gas.maxFeeWei, maxPriorityFeePerGas: policy.gas.killPriorityWei } : await normalFees();
    } catch (e) {
      return { ok: false, field: 'rpc', reason: `could not read the nonce or fees (${e.message})` };
    }
    const tx = { type: 2, chainId: CHAIN_ID, nonce, ...fees, gas: gasLimitFor(plan), to: call.to, value: call.value, data: call.data, accessList: [] };
    const v = checkTx(tx, { policy, house, plan, kill });
    if (!v.ok) return v;
    const cost = tx.gas * tx.maxFeePerGas;
    if (!kill && recentSends().length + 1 > policy.daily.maxTxs) return { ok: false, field: 'T.dailyTxs', reason: `${policy.daily.maxTxs} transactions have gone out in the last 24 hours, the policy's daily most (the kill is never held back)` }; // PIN:T.dailyTxs
    if (!kill && recentSends().reduce((sum, s) => sum + s.costWei, cost) > policy.daily.maxGasWei) return { ok: false, field: 'T.dailyGas', reason: `this transaction could take the last 24 hours' gas past policy.daily.maxGasWei (${policy.daily.maxGasWei} wei; the kill is never held back)` }; // PIN:T.dailyGas
    if (!kill) {
      try {
        await chain.simulate({ from: house, to: tx.to, data: tx.data, value: tx.value });
      } catch (e) {
        return { ok: false, field: 'simulation', reason: `the transaction would fail on chain (${e.message})` };
      }
    }
    if (!kill && !reducesRisk(plan) && stopped()) return { ok: false, field: 'T.stopSign', reason: 'a STOP file appeared; nothing new is sent' }; // PIN:T.stopSign
    const signed = signTx(tx, privateKey, house);
    if (!signed.ok) return signed;
    if (!kill) sends.push({ at: nowMs(), costWei: cost });
    const results = await chain.broadcast(signed.raw);
    const accepted = results.filter((x) => x.ok || ALREADY_KNOWN.test(x.message ?? ''));
    try {
      ledger.audit({ event: 'tx', kind: plan.kind, nonce: nonce.toString(), txHash: signed.hash, accepted: accepted.length, endpoints: results.map((x) => ({ host: x.host, ok: x.ok, ...(x.ok ? {} : { message: x.message }) })) });
    } catch { /* the decision line still records the hash */ }
    if (accepted.length === 0 && !kill) {
      return { ok: false, field: 'broadcast', reason: `every send endpoint refused the transaction: ${results.map((x) => `${x.host}: ${x.message}`).join('; ') || 'no endpoints'}` };
    }
    own.set(nonce, { hash: signed.hash, raw: signed.raw, sentAt: nowMs() });
    return { ok: true, hash: signed.hash, raw: signed.raw, nonce, kind: plan.kind, slug: plan.slug, addsRisk: !reducesRisk(plan) };
  }

  /** Re-send every block until each is mined or the window passes. */
  async function waitMined(sent) {
    const deadline = nowMs() + windowMs;
    const state = sent.map((s) => ({ ...s, done: false, status: 'pending' }));
    let lastBlock = null;
    const settle = async (s) => {
      let r = null;
      try {
        r = await chain.receipt(s.hash);
      } catch { /* try again next round */ }
      if (r) {
        Object.assign(s, { done: true, status: 'mined', blockNumber: Number(r.blockNumber), success: r.status === 'success' });
        own.delete(s.nonce);
      }
      return r;
    };
    for (;;) {
      for (const s of state) if (!s.done) await settle(s);
      if (state.every((s) => s.done) || nowMs() >= deadline) break;
      let block = null;
      try {
        block = await chain.blockNumber();
      } catch { /* keep waiting */ }
      if (block !== null && lastBlock !== null && block !== lastBlock) {
        for (const s of state) {
          if (s.done) continue;
          // Under STOP a transaction that adds risk (an approval, a wrap) is no longer pushed.
          if (s.addsRisk && stopped()) continue; // PIN:T.stopResend
          await chain.broadcast(s.raw);
        }
        let latest = null;
        try {
          // The lowest any endpoint reports: one endpoint alone cannot mark a transaction replaced.
          latest = lowest(await chain.nonces(house, 'latest'));
        } catch { /* keep waiting */ }
        for (const s of state) {
          // Its nonce is used and it has no receipt: something else took that nonce.
          if (!s.done && latest !== null && latest > s.nonce && !(await settle(s))) Object.assign(s, { done: true, replaced: true });
        }
      }
      if (block !== null) lastBlock = block;
      if (state.every((s) => s.done)) break;
      await sleep(pollMs);
    }
    return state;
  }

  const txView = (s) => ({
    kind: s.kind,
    ...(s.slug ? { slug: s.slug } : {}),
    nonce: Number(s.nonce),
    txHash: s.hash,
    status: s.status,
    ...(s.blockNumber !== undefined ? { blockNumber: s.blockNumber, success: s.success } : {}),
    ...(s.replaced ? { replaced: true } : {}),
  });

  async function sendTx(req, id) {
    const r = checkTxRequest(req, { policy, stopped: stopped(), knownOrders: orders });
    if (!r.ok) return refuse(id, r.field, r.reason);
    if (!sendAllowed()) return refuse(id, 'D.send', DEV_SEND_REASON); // PIN:D.send
    if (r.plan.kind === 'approveWeth') {
      let room;
      try {
        room = await approveRoom();
      } catch (e) {
        return refuse(id, e.kind === 'disagree' ? 'inventory' : 'rpc', `could not read what the house holds (${e.message})`);
      }
      if (r.plan.amount > room) return refuse(id, 'T.approveRoom', `the approval is above ${room} wei: the NFTs the house may still buy under its inventory caps, at their price ceilings`); // PIN:T.approveRoom
    }
    const first = await withTxLock(() => prepareAndSend(r.plan, { kill: false }));
    if (!first.ok) return refuse(id, first.field, first.reason);
    const [w] = await waitMined([first]);
    const view = txView(w);
    delete view.kind;
    return { ok: true, id, ...view };
  }

  /** One round of the kill: send `steps` from the lowest pending nonce up, then wait. */
  async function killRound(stepsFor) {
    const sent = await withTxLock(async () => {
      let latest;
      try {
        // The lowest "latest" any endpoint reports: a nonce that is too low is refused and sent
        // again next round, while one too high would wait behind a nonce gap for ever.
        latest = lowest(await chain.nonces(house, 'latest'));
      } catch (e) {
        return { error: `could not read the house nonce (${e.message})` };
      }
      let top = latest;
      try {
        const pending = highest(await chain.nonces(house, 'pending'));
        if (pending > top) top = pending;
      } catch { /* the kill still replaces the lowest nonce */ }
      for (const [n, t] of own) if (n >= latest && nowMs() - t.sentAt <= windowMs && n + 1n > top) top = n + 1n;
      // The first kill transaction takes the lowest pending nonce (latest), replacing
      // whatever is waiting there; each later one takes the next.
      const steps = stepsFor(Number(top - latest));
      const out = [];
      let nonce = latest;
      for (const step of steps) {
        const res = await prepareAndSend(step, { kill: true, nonce });
        out.push(res.ok ? { ...res, step } : { ...res, kind: step.kind, slug: step.slug });
        if (res.ok) nonce += 1n;
      }
      return { out, pending: top - latest };
    });
    if (sent.error) return sent;
    const waited = await waitMined(sent.out.filter((s) => s.ok));
    return { waited, failed: sent.out.filter((s) => !s.ok), pending: sent.pending };
  }

  async function kill(id) {
    // The kill latches before it sends anything: with STOP in the keys folder, this signer and
    // any other on the same folder sign no new bid, approval or wrap until the owner deletes it.
    try {
      fs.writeFileSync(path.join(keysDir, 'STOP'), `written by the kill at ${new Date(nowMs()).toISOString()}; delete this file to let the signer sign bids and approvals again\n`, { flag: 'a' }); // PIN:T.killStop
    } catch {
      killLatched = true;
      log('the kill could not write STOP into the keys folder; this signer refuses new bids, approvals and wraps until it is restarted');
    }
    if (!sendAllowed()) return refuse(id, 'D.kill', DEV_SEND_REASON); // PIN:D.kill
    const txs = [];
    let failed = [];
    let pendingSeen = 0n;
    const last = new Map(); // each kill step -> its latest attempt
    let stepsFor = (pendingCount) => killPlan(policy, pendingCount);
    // A kill transaction whose nonce was taken by a transaction already in flight (mined
    // first) did not happen, so it is sent again with a fresh nonce: a revoke that "lost the
    // race" to a pending approval must still land after it. At most three rounds.
    for (let round = 0; round < 3; round++) {
      const r = await killRound(stepsFor);
      if (r.error) return refuse(id, 'rpc', r.error);
      txs.push(...r.waited.map(txView));
      failed = failed.concat(r.failed);
      if (r.pending > pendingSeen) pendingSeen = r.pending;
      for (const s of r.waited) last.set(s.step, s);
      const lost = r.waited.filter((s) => s.replaced).map((s) => s.step);
      if (lost.length === 0) break;
      stepsFor = (pendingCount) => padded(lost, pendingCount);
    }
    // A step happened only if its last attempt was mined and succeeded. One whose nonce was
    // taken in every round, or that reverted, never happened, whatever the other steps did.
    const never = [...last.values()].filter((s) => s.replaced || (s.status === 'mined' && !s.success));
    const problems = [];
    if (failed.length > 0) problems.push(`${failed.length} kill transaction(s) could not be built: ${failed.map((f) => `${f.kind}: ${f.reason}`).join('; ')}`);
    if (never.length > 0) problems.push(`${never.map((s) => `${s.kind} (nonce ${s.nonce}, ${s.replaced ? 'its nonce taken by another transaction in every round' : 'reverted'})`).join(', ')} never took effect`);
    if (pendingSeen > BigInt(KILL_MAX_PENDING)) problems.push(`the read endpoints report ${pendingSeen} pending house transactions, more than the ${KILL_MAX_PENDING} the kill replaces, so the rest could still land: check the endpoints, then run the kill again`);
    if (problems.length > 0) return { ok: false, id, field: 'kill', reason: problems.join('; '), txs, allMined: false };
    return { ok: true, id, txs, allMined: [...last.values()].every((s) => s.status === 'mined' && s.success) };
  }

  async function status(id) {
    try {
      const [latest, counter, weth, allowance] = await Promise.all([
        chain.nonce(house, 'latest'), chain.counter(house), chain.wethBalance(house), chain.wethAllowance(house),
      ]);
      return {
        ok: true, id, house, stopped: stopped(), lastNonce: latest > 0n ? Number(latest - 1n) : null, counter: counter.toString(), wethBalance: weth.toString(), wethAllowance: allowance.toString(),
      };
    } catch (e) {
      return refuse(id, 'rpc', `could not read the chain (${e.message})`);
    }
  }

  // --- dispatch -------------------------------------------------------------------------
  async function handle(req) {
    const id = isPlainObject(req) && typeof req.id === 'string' && req.id.length > 0 && req.id.length <= 128 ? req.id : null;
    const op = isPlainObject(req) && typeof req.op === 'string' ? req.op : null;
    try {
      ledger.audit({ event: 'request', id, op, request: req });
    } catch {
      if (op !== 'kill') return refuse(id, 'A.request', 'signer-audit.jsonl could not be written, so nothing is signed or sent (the kill still works)'); // PIN:A.request
    }
    let res;
    try {
      if (id === null) res = refuse(null, 'id', 'every request needs an id: a string of 1 to 128 characters');
      else if (closing && op !== 'kill') res = refuse(id, 'S.closing', 'the signer is shutting down: it signs and sends nothing more (a kill still runs)'); // PIN:S.closing
      else if (op === 'hello') res = { ok: true, id, house, policySha256, version, stopped: stopped(), pinCommit, mode };
      else if (op === 'signBid') res = await signBid(req, id);
      else if (op === 'signCancel') res = signCancel(req, id);
      else if (op === 'sendTx') res = await sendTx(req, id);
      else if (op === 'kill') res = await kill(id);
      else if (op === 'status') res = await status(id);
      else res = refuse(id, 'op', 'op must be hello, signBid, signCancel, sendTx, kill or status');
    } catch (e) {
      res = refuse(id, 'internal', `the signer hit an unexpected error (${String(e?.message ?? e).slice(0, 200)})`);
    }
    try {
      const { ok, field, reason } = res;
      ledger.audit({
        event: 'decision', id, op, ok,
        ...(ok ? { result: { orderHash: res.orderHash, txHash: res.txHash, status: res.status, txs: res.txs?.map((t) => ({ kind: t.kind, txHash: t.txHash, status: t.status })) } } : { field, reason }),
      });
    } catch {
      log('signer-audit.jsonl could not be written for a decision');
    }
    return res;
  }

  return {
    house,
    handle,
    close() {
      closing = true;
      watcher?.close();
    },
  };
}
