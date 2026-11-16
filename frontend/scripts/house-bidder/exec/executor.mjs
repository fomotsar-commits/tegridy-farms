// The executor: the only part of the bot that acts. It posts, cancels, re-prices, approves and
// kills, always in this order and always through the signer (the bot never holds the key and
// never builds a transaction):
//
//   post      OpenSea build -> check the build against the pinned shape (halt on any
//             difference) -> fund it (approve the WETH it needs) -> signBid over the pipe ->
//             verify the signature independently -> post to OpenSea -> ledger.
//             STOP and the breakers are checked again right before the signature and the post.
//   cancel    signCancel -> OpenSea gasless cancel -> record when OpenSea's last fill signature
//             expires; refused or failing -> cancel on chain. Every cancel has a closed-list reason.
//   kill      the signer's kill: approval to zero, counter bump, NFT approvals off. Waits for it.
//   STOP      gasless-cancel everything, read every answer, and kill if any cancel was refused or
//             a 5-minute tail is still open.
//
// Any refusal from the signer halts the bot: the signer refuses only what breaks a pin, so a
// refusal means something tried to make the house sign what it must not.

import { allowanceTarget, fundingNeeded } from '../brain/exposure.mjs';
import { DEFAULT_PARAMS } from '../brain/params.mjs';
import { toSec } from '../brain/util.mjs';
import { checkBuild, verifySignedBid } from './verify.mjs';

/** Why a bid was cancelled early. Closed list (BUILD-SPEC 3.5 step 6); the report counts them. */
export const CANCEL_REASONS = Object.freeze(['fair-value-moved', 'arbitrage-line', 'cap-reached', 'risk-halt', 'error', 'key-rotation', 'stop']);

/** Why the executor did not post. Not a breaker: the next tick tries again. */
export const HOLD_REASONS = Object.freeze([
  'stop',
  'gate',
  'already-bidding',
  'build-failed',
  'unfunded',
  'over-allowance-cap',
  'approval-pending',
  'signer-unavailable',
  'verify-unavailable',
  'post-failed',
  'halted',
]);

const errText = (e) => (e?.kind ? `${e.kind}${e.status ? ` ${e.status}` : ''}: ${e.message ?? ''}` : e?.message ?? String(e));
/**
 * An OpenSea error that proves the order was NOT stored: turned away for rate, or refused as
 * invalid or unauthorised. Anything else (a timeout, a 5xx, a 409, an answer of the wrong shape)
 * leaves it unknown, and an order that may be stored is treated as live.
 */
const definitelyRefused = (e) => e?.kind === 'rate' || (e?.kind === 'http' && [400, 401, 403, 404, 422].includes(Number(e.status)));

/**
 * @param {object} d
 * @param {string} d.house
 * @param {object} d.policy          validated policy (brain/config.mjs)
 * @param {object} [d.params]
 * @param {object} d.opensea         data layer client (2.4)
 * @param {object} d.signer          signer client (2.3)
 * @param {(components: object) => Promise<string>} d.getOrderHash  Seaport 1.6 getOrderHash over eth_call
 * @param {object} d.exposure        brain/exposure.mjs
 * @param {object} d.risk            brain/risk.mjs
 * @param {object} d.ledger          exec/ledger.mjs
 * @param {() => boolean} d.stopRequested
 * @param {() => number} d.now       milliseconds
 */
export function createExecutor({ house, policy, params = DEFAULT_PARAMS, opensea, signer, getOrderHash, exposure, risk, ledger, stopRequested, now, log = () => {} }) {
  const books = { lastApproval: null, ownTxs: [], counterBumpPending: false, lastReprice: {}, killed: null };
  let halting = false;
  const nowSec = () => Math.floor(now() / 1000);

  async function onRefusal(op, resp) {
    ledger.append('refusal', { op, field: resp?.field ?? null, reason: resp?.reason ?? null });
    log(`the signer refused ${op} (${resp?.field ?? '?'}): ${resp?.reason ?? 'no reason given'}`);
    await halt('signer-refusal', `${op}: ${resp?.field ?? '?'}: ${resp?.reason ?? 'no reason given'}`);
  }

  async function sendTx(kind, txParams, why) {
    let r;
    try {
      r = await signer.sendTx(kind, txParams);
    } catch (e) {
      ledger.append('tx-failed', { txKind: kind, why, error: errText(e) });
      return { ok: false, why: 'signer-unavailable' };
    }
    if (r.ok !== true) {
      await onRefusal(`sendTx ${kind}`, r);
      return { ok: false, why: 'refused' };
    }
    ledger.append('tx', { txKind: kind, why, txHash: r.txHash, status: r.status, blockNumber: r.blockNumber ?? null, gasCostWei: r.gasCostWei ?? null });
    return { ok: true, ...r };
  }

  /** Set the WETH approval to the conduit. Zero is a revoke. */
  async function setAllowance(amountWei, why) {
    const r = amountWei === 0n ? await sendTx('revokeWeth', {}, why) : await sendTx('approveWeth', { amountWei: amountWei.toString() }, why);
    if (!r.ok) return r;
    if (r.status === 'mined') {
      books.lastApproval = { amountWei, block: r.blockNumber ?? null };
      ledger.append('approve', { amountWei, txHash: r.txHash, block: r.blockNumber ?? null, why });
    }
    return r;
  }

  /**
   * Keep the approval at the target (exposure.mjs allowanceTarget): raise it when live orders
   * need more than it allows, cut it when it would let the house buy one NFT more than its room,
   * and revoke it when no collection has room. Small moves are left alone so a price that moves
   * a little each minute does not cost a transaction each minute.
   */
  async function syncAllowance({ snapshot, heldBySlug, standing = {}, why }) {
    if (!snapshot) return { changed: false };
    const t = nowSec();
    const { target, minPrice } = allowanceTarget({ policy, exposure, heldBySlug, nowSec: t, standing });
    const current = snapshot.house.allowance;
    const need = fundingNeeded({ exposure, nowSec: t });
    let to = null;
    if (current < need && target >= need) to = target;
    else if (target === 0n && current > 0n) to = 0n;
    else if (minPrice !== null && current >= target + minPrice) to = target;
    if (to === null || to === current) return { changed: false, target };
    if (to > policy.maxAllowanceWei) {
      ledger.append('decision', { action: 'hold-allowance', why: `the target ${to} is over policy.maxAllowanceWei` });
      return { changed: false, target };
    }
    const r = await setAllowance(to, why);
    return { changed: r.ok, target, tx: r };
  }

  /**
   * Post one bid. `plan` is the planner's answer; `ctx` the tick's chain snapshot and holdings.
   * @returns {Promise<{ posted: true, orderHash: string } | { posted: false, why: string, detail?: string }>}
   */
  const lastHold = {};
  async function post(plan, { snapshot, heldBySlug, reprice = false }) {
    const { slug } = plan;
    const hold = (why, detail) => {
      // A hold that repeats every minute (no WETH yet, a closed gate) is one ledger line, not 1,440 a day.
      const key = `${why}|${detail ?? ''}`;
      if (lastHold[slug] !== key) ledger.append('decision', { slug, action: 'hold', why, detail: detail ?? null, unitPriceWei: plan.unitPriceWei, qty: plan.qty });
      lastHold[slug] = key;
      return { posted: false, why, detail };
    };
    if (stopRequested()) return hold('stop');
    let gate = risk.gate();
    if (!gate.canPost) return hold('gate', gate.reason);
    const qty = Math.min(plan.qty, gate.maxQty ?? plan.qty);
    const unitPriceWei = plan.unitPriceWei;
    if (exposure.active(slug, nowSec()).length) return hold('already-bidding');

    let build;
    try {
      build = await opensea.buildCollectionOffer({ offerer: house, slug, qty });
    } catch (e) {
      return hold('build-failed', errText(e));
    }
    const bc = checkBuild(build, { slug, qty, house });
    if (!bc.ok) {
      await halt('build-mismatch', bc.problems.join('; '));
      return { posted: false, why: 'halted', detail: bc.problems.join('; ') };
    }

    // Funded before it is signed: the WETH must be there, and the approval must cover it.
    const t = nowSec();
    const need = fundingNeeded({ exposure, nowSec: t, extra: { qty, unitPriceWei } });
    if (!snapshot || snapshot.house.weth < need) return hold('unfunded', `the house holds ${snapshot?.house.weth ?? 'unknown'} wei of WETH; its bids need ${need}`);
    const { target } = allowanceTarget({ policy, exposure, heldBySlug, nowSec: t, standing: { [slug]: unitPriceWei } });
    if (target > policy.maxAllowanceWei) return hold('over-allowance-cap', `the approval would be ${target}, over policy.maxAllowanceWei ${policy.maxAllowanceWei}`);
    if (snapshot.house.allowance < need) {
      const a = await setAllowance(target, 'post');
      if (!a.ok) return a.why === 'refused' ? { posted: false, why: 'halted' } : hold(a.why);
      if (a.status !== 'mined') return hold('approval-pending', a.txHash);
    }

    // Last look before the signature.
    if (stopRequested()) return hold('stop');
    gate = risk.gate();
    if (!gate.canPost) return hold('gate', gate.reason);

    const startTime = nowSec();
    const endTime = startTime + Math.min(params.bidLifetimeSec, policy.maxLifetimeSec);
    const request = { slug, qty, unitPriceWei, startTime, endTime, build };
    let resp;
    try {
      resp = await signer.signBid(request);
    } catch (e) {
      return hold('signer-unavailable', errText(e));
    }
    if (resp.ok !== true) {
      await onRefusal('signBid', resp);
      return { posted: false, why: 'halted' };
    }
    // Signed is exposure, posted or not: from here the order counts until it provably ends.
    exposure.add({ orderHash: resp.orderHash, slug, qty, unitPriceWei, startTime, endTime, counter: resp.counter, posted: false, signedAt: now() });
    ledger.append('signed', { orderHash: resp.orderHash, slug, qty, unitPriceWei, startTime, endTime, counter: resp.counter });

    const v = await verifySignedBid({ request, response: resp, build, house, policy, getOrderHash, knownCounter: exposure.counter() });
    if (!v.ok) {
      if (v.field === 'verify-unavailable') return hold('verify-unavailable', v.reason);
      await halt('signature-mismatch', `${v.field}: ${v.reason}`);
      return { posted: false, why: 'halted', detail: v.reason };
    }

    // Last look before the post.
    if (stopRequested()) return hold('stop');
    gate = risk.gate();
    if (!gate.canPost) return hold('gate', gate.reason);

    let posted;
    try {
      posted = await opensea.postCriteriaOffer({ parameters: { ...resp.parameters, counter: String(resp.counter) }, signature: resp.signature, slug });
    } catch (e) {
      const o = exposure.get(resp.orderHash);
      // A 4xx proves OpenSea did not keep it, and behind SignedZone an order OpenSea does not
      // hold cannot be filled. Anything else may have been stored: it stays live exposure.
      o.posted = definitelyRefused(e) ? 'refused' : 'unknown';
      ledger.append('post-failed', { orderHash: resp.orderHash, slug, error: errText(e), definitive: o.posted === 'refused' });
      return { posted: false, why: 'post-failed', detail: errText(e) };
    }
    if (String(posted?.orderHash ?? '').toLowerCase() !== String(resp.orderHash).toLowerCase()) {
      exposure.get(resp.orderHash).posted = 'unknown';
      await halt('ledger-mismatch', `OpenSea stored order ${posted?.orderHash ?? 'none'}, the house signed ${resp.orderHash}`);
      return { posted: false, why: 'halted' };
    }
    exposure.get(resp.orderHash).posted = true;
    lastHold[slug] = null;
    if (reprice) books.lastReprice[slug] = now();
    ledger.append('post', { orderHash: resp.orderHash, slug, qty, unitPriceWei, startTime, endTime, counter: resp.counter, binding: plan.binding ?? null, edgeBps: plan.edgeBps ?? null, reprice });
    return { posted: true, orderHash: resp.orderHash };
  }

  /**
   * Cancel one order early. Gasless first; on chain when OpenSea refuses or fails.
   * @returns {Promise<{ ok: boolean, method?: string, tailUntil?: number|null, mined?: boolean, why?: string }>}
   */
  const inflight = new Map();
  /** One cancel per order at a time: a halt arriving mid-re-price must not send a second, paid, cancel. */
  function cancel(orderHash, reason) {
    if (!CANCEL_REASONS.includes(reason)) throw new Error(`"${reason}" is not a cancel reason`);
    const key = String(orderHash).toLowerCase();
    if (inflight.has(key)) return inflight.get(key);
    const p = cancelOnce(key, reason).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  async function cancelOnce(orderHash, reason) {
    const o = exposure.get(orderHash);
    const t = nowSec();
    if (!o || !exposure.isLive(o, t)) return { ok: true, method: 'none' };
    if (o.cancel?.method === 'gasless') return { ok: true, method: 'gasless', tailUntil: o.cancel.validUntil ?? null };
    // An on-chain cancel already sent is not sent twice; until it is mined the order is live.
    if (o.cancel?.method === 'on-chain') return { ok: true, method: 'on-chain', mined: o.cancel.mined === true };
    exposure.recordCancelAsked(orderHash, { at: now(), reason });
    if (o.posted === 'refused') {
      ledger.append('cancel', { orderHash: o.orderHash, slug: o.slug, reason, method: 'unposted', confirmed: true });
      return { ok: true, method: 'unposted' };
    }
    let sig;
    try {
      sig = await signer.signCancel(o.orderHash);
    } catch (e) {
      ledger.append('cancel-failed', { orderHash: o.orderHash, slug: o.slug, reason, why: errText(e) });
      return { ok: false, why: 'signer-unavailable' };
    }
    if (sig.ok !== true) {
      await onRefusal('signCancel', sig);
      return { ok: false, why: 'refused' };
    }
    let res;
    try {
      res = await opensea.cancelOffer({ orderHash: o.orderHash, offererSignature: sig.signature });
    } catch (e) {
      res = { ok: false, reason: errText(e) };
    }
    if (res?.ok === true) {
      exposure.recordGaslessCancel(o.orderHash, { at: now(), lastSignatureValidUntil: res.lastSignatureValidUntil ?? null });
      const tailUntil = exposure.get(o.orderHash).cancel.validUntil;
      ledger.append('cancel', { orderHash: o.orderHash, slug: o.slug, reason, method: 'gasless', confirmed: true, lastSignatureValidUntil: tailUntil });
      return { ok: true, method: 'gasless', tailUntil };
    }
    // OpenSea said no (a very new order can need an on-chain cancel) or did not answer.
    ledger.append('cancel-gasless-refused', { orderHash: o.orderHash, slug: o.slug, reason, why: res?.reason ?? null });
    const tx = await sendTx('cancelOnChain', { orderHashes: [o.orderHash] }, `cancel ${reason}`);
    if (!tx.ok) return { ok: false, why: tx.why };
    exposure.recordOnChainCancel(o.orderHash, { at: now(), txHash: tx.txHash, mined: tx.status === 'mined' });
    ledger.append('cancel', { orderHash: o.orderHash, slug: o.slug, reason, method: 'on-chain', txHash: tx.txHash, mined: tx.status === 'mined' });
    return { ok: true, method: 'on-chain', mined: tx.status === 'mined' };
  }

  async function cancelAll(reason) {
    const results = [];
    for (const o of exposure.live(nowSec())) {
      if (o.shadow) continue;
      results.push({ orderHash: o.orderHash, ...(await cancel(o.orderHash, reason)) });
    }
    return results;
  }

  /** The signer's kill, waited for. Works with STOP present. */
  async function kill(why) {
    ledger.append('kill-asked', { why });
    let r;
    try {
      r = await signer.kill();
    } catch (e) {
      ledger.append('kill-failed', { why, error: errText(e) });
      log(`THE KILL WAS NOT SENT (${errText(e)}). Run it yourself: node tools/house-signer/src/cli.mjs kill`);
      return { ok: false, why: 'signer-unavailable' };
    }
    if (r.ok !== true) {
      ledger.append('refusal', { op: 'kill', field: r.field ?? null, reason: r.reason ?? null });
      log(`THE SIGNER REFUSED THE KILL: ${r.reason ?? 'no reason given'}. Run it yourself: node tools/house-signer/src/cli.mjs kill`);
      return { ok: false, why: 'refused' };
    }
    const txs = r.txs ?? r.hashes ?? r.results ?? [];
    for (const x of Array.isArray(txs) ? txs : []) {
      ledger.append('tx', { txKind: x?.kind ?? 'kill', why: `kill: ${why}`, txHash: typeof x === 'string' ? x : x?.txHash ?? null, status: x?.status ?? 'mined', blockNumber: x?.blockNumber ?? null, gasCostWei: x?.gasCostWei ?? null });
    }
    books.counterBumpPending = true;
    const revoke = (Array.isArray(txs) ? txs : []).find((x) => x?.kind === 'revokeWeth');
    books.lastApproval = { amountWei: 0n, block: revoke?.blockNumber ?? null };
    books.killed = { at: now(), why };
    ledger.append('kill', { why, txs });
    return { ok: true, txs };
  }

  /** An integrity halt: record it, cancel everything gaslessly, then kill on chain. */
  async function halt(reason, detail) {
    const e = risk.integrity(reason, detail);
    if (!e || halting) {
      // Already halted: the first reason stands, and this one is still on the record.
      ledger.append('breaker-extra', { breaker: 'integrity', reason, detail: detail ?? null });
      return { already: true };
    }
    halting = true;
    try {
      ledger.append('breaker', { breaker: 'integrity', reason, detail: detail ?? null });
      log(`HALT (${reason}): ${detail ?? ''}`);
      // After a signer refusal its cancels may be refused too: go straight to the kill.
      if (reason !== 'signer-refusal') await cancelAll('risk-halt');
      await kill(`halt: ${reason}`);
    } finally {
      halting = false;
    }
    return { already: false };
  }

  /**
   * STOP: cancel every live order gaslessly, read each answer, and kill (waiting for it) if any
   * cancel was refused or failed, any 5-minute tail is still open, or any order's fate is unknown.
   */
  async function stopPath() {
    ledger.append('stop', { live: exposure.live(nowSec()).length });
    const results = await cancelAll('stop');
    const t = nowSec();
    const failed = results.filter((r) => !r.ok);
    const tails = exposure.openTails(t);
    const unmined = exposure.live(t).filter((o) => o.cancel?.method === 'on-chain' && !o.cancel.mined);
    const needKill = failed.length > 0 || tails.length > 0 || unmined.length > 0;
    if (!needKill) {
      ledger.append('stop-clean', { cancelled: results.length });
      return { killed: false, results };
    }
    const k = await kill(`stop: ${failed.length} cancel(s) failed, ${tails.length} tail(s) open, ${unmined.length} on-chain cancel(s) not mined`);
    return { killed: k.ok, kill: k, results };
  }

  /** May a discretionary re-price happen now (one per collection per hour)? */
  const mayReprice = (slug) => now() - (books.lastReprice[slug] ?? -Infinity) >= params.repriceEveryMs;

  return {
    post,
    cancel,
    cancelAll,
    kill,
    halt,
    stopPath,
    syncAllowance,
    mayReprice,
    books,
    noteCounterSeen() {
      books.counterBumpPending = false;
    },
    /** Rebuild the approval books from the ledger on start. */
    restoreBooks(entries) {
      for (const e of entries) {
        if (e.shadow) continue;
        if (e.kind === 'approve') books.lastApproval = { amountWei: BigInt(e.amountWei), block: e.block ?? null };
        if (e.kind === 'kill') books.lastApproval = { amountWei: 0n, block: (e.txs ?? []).find?.((x) => x?.kind === 'revokeWeth')?.blockNumber ?? null };
        if (e.kind === 'post' && e.reprice) books.lastReprice[e.slug] = e.at;
      }
    },
    /** Seconds until the order's 5-minute tail closes, or null when none is open. */
    tailLeft(orderHash) {
      const o = exposure.get(orderHash);
      const until = o?.cancel?.validUntil ?? null;
      return until === null ? null : Math.max(0, until - (toSec(now()) ?? 0));
    },
  };
}

/**
 * The executor shadow mode uses. Same interface; it never contacts the signer, posts nothing and
 * sends nothing. It does ask OpenSea to BUILD each bid (a build creates nothing) when the house
 * address is known, so a change in OpenSea's answer shows in shadow mode before it matters.
 */
export function createShadowExecutor({ house, policy, params = DEFAULT_PARAMS, opensea, exposure, risk, ledger, stopRequested, now, log = () => {} }) {
  let seq = 0;
  const books = { lastApproval: null, ownTxs: [], counterBumpPending: false, lastReprice: {}, killed: null };
  const nowSec = () => Math.floor(now() / 1000);
  const self = {
    books,
    async post(plan, { reprice = false } = {}) {
      const { slug } = plan;
      if (stopRequested()) return { posted: false, why: 'stop' };
      const gate = risk.gate();
      if (!gate.canPost) {
        ledger.append('decision', { slug, action: 'hold', why: 'gate', detail: gate.reason });
        return { posted: false, why: 'gate', detail: gate.reason };
      }
      const qty = Math.min(plan.qty, gate.maxQty ?? plan.qty);
      if (exposure.active(slug, nowSec()).length) return { posted: false, why: 'already-bidding' };
      if (house) {
        try {
          const build = await opensea.buildCollectionOffer({ offerer: house, slug, qty });
          const bc = checkBuild(build, { slug, qty, house });
          if (!bc.ok) {
            await self.halt('build-mismatch', bc.problems.join('; '));
            return { posted: false, why: 'halted' };
          }
        } catch (e) {
          ledger.append('decision', { slug, action: 'build-unread', detail: errText(e) });
        }
      }
      const startTime = nowSec();
      const endTime = startTime + Math.min(params.bidLifetimeSec, policy.maxLifetimeSec);
      const orderHash = `shadow-${startTime}-${++seq}`;
      exposure.add({ orderHash, slug, qty, unitPriceWei: plan.unitPriceWei, startTime, endTime, counter: null, posted: true, shadow: true });
      if (reprice) books.lastReprice[slug] = now();
      ledger.append('post', { orderHash, slug, qty, unitPriceWei: plan.unitPriceWei, startTime, endTime, binding: plan.binding ?? null, edgeBps: plan.edgeBps ?? null, reprice });
      return { posted: true, orderHash };
    },
    async cancel(orderHash, reason) {
      if (!CANCEL_REASONS.includes(reason)) throw new Error(`"${reason}" is not a cancel reason`);
      const o = exposure.get(orderHash);
      if (!o || !exposure.isLive(o, nowSec())) return { ok: true, method: 'none' };
      exposure.recordGaslessCancel(orderHash, { at: now(), lastSignatureValidUntil: null });
      ledger.append('cancel', { orderHash, slug: o.slug, reason, method: 'shadow', confirmed: true, lastSignatureValidUntil: null });
      return { ok: true, method: 'shadow', tailUntil: null };
    },
    async cancelAll(reason) {
      const out = [];
      for (const o of exposure.live(nowSec())) out.push({ orderHash: o.orderHash, ...(await self.cancel(o.orderHash, reason)) });
      return out;
    },
    async kill(why) {
      ledger.append('kill', { why, txs: [], simulated: true });
      return { ok: true, txs: [] };
    },
    async halt(reason, detail) {
      const e = risk.integrity(reason, detail);
      if (!e) return { already: true };
      ledger.append('breaker', { breaker: 'integrity', reason, detail: detail ?? null });
      log(`SHADOW HALT (${reason}): ${detail ?? ''}`);
      await self.cancelAll('risk-halt');
      await self.kill(`halt: ${reason}`);
      return { already: false };
    },
    async stopPath() {
      const results = await self.cancelAll('stop');
      ledger.append('stop-clean', { cancelled: results.length });
      return { killed: false, results };
    },
    async syncAllowance() {
      return { changed: false };
    },
    mayReprice: (slug) => now() - (books.lastReprice[slug] ?? -Infinity) >= params.repriceEveryMs,
    noteCounterSeen() {},
    restoreBooks(entries) {
      for (const e of entries) if (e.shadow && e.kind === 'post' && e.reprice) books.lastReprice[e.slug] = e.at;
    },
    tailLeft: () => null,
  };
  return self;
}
