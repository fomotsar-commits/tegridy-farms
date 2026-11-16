// The breakers. Each trip carries a reason from a closed list, so the ledger, the board and the
// monthly report can count them, and a person reading a halt knows exactly what tripped it.
//
//   INTEGRITY  something that should never happen happened (a mint, an admin change, an insider
//              in a fill, a signer refusal, books that do not match the chain). Cancel everything,
//              kill on chain, and stay halted until a person restarts with --ack-halt.
//   MARKET     the market moved too fast or the data went dark. Cancel (gaslessly), let what is
//              left expire, and resume on its own after 2 hours, bidding one unit at a time.
//   CAPS       the day's WETH, units or gas are used up: no new bid until the next UTC day.
//              The stolen-item cap (1 a month) halts like an integrity breaker.
//   GATES      not breakers: after a gap in the live feed nothing is posted until the listings
//              have been read again over REST.

import { DEFAULT_PARAMS } from './params.mjs';
import { toSec, utcDay, utcMonth } from './util.mjs';

export const INTEGRITY = Object.freeze([
  'mint',
  'jbac-max-supply',
  'jbac-owner',
  'gnss-owner',
  'gnss-seed',
  'gnss-locked',
  'admin-change',
  'insider-fill',
  'venue-contract-fill',
  'house-fill',
  'insider-provenance',
  'flagged-item',
  'signer-refusal',
  'ledger-mismatch',
  'build-mismatch',
  'signature-mismatch',
]);
export const MARKET = Object.freeze(['floor-drop-1h', 'floor-drop-24h', 'stream-silent', 'fill-burst']);
export const CAPS = Object.freeze(['daily-weth', 'daily-units', 'daily-gas', 'stolen-loss']);

const HOUR = 60 * 60 * 1000;

/** Which breaker kind a reason belongs to; null for a reason on no list (never trusted). */
export function classify(reason) {
  if (INTEGRITY.includes(reason)) return 'integrity';
  if (MARKET.includes(reason)) return 'market';
  if (CAPS.includes(reason)) return reason === 'stolen-loss' ? 'halt' : 'cap';
  return null;
}

/**
 * What each kind of trip asks the executor to do. Integrity kills on chain: whatever happened may
 * mean a signature or an approval is in the wrong hands, and the kill (approval to zero, counter
 * bump) ends every house order at once. A stolen-item halt and a market pause only cancel.
 */
export function actionsFor(kind) {
  if (kind === 'integrity') return ['cancel-all', 'kill'];
  if (kind === 'halt' || kind === 'market' || kind === 'cap') return ['cancel-all'];
  return [];
}

/** The integrity reason for a change between two chain snapshots, one per changed field. */
export function diffSnapshots(prev, next) {
  if (!prev || !next) return [];
  const out = [];
  const changed = (a, b) => a !== undefined && b !== undefined && String(a).toLowerCase() !== String(b).toLowerCase();
  const grew = (a, b) => {
    try {
      return a !== undefined && b !== undefined && BigInt(b) > BigInt(a);
    } catch {
      return changed(a, b);
    }
  };
  if (grew(prev.jbac?.totalSupply, next.jbac?.totalSupply)) out.push({ reason: 'mint', detail: `JBAC supply ${prev.jbac.totalSupply} -> ${next.jbac.totalSupply}` });
  if (grew(prev.gnss?.totalSupply, next.gnss?.totalSupply)) out.push({ reason: 'mint', detail: `GNSS supply ${prev.gnss.totalSupply} -> ${next.gnss.totalSupply}` });
  if (changed(prev.jbac?.maxSupply, next.jbac?.maxSupply)) out.push({ reason: 'jbac-max-supply', detail: `JBAC maxSupply ${prev.jbac.maxSupply} -> ${next.jbac.maxSupply}` });
  if (changed(prev.jbac?.owner, next.jbac?.owner)) out.push({ reason: 'jbac-owner', detail: `JBAC owner ${prev.jbac.owner} -> ${next.jbac.owner}` });
  if (changed(prev.gnss?.owner, next.gnss?.owner)) out.push({ reason: 'gnss-owner', detail: `GNSS owner ${prev.gnss.owner} -> ${next.gnss.owner}` });
  if (changed(prev.gnss?.seed, next.gnss?.seed)) out.push({ reason: 'gnss-seed', detail: `GNSS seed ${prev.gnss.seed} -> ${next.gnss.seed}` });
  if (changed(prev.gnss?.contractLocked, next.gnss?.contractLocked)) out.push({ reason: 'gnss-locked', detail: `GNSS contractLocked ${prev.gnss.contractLocked} -> ${next.gnss.contractLocked}` });
  return out;
}

/**
 * The integrity reason for a chain watcher's admin event, by the field it names. A supply that
 * grew is a mint; a supply that shrank is a burn, which is not a breaker (null). Any other field,
 * even one this list does not know, halts.
 */
export function classifyAdmin({ field, before, after }) {
  const f = String(field ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const jbac = f.includes('jbac') || f.includes('junglebay');
  const gnss = f.includes('gnss');
  if (f.includes('totalsupply')) {
    try {
      return BigInt(after) > BigInt(before) ? 'mint' : null;
    } catch {
      return 'admin-change';
    }
  }
  if (f.includes('maxsupply') && !gnss) return 'jbac-max-supply';
  if (f.includes('seed') && !jbac) return 'gnss-seed';
  if (f.includes('locked') && !jbac) return 'gnss-locked';
  if (f.includes('owner') && jbac) return 'jbac-owner';
  if (f.includes('owner') && gnss) return 'gnss-owner';
  return 'admin-change';
}

function emptyState() {
  return {
    halted: null,
    paused: null,
    qtyOneUntil: null,
    capped: null,
    dataGapSince: null,
    restFailingSince: null,
    floor: {},
    resetAt: {},
    burstResetAt: 0,
    trips: [],
  };
}

/**
 * @param {object} a
 * @param {object} [a.params]
 * @param {() => number} a.now   milliseconds
 * @param {object} [a.state]     a state from snapshot() or restoreRisk()
 */
export function createRisk({ params = DEFAULT_PARAMS, now, state = null }) {
  const s = state ? structuredClone(state) : emptyState();
  const events = [];

  function trip(kind, reason, detail, at) {
    const e = { kind, reason, detail: detail ?? null, at, actions: actionsFor(kind) };
    s.trips.push({ kind, reason, at });
    if (s.trips.length > 200) s.trips.splice(0, s.trips.length - 200);
    events.push(e);
    return e;
  }

  const api = {
    /** An integrity trip: sticky until a person acknowledges it. */
    integrity(reason, detail) {
      if (!INTEGRITY.includes(reason)) throw new Error(`"${reason}" is not an integrity reason`);
      const at = now();
      if (s.halted) return null; // already halted: the first reason stands, the rest are logged by the caller
      s.halted = { reason, detail: detail ?? null, at };
      return trip('integrity', reason, detail, at);
    },
    /** A market trip: pause for 2 hours (extended by a new trip), then one unit at a time for a day. */
    market(reason, detail, slug) {
      if (!MARKET.includes(reason)) throw new Error(`"${reason}" is not a market reason`);
      const at = now();
      // The same reason again while paused (a feed still dark) only extends the pause: the
      // bids were already cancelled, and the ledger needs one line, not one a minute.
      const same = s.paused?.reason === reason;
      const until = Math.max(at + params.marketPauseMs, s.paused?.until ?? 0);
      s.paused = { reason, detail: detail ?? null, at: same ? s.paused.at : at, until, extended: same ? (s.paused.extended ?? 0) + 1 : 0 };
      s.qtyOneUntil = until + params.resumeQtyOneMs;
      // A trip resets what the next trip is measured from, so the same drop does not re-trip
      // the moment the pause lifts.
      if (slug) s.resetAt[slug] = at;
      if (reason === 'fill-burst') s.burstResetAt = at;
      return same ? null : trip('market', reason, detail, at);
    },
    /** A cap: no new bid until the next UTC day; the stolen-item cap halts. */
    cap(reason, detail) {
      if (!CAPS.includes(reason)) throw new Error(`"${reason}" is not a cap reason`);
      const at = now();
      if (reason === 'stolen-loss') {
        if (s.halted) return null;
        s.halted = { reason, detail: detail ?? null, at };
        return trip('halt', reason, detail, at);
      }
      if (s.capped?.day === utcDay(at)) return null;
      s.capped = { reason, detail: detail ?? null, at, day: utcDay(at) };
      return trip('cap', reason, detail, at);
    },

    noteGap(at = now()) {
      s.dataGapSince = Math.max(at, s.dataGapSince ?? 0);
    },
    /** A REST read of the listings: success clears a data gap that started before the read began. */
    noteRestRead({ ok, startedAt }) {
      if (ok) {
        s.restFailingSince = null;
        if (s.dataGapSince !== null && startedAt >= s.dataGapSince) s.dataGapSince = null;
      } else if (s.restFailingSince === null) {
        s.restFailingSince = startedAt;
      }
    },
    noteFloor(slug, at, value) {
      if (typeof value !== 'bigint' || value <= 0n) return;
      const h = (s.floor[slug] ??= []);
      h.push({ at, value: value.toString() });
      const keep = at - 25 * HOUR;
      while (h.length && h[0].at < keep) h.shift();
    },

    /**
     * Check the market breakers and caps. `fills` are the house's own fills (time in seconds),
     * `daily` the day's totals, `stolenThisMonth` flagged items bought this month.
     * Returns the trips this call made.
     */
    evaluate({ streamLastMessageAt = null, fills = [], daily = null, stolenThisMonth = 0 } = {}) {
      const at = now();
      const made = [];
      const push = (e) => e && made.push(e);

      for (const [slug, h] of Object.entries(s.floor)) {
        const since = s.resetAt[slug] ?? 0;
        const usable = h.filter((p) => p.at >= since);
        if (usable.length < 2) continue;
        const cur = BigInt(usable[usable.length - 1].value);
        const peak = (windowMs) => usable.filter((p) => p.at >= at - windowMs).reduce((m, p) => (BigInt(p.value) > m ? BigInt(p.value) : m), 0n);
        const p1 = peak(HOUR);
        const p24 = peak(24 * HOUR);
        if (p1 > 0n && cur * 10_000n < p1 * BigInt(10_000 - params.floorDrop1hBps)) {
          push(api.market('floor-drop-1h', `${slug} floor ${cur} is more than ${params.floorDrop1hBps / 100}% under ${p1} within the hour`, slug));
        } else if (p24 > 0n && cur * 10_000n < p24 * BigInt(10_000 - params.floorDrop24hBps)) {
          push(api.market('floor-drop-24h', `${slug} floor ${cur} is more than ${params.floorDrop24hBps / 100}% under ${p24} within the day`, slug));
        }
      }

      if (streamLastMessageAt !== null && at - streamLastMessageAt > params.streamSilentMs && s.restFailingSince !== null) {
        push(api.market('stream-silent', `no stream message for ${Math.round((at - streamLastMessageAt) / 1000)} s and REST reads failing since ${new Date(s.restFailingSince).toISOString()}`));
      }

      const since = Math.max(at - params.burstWindowMs, s.burstResetAt);
      const units = fills.filter((f) => (toSec(f.time) ?? 0) * 1000 >= since).length;
      if (units >= params.burstUnits) push(api.market('fill-burst', `${units} units bought in 24 hours`));

      if (daily) {
        if (daily.wethSpent >= params.dailyMaxWethWei) push(api.cap('daily-weth', `${daily.wethSpent} wei spent today`));
        else if (daily.units >= params.dailyMaxUnits) push(api.cap('daily-units', `${daily.units} units bought today`));
        else if (daily.gasSpent >= params.dailyMaxGasWei) push(api.cap('daily-gas', `${daily.gasSpent} wei of gas today`));
      }
      if (stolenThisMonth >= params.stolenLossPerMonth) push(api.cap('stolen-loss', `${stolenThisMonth} flagged item(s) bought in ${utcMonth(at)}`));
      return made;
    },

    /** May a new bid be posted now, and for how many units at most? */
    gate() {
      const at = now();
      if (s.halted) return { canPost: false, maxQty: 0, reason: `halted: ${s.halted.reason}` };
      if (s.paused) {
        if (at < s.paused.until) return { canPost: false, maxQty: 0, reason: `paused: ${s.paused.reason}` };
        events.push({ kind: 'resume', reason: s.paused.reason, at, detail: 'market pause over: one unit at a time for a day', actions: [] });
        s.paused = null;
      }
      if (s.capped) {
        if (s.capped.day === utcDay(at)) return { canPost: false, maxQty: 0, reason: `capped: ${s.capped.reason}` };
        events.push({ kind: 'resume', reason: s.capped.reason, at, detail: 'a new UTC day', actions: [] });
        s.capped = null;
      }
      if (s.dataGapSince !== null) return { canPost: false, maxQty: 0, reason: 'data-gap: listings not yet re-read over REST' };
      if (s.qtyOneUntil !== null && at < s.qtyOneUntil) return { canPost: true, maxQty: 1, reason: 'after a market pause: one unit at a time' };
      return { canPost: true, maxQty: null, reason: null };
    },

    /** A person restarted after a halt and said so (--ack-halt). */
    ackHalt() {
      const was = s.halted;
      s.halted = null;
      return was;
    },
    /** Replace the whole state (a restart, from restoreRisk). */
    restore(next) {
      for (const k of Object.keys(s)) delete s[k];
      Object.assign(s, emptyState(), structuredClone(next));
    },
    halted: () => s.halted,
    paused: () => s.paused,
    /** Events not yet written to the ledger (trips and resumes), each returned once. */
    takeEvents: () => events.splice(0, events.length),
    snapshot: () => structuredClone(s),
  };
  return api;
}

/**
 * The risk state a restart must keep, from the ledger: an integrity halt with no later
 * acknowledgement stays halted, a market pause still running stays paused, and the floor
 * history comes back from the ledger's marks so a drop during the restart is not missed.
 */
export function restoreRisk(entries, { nowMs, params = DEFAULT_PARAMS, shadow = false }) {
  const s = emptyState();
  for (const e of entries) {
    if (Boolean(e.shadow) !== shadow) continue;
    if (e.kind === 'breaker') {
      if (e.breaker === 'integrity' || e.breaker === 'halt') s.halted = { reason: e.reason, detail: e.detail ?? null, at: e.at };
      if (e.breaker === 'market') {
        const until = e.at + params.marketPauseMs;
        s.paused = { reason: e.reason, detail: e.detail ?? null, at: e.at, until: Math.max(until, s.paused?.until ?? 0) };
        s.qtyOneUntil = s.paused.until + params.resumeQtyOneMs;
        if (e.slug) s.resetAt[e.slug] = e.at;
        if (e.reason === 'fill-burst') s.burstResetAt = e.at;
      }
      if (e.breaker === 'cap' && utcDay(e.at) === utcDay(nowMs)) s.capped = { reason: e.reason, detail: e.detail ?? null, at: e.at, day: utcDay(e.at) };
      s.trips.push({ kind: e.breaker, reason: e.reason, at: e.at });
    }
    if (e.kind === 'ack-halt') s.halted = null;
    if (e.kind === 'mark' && e.floorProxy && e.at >= nowMs - 25 * HOUR) {
      (s.floor[e.slug] ??= []).push({ at: e.at, value: String(e.floorProxy) });
    }
  }
  if (s.paused && nowMs >= s.paused.until) s.paused = null;
  if (s.trips.length > 200) s.trips.splice(0, s.trips.length - 200);
  // A restart is a gap in the data: post nothing until the listings are read again.
  s.dataGapSince = nowMs;
  return s;
}
