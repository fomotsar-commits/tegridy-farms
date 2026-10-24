// ?resource=range-stats, range-pools and range-swaps: the venue's own count of each range pool
// (scripts/range-stats.mjs into migration 030), read as service_role and cached at the edge.
// A window's figures are the difference of two snapshots of the pool's own counters. A window
// or hour a hole touches answers complete: false and no number; a failed read is "unread".

import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { isOriginAllowed, isRequestOriginAllowed } from "./aggregator-proxy.js";
import { readBoundedText } from "./bodycap.js";
import { logSafe } from "./logSafe.js";
import { RANGE_PROGRAM_ID } from "./rangeEvents.js";

/** Past this the answer says "behind": GitHub runs hourly jobs late, and a figure says its age. */
export const BEHIND_AFTER_MS = 2 * 60 * 60 * 1000;
export const WINDOWS = Object.freeze({ "24h": 24 * 3600_000, "7d": 7 * 24 * 3600_000, "30d": 30 * 24 * 3600_000 });
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const COINS = ["0", "1"];
/** The most gap rows one read returns; a read that fills it is treated as holding a hole. */
const GAP_LIST = 200;

const SNAPSHOT =
  "slot,block_time,at_open,trade_fee_rate,protocol_fee_rate,fund_fee_rate,cum_swaps::text," +
  ["protocol_fees", "fund_fees", "cum_volume", "cum_fees", "cum_vault_collected", "cum_workshop_collected"].flatMap((k) => COINS.map((c) => `${k}_${c}::text`)).join(",") +
  ",sqrt_price_x64::text";
const GAP = "kind,standing,signature,gap_key,from_slot,to_slot,from_time,to_time,detail";
const SWAP = "signature,event_index,slot,block_time,zero_for_one,amount_0::text,amount_1::text,fee_0::text,fee_1::text,sqrt_price_x64::text,liquidity::text,tick";

const overlaps = (g, a, b) => (g.from_slot ?? 0) <= b && (g.to_slot ?? Number.MAX_SAFE_INTEGER) > a;
const gapOut = (g) => ({ kind: g.kind, standing: g.standing, signature: g.signature ?? null, from_slot: g.from_slot ?? null, to_slot: g.to_slot ?? null, from_time: g.from_time ?? null, to_time: g.to_time ?? null, detail: g.detail });

/**
 * One window's figures between two snapshots, per coin, as raw decimal strings. Fees to
 * positions = all fees less what the vault's and the Workshop's counters gained plus what each
 * collected. With a hole inside, or figures that do not add up, it gives no number at all.
 */
export function windowFigures(start, end, gaps) {
  if (!start || !end) return { complete: false, reason: "too-short" };
  const span = { from: start.block_time, to: end.block_time, from_slot: start.slot, to_slot: end.slot, since_open: start.at_open === true };
  const holes = gaps.filter((g) => !g.standing && overlaps(g, start.slot, end.slot));
  if (holes.length) return { complete: false, reason: "gap", ...span, gaps: holes.map(gapOut) };
  const d = (k) => BigInt(end[k]) - BigInt(start[k]);
  const out = { complete: true, ...span, swaps: Number(d("cum_swaps")) };
  for (const c of COINS) {
    const fees = d(`cum_fees_${c}`);
    const vault = d(`protocol_fees_${c}`) + d(`cum_vault_collected_${c}`);
    const workshop = d(`fund_fees_${c}`) + d(`cum_workshop_collected_${c}`);
    const positions = fees - vault - workshop;
    if (vault < 0n || workshop < 0n || positions < 0n || d(`cum_volume_${c}`) < 0n) return { complete: false, reason: "inconsistent", ...span };
    Object.assign(out, { [`volume_${c}`]: d(`cum_volume_${c}`).toString(), [`fees_${c}`]: fees.toString(), [`to_positions_${c}`]: positions.toString(), [`vault_${c}`]: vault.toString(), [`workshop_${c}`]: workshop.toString() });
  }
  // What reached the vault beyond its rate came from fills with no range in use. Each price
  // step's share rounds down, so this can read up to one raw unit a step low, never high.
  const limits = gaps.filter((g) => g.standing && overlaps(g, start.slot, end.slot));
  const rate = end.protocol_fee_rate;
  const tierChanged = limits.some((g) => g.kind === "tier-changed");
  for (const c of COINS) {
    if (tierChanged || !Number.isInteger(rate)) out[`no_range_${c}`] = null;
    else {
      const x = BigInt(out[`vault_${c}`]) - (BigInt(out[`fees_${c}`]) * BigInt(rate)) / 1_000_000n;
      out[`no_range_${c}`] = (x > 0n ? x : 0n).toString();
    }
  }
  out.no_range_basis = tierChanged ? "tier-changed" : Number.isInteger(rate) ? "rate" : "rate-unread";
  out.limits = limits.map(gapOut);
  return out;
}

const HOUR = 3600_000;
const HOUR_SUMS = ["volume_0", "volume_1", "fees_0", "fees_1"];
const HOUR_PRICES = ["open_price", "high_price", "low_price", "close_price"];

/**
 * Each closed hour from the first the count can speak for. An hour has numbers only when a
 * snapshot before it and one after it bracket it and no fault gap touches it: a gap with both
 * times by those, one without by its slots between the two snapshots. The opening snapshot
 * comes before every event of the pool. An hour with no row and no gap had no swap.
 */
export function hourFigures(rows, snaps, gaps, fromMs, toMs) {
  const t = (s) => Date.parse(s.block_time);
  const faults = gaps.filter((g) => !g.standing);
  const touches = (g, h, a, b) => (g.from_time != null && g.to_time != null ? Date.parse(g.from_time) < h + HOUR && Date.parse(g.to_time) >= h : overlaps(g, a.slot, b.slot));
  const byHour = new Map(rows.map((r) => [Date.parse(r.hour), r]));
  const out = [];
  if (!snaps.length) return out;
  for (let h = Math.max(Math.ceil(fromMs / HOUR) * HOUR, Math.floor(t(snaps[0]) / HOUR) * HOUR); h + HOUR <= toMs; h += HOUR) {
    const a = snaps.filter((s) => s.at_open === true || t(s) < h).pop();
    const b = snaps.find((s) => t(s) >= h + HOUR);
    const hour = new Date(h).toISOString();
    if (!a || !b || faults.some((g) => touches(g, h, a, b))) {
      out.push({ hour, complete: false });
      continue;
    }
    const r = byHour.get(h);
    out.push({
      hour, complete: true, swaps: r?.swaps ?? 0,
      ...Object.fromEntries(HOUR_SUMS.map((k) => [k, r?.[k] ?? "0"])),
      ...Object.fromEntries(HOUR_PRICES.map((k) => [k, r?.[k] ?? null])),
    });
  }
  return out;
}

/** ok, or behind with why: late, the last run failed on this pool, or it waits past the cap. */
export function stateOf({ cursor, latest, gaps, nowMs }) {
  if (!cursor || !latest) return { state: "unread", reason: "not-counted" };
  const at = Date.parse(latest.block_time);
  const why = [];
  if (!(nowMs - at <= BEHIND_AFTER_MS)) why.push("late");
  const ok = Date.parse(cursor.last_ok_at ?? "");
  const err = Date.parse(cursor.last_error_at ?? "");
  if (Number.isFinite(err) && !(ok > err)) why.push("last-run-failed");
  if (gaps.some((g) => g.kind === "backlog-truncated" && String(g.gap_key).startsWith("backlog-truncated:wait:"))) why.push("waiting");
  return why.length ? { state: "behind", reason: why } : { state: "ok", reason: [] };
}

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  if (origin && isOriginAllowed(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function unread(res, status, extra = {}) {
  res.setHeader("Cache-Control", "s-maxage=30");
  return res.status(status).json({ state: "unread", ...extra });
}

/** The shared gate: method, origin, rate limit, keys. Returns a reader, or null once answered. */
async function gate(req, res, identifier, fetchImpl) {
  setCors(req, res);
  const refuse = (status, body) => {
    if (body) res.status(status).json(body);
    else res.status(status).end();
    return null;
  };
  if (req.method === "OPTIONS") return refuse(200);
  if (req.method !== "GET") return refuse(405, { error: "Method not allowed" });
  if (!isRequestOriginAllowed(req)) return refuse(403, { error: "Origin not allowed" });
  if (!(await checkRateLimit(req, res, { limit: 30, windowSec: 60, identifier }))) return null;
  if (!(await checkGlobalLimit(res, { limit: 300, windowSec: 60, identifier }))) return null;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    unread(res, 503);
    return null;
  }
  return async (path) => {
    const r = await fetchImpl(`${url}/rest/v1/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    const { text, truncated } = await readBoundedText(r, 1024 * 1024);
    if (!r.ok || truncated) throw new Error(`${path.split("?")[0]} answered HTTP ${r.status}${truncated ? ", over the cap" : ""}`);
    const body = JSON.parse(text);
    if (!Array.isArray(body)) throw new Error(`${path.split("?")[0]} did not answer a list`);
    return body;
  };
}

/** The most snapshots one hours read takes in; more is treated as unread. */
const SNAP_LIST = 1000;
const HOUR_ROW = `hour,swaps,${[...HOUR_SUMS, ...HOUR_PRICES].map((k) => `${k}::text`).join(",")}`;

/** The last week's closed hours, from `anchor` (the snapshot at or before its start) on. */
async function hoursOf(read, p, latest, anchor, end) {
  const fromMs = end - WINDOWS["7d"];
  const toMs = Math.floor(end / HOUR) * HOUR;
  const [later, rows] = await Promise.all([
    read(`range_venue_snapshot?${p}&slot=${anchor ? `gt.${anchor.slot}` : "gte.0"}&slot=lte.${latest.slot}&order=slot.asc&limit=${SNAP_LIST}&select=slot,block_time,at_open`),
    read(`range_hour?${p}&hour=gte.${new Date(fromMs).toISOString()}&hour=lt.${new Date(toMs).toISOString()}&order=hour.asc&limit=200&select=${HOUR_ROW}`),
  ]);
  if (later.length === SNAP_LIST) throw new Error("range_venue_snapshot holds more than one read returns");
  const snaps = anchor ? [anchor, ...later] : later;
  if (!snaps.length) return [];
  const gaps = await read(`range_gap?${p}&resolved_at=is.null&standing=is.false&from_slot=lte.${latest.slot}&to_slot=gt.${snaps[0].slot}&select=${GAP}&limit=${GAP_LIST}`);
  // A full read may not hold every gap, so no hour gets a number.
  const holes = gaps.length === GAP_LIST ? [{ standing: false, from_slot: 0, to_slot: null }] : gaps;
  return hourFigures(rows, snaps, holes, fromMs, toMs);
}

const poolParam = (req) => (typeof req.query?.pool === "string" && ADDRESS.test(req.query.pool) ? req.query.pool : null);
const optional = (p) => p.then((v) => v, () => null);

/** `?resource=range-stats&pool=<address>`: the pool's windows, its venue take and its gaps. */
export async function handleRangeStats(req, res, { nowMs = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  const pool = poolParam(req);
  const read = await gate(req, res, "range-stats", fetchImpl);
  if (!read) return;
  if (!pool) return res.status(400).json({ error: "pool must be a Solana address" });
  const p = `pool=eq.${pool}`;
  const snap = (filter) => read(`range_venue_snapshot?${p}${filter}&select=${SNAPSHOT}&limit=1`).then((r) => r[0] ?? null);
  try {
    const [cursors, latest, opening, waiting, listed] = await Promise.all([
      read(`range_cursor?${p}&select=through_slot,last_ok_at,last_error_at`),
      snap("&order=slot.desc"),
      snap("&at_open=is.true"),
      read(`range_gap?${p}&resolved_at=is.null&gap_key=like.backlog-truncated:wait:*&select=${GAP}&limit=1`),
      read(`range_gap?${p}&resolved_at=is.null&select=${GAP}&order=from_slot.asc&limit=${GAP_LIST}`),
    ]);
    const cursor = cursors[0] ?? null;
    const state = stateOf({ cursor, latest, gaps: waiting, nowMs });
    if (state.state === "unread") return unread(res, 200, { pool, reason: state.reason });
    const end = Date.parse(latest.block_time);
    const starts = await Promise.all(
      Object.values(WINDOWS).map((ms) => snap(`&block_time=lte.${new Date(end - ms).toISOString()}&order=slot.desc`)),
    );
    const names = [...Object.keys(WINDOWS), "all"];
    const from = names.map((name, i) => (name === "all" ? opening : (starts[i] ?? (opening && Date.parse(opening.block_time) > end - WINDOWS[name] ? opening : null))));
    // Each window asks for the gaps inside it, so a pool with many gaps cannot hide one.
    const inside = await Promise.all(from.map((s) => (s ? read(`range_gap?${p}&resolved_at=is.null&from_slot=lte.${latest.slot}&to_slot=gt.${s.slot}&select=${GAP}&limit=${GAP_LIST}`) : [])));
    const windows = {};
    names.forEach((name, i) => {
      windows[name] = inside[i].length === GAP_LIST ? { complete: false, reason: "gap", gaps: inside[i].map(gapOut) } : windowFigures(from[i], latest, inside[i]);
    });
    let partial = false;
    const soft = async (promise) => {
      const v = await optional(promise);
      if (v === null) partial = true;
      return v;
    };
    const extra = (q) => soft(read(q));
    const span = (w) => `${p}&slot=gt.${w.from_slot}&slot=lte.${w.to_slot}`;
    await Promise.all([
      ...Object.keys(WINDOWS).map(async (name) => {
        const w = windows[name];
        if (!w.complete) return;
        const [by0, by1] = await Promise.all(COINS.map((c) => extra(`range_swap?${span(w)}&fee_${c}=gt.0&order=fee_${c}.desc&limit=3&select=${SWAP}`)));
        w.largest = by0 && by1 ? { by_fee_0: by0, by_fee_1: by1 } : null;
      }),
      (async () => {
        const w = windows["7d"];
        if (!w.complete) return;
        const [lo, hi] = await Promise.all(["asc", "desc"].map((o) => extra(`range_swap?${span(w)}&order=sqrt_price_x64.${o}&limit=1&select=sqrt_price_x64::text`)));
        w.low_sqrt_price_x64 = lo ? (lo[0]?.sqrt_price_x64 ?? null) : null;
        w.high_sqrt_price_x64 = hi ? (hi[0]?.sqrt_price_x64 ?? null) : null;
      })(),
    ]);
    const [collections, hours] = await Promise.all([
      extra(`range_collection?${p}&slot=lte.${latest.slot}&order=slot.desc&limit=10&select=signature,slot,block_time,by_whom,amount_0::text,amount_1::text`),
      soft(hoursOf(read, p, latest, from[1], end)),
    ]);
    res.setHeader("Cache-Control", partial ? "s-maxage=30" : "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({
      state: state.state,
      behind: state.reason,
      pool,
      counted_to: latest.block_time,
      counted_to_slot: latest.slot,
      stale_at: new Date(end + BEHIND_AFTER_MS).toISOString(),
      windows,
      venue_waiting: { vault_0: latest.protocol_fees_0, vault_1: latest.protocol_fees_1, workshop_0: latest.fund_fees_0, workshop_1: latest.fund_fees_1 },
      collections,
      hours,
      gaps: listed.map(gapOut),
      gaps_listed_all: listed.length < GAP_LIST,
    });
  } catch (err) {
    console.error("range-stats error:", logSafe(err));
    return unread(res, 502, { pool });
  }
}

/** `?resource=range-pools`: every pool the count knows, the registry's first, and whether the list was whole. */
export async function handleRangePools(req, res, { nowMs = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  const read = await gate(req, res, "range-pools", fetchImpl);
  if (!read) return;
  try {
    const [pools, runs, listGaps] = await Promise.all([
      read("range_pool?select=address,mint_0,mint_1,amm_config,tick_spacing,registry,opened_slot,opened_at&order=registry.desc,address.asc&limit=1000"),
      read("range_run?select=finished_at,ok,list_read&order=finished_at.desc&limit=1"),
      read(`range_gap?pool=eq.${RANGE_PROGRAM_ID}&kind=eq.pool-list-unread&resolved_at=is.null&select=${GAP}&limit=1`),
    ]);
    const run = runs[0];
    if (!run) return unread(res, 200, { reason: "not-counted" });
    const listComplete = run.list_read === true && listGaps.length === 0;
    const late = !(nowMs - Date.parse(run.finished_at) <= BEHIND_AFTER_MS);
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({
      state: late || !listComplete ? "behind" : "ok",
      listed_at: run.finished_at,
      list_complete: listComplete,
      pools,
      gaps: listGaps.map(gapOut),
    });
  } catch (err) {
    console.error("range-pools error:", logSafe(err));
    return unread(res, 502);
  }
}

/** The most swaps of one pool one slot is read for. */
const SLOT_SWAPS = 1000;

/**
 * `?resource=range-swaps&pool=<address>[&before=<slot>][&limit=<1..500>]`: counted swaps, newest
 * first, with the holes inside the span. A full page ends at a whole slot, so `next_before`
 * resumes without skipping a swap; a slot with more swaps than `limit` comes whole.
 */
export async function handleRangeSwaps(req, res, { nowMs = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  const pool = poolParam(req);
  const read = await gate(req, res, "range-swaps", fetchImpl);
  if (!read) return;
  const before = req.query?.before === undefined ? null : Number(req.query.before);
  const limit = req.query?.limit === undefined ? 100 : Number(req.query.limit);
  if (!pool || (before !== null && !(Number.isSafeInteger(before) && before > 0)) || !(Number.isSafeInteger(limit) && limit >= 1 && limit <= 500)) {
    return res.status(400).json({ error: "pool must be a Solana address, before a slot, limit 1 to 500" });
  }
  const p = `pool=eq.${pool}`;
  try {
    const cursor = (await read(`range_cursor?${p}&select=through_slot,last_ok_at,last_error_at`))[0];
    if (!cursor) return unread(res, 200, { pool, reason: "not-counted" });
    const top = before === null ? cursor.through_slot : Math.min(cursor.through_slot, before - 1);
    const NEWEST = "order=slot.desc,signature.desc,event_index.desc";
    let swaps = await read(`range_swap?${p}&slot=lte.${top}&${NEWEST}&limit=${limit}&select=${SWAP}`);
    let nextBefore = null;
    if (swaps.length === limit) {
      const oldest = swaps[swaps.length - 1].slot;
      if (swaps[0].slot !== oldest) swaps = swaps.filter((s) => s.slot !== oldest);
      else {
        // One slot fills the page: it comes whole. The pool's per-block write cap keeps a
        // slot far under SLOT_SWAPS; a read that fills it is unread, never short.
        swaps = await read(`range_swap?${p}&slot=eq.${oldest}&${NEWEST}&limit=${SLOT_SWAPS}&select=${SWAP}`);
        if (swaps.length === SLOT_SWAPS) throw new Error(`slot ${oldest} holds more swaps than one read returns`);
      }
      nextBefore = swaps[swaps.length - 1].slot;
    }
    const from = swaps.length ? swaps[swaps.length - 1].slot : top;
    const gaps = await read(`range_gap?${p}&resolved_at=is.null&standing=is.false&from_slot=lte.${top}&to_slot=gte.${from}&select=${GAP}&order=from_slot.asc&limit=${GAP_LIST}`);
    const late = !(nowMs - Date.parse(cursor.last_ok_at ?? "") <= BEHIND_AFTER_MS);
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({ state: late ? "behind" : "ok", pool, counted_through_slot: cursor.through_slot, swaps, next_before: nextBefore, gaps: gaps.map(gapOut), gaps_listed_all: gaps.length < GAP_LIST });
  } catch (err) {
    console.error("range-swaps error:", logSafe(err));
    return unread(res, 502, { pool });
  }
}
