// The range count's decision cases, run bare by `range-stats.mjs --self-test` (CI, no npm
// install) and as vitest cases by range-stats.test.mjs. A fake chain answers the RPC calls the
// count makes and a fake PostgREST holds its rows, so each case runs the real code end to end.
// The Raydium transactions are real mainnet logs (fixtures/range-stats), same program layout.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AMM_CONFIG, EVENTS, POOL_STATE, RANGE_PROGRAM_ID, base58, decodeEvent, fromBase64, programFrames, rangeTxEvents } from "../../api/_lib/rangeEvents.js";
import * as RangeEvents from "../../api/_lib/rangeEvents.js";
import { BAYLA_MINT, LIMITS, RpcError, SOL_MINT, countPool, main, orderPools } from "../range-stats.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RAYDIUM = JSON.parse(readFileSync(join(HERE, "..", "fixtures", "range-stats", "raydium-mainnet-logs.json"), "utf8"));

// ── bytes ────────────────────────────────────────────────────────────────────

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function unbase58(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}
/** A distinct, valid address for a test account. */
export const key = (n) => base58(Uint8Array.from({ length: 32 }, (_, i) => (n * 7 + i * 13 + 1) % 256));
const b64 = (u8) => Buffer.from(u8).toString("base64");

class W {
  constructor(len, disc) {
    this.d = new Uint8Array(len);
    if (disc) this.d.set(disc, 0);
    this.v = new DataView(this.d.buffer);
  }
  u8(o, x) { this.d[o] = x; }
  u16(o, x) { this.v.setUint16(o, x, true); }
  u32(o, x) { this.v.setUint32(o, x, true); }
  i32(o, x) { this.v.setInt32(o, x, true); }
  u64(o, x) { this.v.setBigUint64(o, BigInt.asUintN(64, BigInt(x)), true); }
  u128(o, x) {
    const u = BigInt.asUintN(128, BigInt(x));
    this.u64(o, u & ((1n << 64n) - 1n));
    this.u64(o + 8, u >> 64n);
  }
  key(o, k) { this.d.set(unbase58(k), o); }
}

export function encodePool(p) {
  const w = new W(POOL_STATE.len, POOL_STATE.disc);
  const o = POOL_STATE;
  w.key(o.ammConfig, p.ammConfig);
  w.key(o.mint0, p.mint0);
  w.key(o.mint1, p.mint1);
  w.key(o.vault0, p.vault0);
  w.key(o.vault1, p.vault1);
  w.u8(o.decimals0, p.decimals0 ?? 9);
  w.u8(o.decimals1, p.decimals1 ?? 6);
  w.u16(o.tickSpacing, p.tickSpacing ?? 120);
  w.u128(o.sqrtPriceX64, p.price);
  w.u64(o.protocolFeesToken0, p.protocolFees0 ?? 0n);
  w.u64(o.protocolFeesToken1, p.protocolFees1 ?? 0n);
  w.u64(o.fundFeesToken0, p.fundFees0 ?? 0n);
  w.u64(o.fundFeesToken1, p.fundFees1 ?? 0n);
  return b64(w.d);
}

export function encodeTier({ tradeFeeRate = 10_000, protocolFeeRate = 104_000, fundFeeRate = 56_000 } = {}) {
  const w = new W(AMM_CONFIG.len, AMM_CONFIG.disc);
  w.u32(AMM_CONFIG.tradeFeeRate, tradeFeeRate);
  w.u32(AMM_CONFIG.protocolFeeRate, protocolFeeRate);
  w.u32(AMM_CONFIG.fundFeeRate, fundFeeRate);
  return b64(w.d);
}

const tokenAccount = (amount) => {
  const w = new W(165);
  w.u64(64, amount);
  return b64(w.d);
};

/** An event as the program logs it: its discriminator, then its fields in order. */
export function encodeEvent(name, f) {
  const spec = EVENTS[name];
  const len = spec.fields.reduce((n, [, t]) => n + { key: 32, u64: 8, u128: 16, i32: 4, u16: 2, bool: 1 }[t], 8);
  const w = new W(len, Buffer.from(spec.disc, "hex"));
  const put = {
    key: (o, v) => w.key(o, v ?? key(99)),
    u64: (o, v) => w.u64(o, v ?? 0n),
    u128: (o, v) => w.u128(o, v ?? 0n),
    i32: (o, v) => w.i32(o, v ?? 0),
    u16: (o, v) => w.u16(o, v ?? 0),
    bool: (o, v) => w.u8(o, v ? 1 : 0),
  };
  let o = 8;
  for (const [field, t] of spec.fields) {
    put[t](o, f[field]);
    o += { key: 32, u64: 8, u128: 16, i32: 4, u16: 2, bool: 1 }[t];
  }
  return b64(w.d);
}

// ── a test world ─────────────────────────────────────────────────────────────

export const T0 = Date.parse("2026-10-24T10:00:00Z") / 1000;
export const POOL = key(1);
const TIER = key(2);
const RATES = { tradeFeeRate: 10_000, protocolFeeRate: 104_000, fundFeeRate: 56_000 };
export const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

/** The log lines of one instruction of `program`, with `data` as its Program data lines. */
export function ix(program, name, data = [], depth = 1, inner = []) {
  return [
    `Program ${program} invoke [${depth}]`,
    `Program log: Instruction: ${name}`,
    ...data.map((d) => `Program data: ${d}`),
    ...inner,
    `Program ${program} consumed 1000 of 200000 compute units`,
    `Program ${program} success`,
  ];
}

export const swapData = ({ pool = POOL, amount0 = 1_000_000n, amount1 = 2_000_000n, fee0 = 10_000n, fee1 = 0n, price, zeroForOne = true, sender = key(50) }) =>
  encodeEvent("SwapEvent", { pool, sender, amount0, amount1, zeroForOne, sqrtPriceX64: price, liquidity: 10n ** 12n, tick: 0, tradeFee0: fee0, tradeFee1: fee1 });
export const collectData = ({ pool = POOL, amount0 = 0n, amount1 = 0n }) => encodeEvent("CollectProtocolFeeEvent", { pool, amount0, amount1 });
export const createdData = ({ pool = POOL, price }) => encodeEvent("PoolCreatedEvent", { pool, mint0: SOL_MINT, mint1: BAYLA_MINT, tickSpacing: 120, sqrtPriceX64: price });

/** The program's own split of a fee: 10.4% and 5.6%, each rounded down. */
export const split = (fee) => ({ vault: (fee * 104_000n) / 1_000_000n, workshop: (fee * 56_000n) / 1_000_000n });

/**
 * The instruction trace getTransaction answers beside a log: a run for each invoke line before
 * any cut, then `after`, [program, depth] runs the cut hid. `keys`: accounts no instruction runs.
 */
export function traceOf(lines, { after = [], keys = [] } = {}) {
  const cut = lines.indexOf("Log truncated");
  const logged = (cut < 0 ? lines : lines.slice(0, cut)).map((l) => /^Program (\S+) invoke \[(\d+)\]$/.exec(l)).filter(Boolean).map((m) => [m[1], Number(m[2])]);
  const runs = [...logged, ...after];
  const accountKeys = [key(60), ...new Set([...keys, ...runs.map(([p]) => p)])];
  const instructions = [];
  const innerInstructions = [];
  for (const [program, depth] of runs) {
    const programIdIndex = accountKeys.indexOf(program);
    if (depth === 1) {
      instructions.push({ programIdIndex });
      innerInstructions.push({ index: instructions.length - 1, instructions: [] });
    } else innerInstructions.at(-1).instructions.push({ programIdIndex, stackHeight: depth });
  }
  return { transaction: { message: { accountKeys, instructions } }, meta: { innerInstructions: innerInstructions.filter((g) => g.instructions.length), loadedAddresses: { writable: [], readonly: [] } } };
}

/** A landed transaction's getTransaction answer: its log, with `trace` when the RPC gives one. */
export const answer = (lines, trace = null) => ({ ...(trace ? { transaction: trace.transaction } : {}), meta: { err: null, logMessages: lines, ...(trace?.meta ?? {}) } });

/** A recorded Raydium transaction with the instruction trace that was read beside its log. */
export const withTrace = (t) => ({ ...t, transaction: t.trace.transaction, meta: { ...t.meta, ...t.trace.meta } });

/** A chain with pools, their signatures and transactions, answering the count's RPC calls. */
export function world({ slot = 5000, time = T0 + 3 * 3600 } = {}) {
  // `behind`: call by call, the slot reached by the node that lists signatures (default `slot`).
  const w = { slot, blockTimes: new Map([[slot, time]]), accounts: new Map(), programPools: [], sigs: new Map(), txs: new Map(), calls: [], gpaError: null, seq: 0, behind: [] };
  w.accounts.set(TIER, { owner: RANGE_PROGRAM_ID, data: [encodeTier(RATES), "base64"] });
  w.pool = (address = POOL, f = {}) => {
    const v0 = key(200 + w.programPools.length * 2);
    const v1 = key(201 + w.programPools.length * 2);
    const prev = w.accounts.get(address)?.fields;
    const fields = { ammConfig: TIER, mint0: SOL_MINT, mint1: BAYLA_MINT, vault0: prev?.vault0 ?? v0, vault1: prev?.vault1 ?? v1, price: 1n << 64n, ...prev, ...f };
    w.accounts.set(address, { owner: RANGE_PROGRAM_ID, data: [encodePool(fields), "base64"], fields });
    w.accounts.set(fields.vault0, { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: [tokenAccount(f.held0 ?? 0n), "base64"] });
    w.accounts.set(fields.vault1, { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: [tokenAccount(f.held1 ?? 0n), "base64"] });
    if (!w.programPools.includes(address)) w.programPools.push(address);
  };
  /** A transaction on `pools`, at `slot` (default: the next one). */
  w.tx = ({ pools = [POOL], lines, err = null, at = null, txSlot = null, missing = false, rpcError = null, trace = null } = {}) => {
    const s = txSlot ?? 100 + w.seq * 10;
    const signature = base58(Uint8Array.from({ length: 64 }, (_, i) => (w.seq * 31 + i * 7 + 3) % 256));
    w.seq++;
    const blockTime = at ?? T0 + w.seq * 60;
    for (const p of pools) {
      const list = w.sigs.get(p) ?? [];
      list.push({ signature, slot: s, err, blockTime });
      list.sort((a, b) => b.slot - a.slot);
      w.sigs.set(p, list);
    }
    if (rpcError) w.txs.set(signature, { rpcError });
    else if (!missing) {
      const a = answer(lines, trace);
      w.txs.set(signature, { slot: s, blockTime, ...a, meta: { ...a.meta, err } });
    }
    return signature;
  };
  w.advance = (slot, time) => {
    w.slot = slot;
    w.blockTimes.set(slot, time);
  };
  w.call = async (method, params) => {
    w.calls.push({ method, params });
    if (method === "getProgramAccounts") {
      if (w.gpaError) throw new RpcError(method, w.gpaError.code, w.gpaError.message);
      const f = params[1].filters;
      assert.deepEqual(f[0], { dataSize: POOL_STATE.len });
      assert.equal(f[1].memcmp.bytes, base58(Uint8Array.from(POOL_STATE.disc)));
      return { context: { slot: w.slot }, value: w.programPools.map((a) => ({ pubkey: a, account: w.accounts.get(a) })) };
    }
    if (method === "getMultipleAccounts") return { context: { slot: w.slot }, value: params[0].map((k) => w.accounts.get(k) ?? null) };
    if (method === "getBlockTime") return w.blockTimes.get(params[0]) ?? null;
    if (method === "getSignaturesForAddress") {
      const [address, { limit, until, before, minContextSlot }] = params;
      const reached = w.behind.length ? w.behind.shift() : w.slot;
      if (minContextSlot !== undefined && reached < minContextSlot) throw new RpcError(method, -32016, "Minimum context slot has not been reached");
      let list = (w.sigs.get(address) ?? []).filter((s) => s.slot <= reached);
      if (before) list = list.slice(list.findIndex((s) => s.signature === before) + 1);
      if (until) {
        const i = list.findIndex((s) => s.signature === until);
        if (i >= 0) list = list.slice(0, i);
      }
      return list.slice(0, limit);
    }
    if (method === "getTransaction") {
      assert.equal(params[1].maxSupportedTransactionVersion, 1, "a version 1 transaction is refused unless asked for");
      const t = w.txs.get(params[0]);
      if (t?.rpcError) throw new RpcError(method, t.rpcError.code, t.rpcError.message);
      return t ?? null;
    }
    throw new Error(`the fake chain has no ${method}`);
  };
  return w;
}

// ── a fake PostgREST ─────────────────────────────────────────────────────────

const KEYS = {
  range_pool: ["address"], range_cursor: ["pool"], range_swap: ["signature", "pool", "event_index"], range_collection: ["signature", "pool", "event_index"],
  range_hour: ["pool", "hour"], range_venue_snapshot: ["pool", "slot"], range_gap: ["pool", "gap_key"], range_run: ["id"],
};
// numeric(40,0) and bigint come back as JSON numbers unless cast: the fake does the same, so a
// read that forgets `::text` loses digits here as it would there.
const NUMERIC = /^(amount_[01]|fee_[01]|fees_[01]|volume_[01]|sqrt_price_x64|liquidity|(open|high|low|close)_price|protocol_fees_[01]|fund_fees_[01]|cum_.*)$/;
const GAP_KINDS = ["log-truncated", "tx-unavailable", "event-undecodable", "backlog-truncated", "history-not-backfilled", "tier-changed", "pool-list-unread"];
// The migration's CHECKs that a row the count writes could break, so a case fails where Postgres would.
const CHECKS = {
  range_gap: (r) => GAP_KINDS.includes(r.kind) && r.detail.length <= 300 && (r.from_slot == null || r.to_slot == null || r.from_slot <= r.to_slot),
  range_collection: (r) => ["vault", "workshop"].includes(r.by_whom),
  range_hour: (r) => r.swaps > 0 && (Date.parse(r.hour) / 1000) % 3600 === 0,
  range_swap: (r) => BigInt(r.sqrt_price_x64) > 0n && [r.amount_0, r.amount_1, r.fee_0, r.fee_1].every((x) => BigInt(x) >= 0n),
};
const cmp = (a, b) => {
  const s = (x) => (typeof x === "boolean" ? String(x) : x);
  const [x, y] = [s(a), s(b)];
  if (/^-?\d+$/.test(String(x)) && /^-?\d+$/.test(String(y))) return BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0;
  const dx = Date.parse(x);
  const dy = Date.parse(y);
  if (typeof x === "string" && typeof y === "string" && /T/.test(x) && Number.isFinite(dx) && Number.isFinite(dy)) return dx - dy;
  return String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
};
function test(row, col, expr) {
  const dot = expr.indexOf(".");
  const op = expr.slice(0, dot);
  const val = expr.slice(dot + 1);
  const v = row[col];
  if (op === "is") return val === "null" ? v == null : String(v) === val;
  if (v == null) return false;
  if (op === "eq") return cmp(v, val) === 0;
  if (op === "neq") return cmp(v, val) !== 0;
  if (op === "gt") return cmp(v, val) > 0;
  if (op === "gte") return cmp(v, val) >= 0;
  if (op === "lt") return cmp(v, val) < 0;
  if (op === "lte") return cmp(v, val) <= 0;
  if (op === "like") return new RegExp(`^${val.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(String(v));
  throw new Error(`the fake PostgREST has no operator ${op}`);
}

export function fakeDb({ missing = false } = {}) {
  const data = Object.fromEntries(Object.keys(KEYS).map((t) => [t, []]));
  const refuse = new Map();
  let id = 1;
  const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const table = u.pathname.replace(/^\/rest\/v1\//, "");
    if (missing || !(table in data)) return reply(404, { code: "PGRST205", message: `Could not find the table 'public.${table}'` });
    const method = init.method ?? "GET";
    if (refuse.get(table)?.(method, u)) return reply(500, { message: "refused by the test" });
    const prefer = String(new Headers(init.headers).get("Prefer") ?? "");
    const filters = [];
    let order = [];
    let limit = Infinity;
    let select = null;
    let conflict = null;
    for (const [k, v] of u.searchParams) {
      if (k === "select") select = v;
      else if (k === "order") order = v.split(",").map((o) => o.split("."));
      else if (k === "limit") limit = Number(v);
      else if (k === "on_conflict") conflict = v.split(",");
      else filters.push([k, v]);
    }
    const match = (r) => filters.every(([c, e]) => test(r, c, e));
    const project = (r) => {
      if (!select || select === "*") return { ...r };
      const out = {};
      for (const part of select.split(",")) {
        const [col, cast] = part.split("::");
        const v = r[col] ?? null;
        out[col] = v === null ? null : cast === "text" ? String(v) : NUMERIC.test(col) ? Number(v) : v;
      }
      return out;
    };
    const rows = data[table];
    if (method === "GET") {
      let got = rows.filter(match);
      for (const [col, dir] of [...order].reverse()) got = [...got].sort((a, b) => (dir === "desc" ? -1 : 1) * cmp(a[col] ?? "", b[col] ?? ""));
      return reply(200, got.slice(0, limit).map(project));
    }
    if (method === "POST") {
      const body = JSON.parse(init.body);
      const list = Array.isArray(body) ? body : [body];
      const keys = conflict ?? KEYS[table];
      const out = [];
      for (const raw of list) {
        if (CHECKS[table] && !CHECKS[table](raw)) return reply(400, { code: "23514", message: `a ${table} row breaks its CHECK` });
        const row = { ...raw };
        if (table === "range_gap" || table === "range_run") row.id ??= id++;
        if (table === "range_gap") Object.assign(row, { detected_at: row.detected_at ?? new Date().toISOString(), resolved_at: row.resolved_at ?? null });
        const same = rows.find((r) => keys.every((k) => String(r[k]) === String(row[k])));
        if (same) {
          if (prefer.includes("resolution=merge-duplicates")) Object.assign(same, raw);
          else if (!prefer.includes("resolution=ignore-duplicates")) return reply(409, { code: "23505" });
          continue;
        }
        rows.push(row);
        out.push(row);
      }
      return reply(201, prefer.includes("return=minimal") ? undefined : out);
    }
    if (method === "PATCH") {
      const body = JSON.parse(init.body);
      const hit = rows.filter(match);
      for (const r of hit) Object.assign(r, body);
      return prefer.includes("return=minimal") ? reply(204) : reply(200, hit.map((r) => ({ ...r })));
    }
    return reply(405, {});
  };
  return { fetchImpl, data, refuse };
}

export const ENV = { SUPABASE_URL: "https://db.test", SUPABASE_SERVICE_KEY: "test-service-key" };
const quiet = { log: () => {}, error: () => {} };
const noWait = async () => {};

/** One run of the count over `w` into `db`. */
export const run = (w, db, opts = {}) => main({ env: ENV, fetchImpl: db.fetchImpl, call: w.call, wait: noWait, now: () => (w.blockTimes.get(w.slot) + 60) * 1000, registry: [], ...quiet, ...opts });

/**
 * A pool with a week of history, counted twice, for the endpoint's tests and the walk: opened,
 * three swaps (one a fill with no range in use), a vault collection, then a day later two more.
 */
export async function seededPool({ pool = POOL, base = T0 } = {}) {
  const w = world({ slot: 400, time: base + 2 * 3600 });
  const db = fakeDb();
  const p0 = 79228162514264337593543950336n;
  const price = (i) => p0 + BigInt(i) * 1_000_000_000n;
  let vault = 0n;
  let workshop = 0n;
  const swap = (i, fee, noRange = 0n) => {
    const s = split(fee);
    vault += s.vault + noRange;
    workshop += s.workshop;
    return swapData({ pool, fee0: fee, price: price(i), amount0: fee * 100n });
  };
  const at = (txSlot, t, name, data) => w.tx({ pools: [pool], lines: ix(RANGE_PROGRAM_ID, name, data), txSlot, at: base + t });
  at(100, 0, "CreatePool", [createdData({ pool, price: price(0) })]);
  at(150, 600, "SwapV2", [swap(1, 30_000n)]);
  at(200, 1800, "SwapV2", [swap(2, 50_000n, 21_000n)]);
  at(250, 3700, "SwapV2", [swap(3, 20_000n)]);
  at(300, 4000, "CollectProtocolFee", [collectData({ pool, amount0: 5_000n })]);
  vault -= 5_000n;
  w.pool(pool, { price: price(3), protocolFees0: vault, fundFees0: workshop, held0: 5_000_000_000n });
  assert.equal(await run(w, db), 0);
  w.advance(9000, base + 26 * 3600);
  at(8000, 25 * 3600, "SwapV2", [swap(4, 40_000n)]);
  at(8500, 25 * 3600 + 600, "SwapV2", [swap(5, 60_000n)]);
  w.pool(pool, { price: price(5), protocolFees0: vault, fundFees0: workshop });
  assert.equal(await run(w, db), 0);
  return { w, db, end: base + 26 * 3600, fees: 200_000n, noRange: 21_000n, collected: 5_000n, vault: vault + 5_000n, workshop };
}

// ── the cases ────────────────────────────────────────────────────────────────

const freshPool = (w) => ({ address: POOL, slot: w.slot, blockTime: w.blockTimes.get(w.slot), rates: RATES, ...poolFields(w) });
const poolFields = (w) => {
  const f = w.accounts.get(POOL).fields;
  return { ammConfig: f.ammConfig, mint0: f.mint0, mint1: f.mint1, vault0: f.vault0, vault1: f.vault1, sqrtPriceX64: f.price, protocolFees0: f.protocolFees0 ?? 0n, protocolFees1: 0n, fundFees0: f.fundFees0 ?? 0n, fundFees1: 0n };
};
const countOnce = (w, cursor = null) => countPool({ call: w.call, pool: freshPool(w), cursor, budget: { left: 2000 }, deadline: Infinity, wait: noWait });

export const CASES = [
  [
    "a `Program data:` line from another program's frame is ignored",
    async () => {
      // Jupiter's SwapEvent shares our discriminator; a stranger's program can log any bytes.
      const fake = swapData({ fee0: 9_000_000n, price: 5n << 64n });
      const real = swapData({ fee0: 10_000n, price: 2n << 64n });
      const lines = [
        `Program ${JUPITER} invoke [1]`,
        `Program data: ${fake}`,
        ...ix(RANGE_PROGRAM_ID, "SwapV2", [real], 2),
        `Program data: ${fake}`,
        `Program ${JUPITER} success`,
        ...ix(key(77), "Anything", [fake]),
      ];
      const read = rangeTxEvents({ meta: { err: null, logMessages: lines } });
      assert.equal(read.status, "ok");
      assert.equal(read.events.length, 1);
      assert.equal(read.events[0].tradeFee0, 10_000n);
      const w = world();
      w.tx({ lines, txSlot: 100 });
      w.pool(POOL, { price: 2n << 64n });
      const out = await countOnce(w);
      assert.equal(out.cursor.totals.fees_0, "10000");
      assert.equal(out.rows.swaps.length, 1);
      // Real mainnet logs: another pool program's Program data lines sit beside Raydium's.
      for (const t of RAYDIUM.txs.filter((x) => !x.meta.logMessages.includes("Log truncated"))) {
        const r = rangeTxEvents(t, RAYDIUM.program);
        assert.equal(r.status, "ok", t.signature);
        const ours = r.events.filter((e) => e.name === "SwapEvent" && e.pool === t.pool);
        assert.ok(ours.some((e) => Buffer.from(fromBase64(t.event)).equals(Buffer.from(fromBase64(encodeBack(e))))), `${t.signature}: the recorded event is among the decoded ones`);
        const all = t.meta.logMessages.filter((l) => l.startsWith("Program data: ")).length;
        assert.ok(r.events.length <= all);
      }
      assert.ok(RAYDIUM.txs.some((t) => programFrames(t.meta.logMessages, RAYDIUM.program).events.length < t.meta.logMessages.filter((l) => l.startsWith("Program data: ")).length), "a real log carries another program's data lines");
    },
  ],
  [
    "a failed transaction is ignored",
    async () => {
      const lines = ix(RANGE_PROGRAM_ID, "SwapV2", [swapData({ fee0: 70_000n, price: 3n << 64n })]);
      assert.deepEqual(rangeTxEvents({ meta: { err: { InstructionError: [1, "Custom"] }, logMessages: lines } }), { status: "failed" });
      const w = world();
      w.tx({ lines, err: { InstructionError: [1, { Custom: 6022 }] }, txSlot: 100 });
      // A signature listed as landed whose transaction says it failed: ignored all the same.
      const landed = w.tx({ lines, txSlot: 110 });
      w.txs.get(landed).meta.err = { InstructionError: [2, { Custom: 1 }] };
      w.pool();
      const out = await countOnce(w);
      assert.equal(out.cursor.totals.swaps, "0");
      assert.equal(out.cursor.totals.fees_0, "0");
      assert.deepEqual(out.rows.gaps.map((g) => g.kind), ["history-not-backfilled"]);
      assert.equal(w.calls.filter((c) => c.method === "getTransaction").length, 1, "a signature listed as failed is not fetched");
    },
  ],
  [
    "a truncated log is a gap row and its fee is not summed",
    async () => {
      const w = world();
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "CreatePool", [createdData({ price: 1n << 64n })]), txSlot: 100 });
      w.tx({ lines: [...ix(RANGE_PROGRAM_ID, "SwapV2", [swapData({ fee0: 50_000n, price: 2n << 64n })]), "Log truncated"], txSlot: 200 });
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "SwapV2", [swapData({ fee0: 10_000n, price: 3n << 64n })]), txSlot: 300 });
      w.pool(POOL, { price: 3n << 64n });
      const out = await countOnce(w);
      assert.equal(out.cursor.totals.fees_0, "10000");
      assert.equal(out.rows.swaps.length, 1);
      const gap = out.rows.gaps.find((g) => g.kind === "log-truncated");
      assert.ok(gap, "a gap row");
      assert.equal(gap.standing, false);
      assert.equal(gap.from_slot, 200);
      assert.equal(gap.to_slot, 200);
      // The real one: a Raydium swap cut off mid-log, with a line after the cut.
      const real = RAYDIUM.txs.find((t) => t.meta.logMessages.includes("Log truncated"));
      assert.equal(rangeTxEvents(real, RAYDIUM.program).status, "truncated");
    },
  ],
  [
    "pools past the cap become backlog rows; registry pools are always counted",
    async () => {
      const w = world();
      const pools = [key(10), key(11), key(12), key(13)];
      // The registry's pool holds the least, so by balance alone it would be last.
      pools.forEach((p, i) => w.pool(p, { held0: BigInt(1000 - i * 100) }));
      for (const p of pools) w.tx({ pools: [p], lines: ix(RANGE_PROGRAM_ID, "CreatePool", [createdData({ pool: p, price: 1n << 64n })]) });
      const db = fakeDb();
      assert.equal(await run(w, db, { registry: [pools[3]], limits: { maxPools: 2, maxTransactions: 2000, maxSignaturePages: 20, runBudgetMs: 60_000 } }), 0);
      const counted = db.data.range_cursor.map((c) => c.pool).sort();
      assert.deepEqual(counted, [pools[0], pools[3]].sort());
      const backlog = db.data.range_gap.filter((g) => g.kind === "backlog-truncated");
      assert.deepEqual(backlog.map((g) => g.pool).sort(), [pools[1], pools[2]].sort());
      assert.ok(backlog.every((g) => g.standing === false && g.resolved_at === null));
      assert.equal(db.data.range_pool.find((p) => p.address === pools[3]).registry, true);
      assert.deepEqual(orderPools([{ address: "a", mint0: "x", mint1: "y" }], ["a"], 0).counted.map((p) => p.address), ["a"], "even with no room left");
    },
  ],
  [
    "a collection is the vault's or the Workshop's by the instruction that ran; any other is a gap",
    async () => {
      const w = world();
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "CreatePool", [createdData({ price: 1n << 64n })]), txSlot: 100 });
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "CollectProtocolFee", [collectData({ amount0: 7n, amount1: 8n })]), txSlot: 200 });
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "CollectFundFee", [collectData({ amount0: 3n })]), txSlot: 300 });
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "SomethingNew", [collectData({ amount0: 1n })]), txSlot: 400 });
      w.pool();
      const out = await countOnce(w);
      assert.deepEqual(out.rows.collections.map((c) => [c.by_whom, c.amount_0, c.amount_1]), [["vault", "7", "8"], ["workshop", "3", "0"]]);
      assert.equal(out.cursor.totals.vault_collected_1, "8");
      assert.equal(out.cursor.totals.workshop_collected_0, "3");
      assert.equal(out.rows.gaps.filter((g) => g.kind === "event-undecodable").length, 1);
    },
  ],
  [
    "a pool's price that is not its last counted swap's is a gap over the span after that swap",
    async () => {
      const w = world();
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "CreatePool", [createdData({ price: 1n << 64n })]), txSlot: 100 });
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "SwapV2", [swapData({ price: 2n << 64n })]), txSlot: 200 });
      w.pool(POOL, { price: 9n << 64n });
      const out = await countOnce(w);
      const g = out.rows.gaps.find((x) => x.gap_key.startsWith("tx-unavailable:price:"));
      assert.ok(g, "a gap row");
      assert.deepEqual([g.from_slot, g.to_slot], [201, w.slot]);
      assert.ok(out.snapshot, "the snapshot is still written: the counters are the program's");
      const ok = world();
      ok.tx({ lines: ix(RANGE_PROGRAM_ID, "CreatePool", [createdData({ price: 1n << 64n })]), txSlot: 100 });
      ok.tx({ lines: ix(RANGE_PROGRAM_ID, "SwapV2", [swapData({ price: 2n << 64n })]), txSlot: 200 });
      ok.pool(POOL, { price: 2n << 64n });
      assert.equal((await countOnce(ok)).rows.gaps.length, 0);
    },
  ],
  [
    "a transaction the RPC will not serve is a gap and the count moves on; an outage moves nothing",
    async () => {
      const w = world();
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "CreatePool", [createdData({ price: 1n << 64n })]), txSlot: 100 });
      w.tx({ missing: true, txSlot: 200 });
      w.tx({ rpcError: { code: -32015, message: "Transaction version (2) is not supported" }, txSlot: 300 });
      w.pool();
      const out = await countOnce(w);
      assert.deepEqual(out.rows.gaps.map((g) => [g.kind, g.from_slot]), [["tx-unavailable", 200], ["tx-unavailable", 300]]);
      assert.equal(out.cursor.through_slot, w.slot);
      const down = world();
      down.tx({ rpcError: { code: -32603, message: "internal" }, txSlot: 100 });
      down.pool();
      await assert.rejects(countOnce(down), /internal/);
    },
  ],
  [
    "a run whose cursor write is refused changes nothing the next run counts twice",
    async () => {
      const w = world();
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "CreatePool", [createdData({ price: 1n << 64n })]), txSlot: 100 });
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "SwapV2", [swapData({ fee0: 10_000n, price: 2n << 64n })]), txSlot: 200 });
      w.pool(POOL, { price: 2n << 64n });
      const db = fakeDb();
      db.refuse.set("range_cursor", (method) => method === "POST");
      assert.equal(await run(w, db), 1);
      assert.equal(db.data.range_venue_snapshot.filter((s) => !s.at_open).length, 0, "no snapshot without its cursor");
      db.refuse.clear();
      assert.equal(await run(w, db), 0);
      assert.equal(db.data.range_swap.length, 1);
      assert.equal(db.data.range_cursor[0].totals.fees_0, "10000");
      const snap = db.data.range_venue_snapshot.find((s) => !s.at_open);
      assert.equal(snap.cum_fees_0, "10000");
      assert.equal(await run(w, db), 0, "a third run with nothing new");
      assert.equal(db.data.range_cursor[0].totals.fees_0, "10000");
      assert.equal(db.data.range_cursor[0].version, 2);
    },
  ],
  [
    "a cursor whose signature the RPC no longer finds counts nothing twice",
    async () => {
      const w = world();
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "CreatePool", [createdData({ price: 1n << 64n })]), txSlot: 100 });
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "SwapV2", [swapData({ fee0: 10_000n, price: 2n << 64n })]), txSlot: 200 });
      w.pool(POOL, { price: 2n << 64n });
      const first = await countOnce(w);
      const out = await countOnce(w, { ...first.cursor, last_signature: key(123) });
      assert.equal(out.cursor.totals.fees_0, "10000");
      assert.equal(out.rows.swaps.length, 0);
    },
  ],
  [
    "hours close once the count passes them, with the first, highest, lowest and last price",
    async () => {
      const w = world({ slot: 900, time: T0 + 3 * 3600 });
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "CreatePool", [createdData({ price: 5n << 64n })]), txSlot: 100, at: T0 + 60 });
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "SwapV2", [swapData({ fee0: 1n, price: 6n << 64n })]), txSlot: 200, at: T0 + 120 });
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "SwapV2", [swapData({ fee0: 2n, price: 4n << 64n }), swapData({ fee0: 3n, price: 5n << 64n })]), txSlot: 300, at: T0 + 180 });
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "SwapV2", [swapData({ fee0: 4n, price: 7n << 64n })]), txSlot: 400, at: T0 + 3600 + 5 });
      w.pool(POOL, { price: 7n << 64n });
      const out = await countOnce(w);
      assert.equal(out.rows.hours.length, 2);
      const [h] = out.rows.hours;
      assert.equal(h.hour, new Date(T0 * 1000).toISOString());
      assert.deepEqual([h.swaps, h.fees_0, h.open_price, h.high_price, h.low_price, h.close_price], [3, "6", String(6n << 64n), String(6n << 64n), String(4n << 64n), String(5n << 64n)]);
      assert.equal(out.cursor.open_hour, null);
      assert.deepEqual(out.rows.swaps.map((s) => s.event_index), [0, 0, 1, 0]);
    },
  ],
  [
    "a tier whose rates changed since the last read is a standing gap: only the no-range share is withheld",
    async () => {
      const w = world();
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "CreatePool", [createdData({ price: 1n << 64n })]), txSlot: 100 });
      w.pool();
      const first = await countOnce(w);
      assert.equal(first.rows.gaps.length, 0);
      assert.deepEqual(first.cursor.last_rates, RATES);
      const out = await countOnce(w, { ...first.cursor, last_rates: { ...RATES, protocolFeeRate: 200_000 } });
      const g = out.rows.gaps.find((x) => x.kind === "tier-changed");
      assert.equal(g.standing, true);
      assert.ok(g.from_slot <= g.to_slot, "a valid span even with no new slot");
    },
  ],
  [
    "no wallet is kept: a swap's sender is never written",
    async () => {
      const { db } = await seededPool();
      const sender = key(50);
      for (const [table, rows] of Object.entries(db.data)) assert.ok(!JSON.stringify(rows).includes(sender), `${table} holds no sender`);
      assert.ok(!Object.keys(db.data.range_swap[0]).some((k) => /sender|wallet|owner|person/.test(k)));
    },
  ],
  [
    "before migration 030 the job says so, writes nothing and stays green",
    async () => {
      const w = world();
      w.pool();
      const db = fakeDb({ missing: true });
      const said = [];
      assert.equal(await run(w, db, { log: (m) => said.push(m) }), 0);
      assert.ok(said.some((m) => m.includes("Migration 030 has not been applied")));
      assert.equal(w.calls.length, 0, "no chain read either");
      assert.equal(await main({ env: {}, call: w.call, registry: [], log: () => {}, error: () => {} }), 1, "missing secrets are red");
    },
  ],
  [
    "a refused pool list counts the pools already known, writes a gap and is red",
    async () => {
      const w = world();
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "CreatePool", [createdData({ price: 1n << 64n })]), txSlot: 100 });
      w.pool();
      const db = fakeDb();
      assert.equal(await run(w, db), 0);
      w.gpaError = { code: -32010, message: "excluded from account secondary indexes" };
      assert.equal(await run(w, db), 1);
      const g = db.data.range_gap.find((x) => x.kind === "pool-list-unread");
      assert.equal(g.pool, RANGE_PROGRAM_ID);
      assert.equal(g.resolved_at, null);
      assert.equal(db.data.range_cursor[0].version, 2, "the known pool was still counted");
      w.gpaError = null;
      assert.equal(await run(w, db), 0);
      assert.notEqual(db.data.range_gap.find((x) => x.kind === "pool-list-unread").resolved_at, null);
    },
  ],
  [
    "events decode at the program's own lengths and refuse any other",
    async () => {
      for (const t of RAYDIUM.txs) assert.equal(decodeEvent(fromBase64(t.event)).pool, t.pool);
      const bad = Buffer.concat([Buffer.from(fromBase64(swapData({ price: 1n }))), Buffer.from([0])]).toString("base64");
      assert.equal(rangeTxEvents({ meta: { err: null, logMessages: ix(RANGE_PROGRAM_ID, "SwapV2", [bad]) } }).status, "undecodable");
      const nested = [`Program ${RANGE_PROGRAM_ID} invoke [2]`, `Program ${RANGE_PROGRAM_ID} success`];
      assert.equal(rangeTxEvents({ meta: { err: null, logMessages: nested } }).status, "malformed");
      assert.equal(rangeTxEvents({ meta: { err: null } }).status, "no-log");
    },
  ],
  [
    "a node behind the pool read refuses to list, so nothing in the slots it lacks is lost",
    async () => {
      const w = world();
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "CreatePool", [createdData({ price: 1n << 64n })]), txSlot: 100 });
      w.pool();
      const db = fakeDb();
      assert.equal(await run(w, db), 0);
      // A collection moves no price, so the price check cannot see it go missing.
      w.advance(9000, T0 + 4 * 3600);
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "CollectProtocolFee", [collectData({ amount0: 3_000n })]), txSlot: 8900 });
      w.behind.push(8800);
      assert.equal(await run(w, db), 0);
      assert.equal(db.data.range_cursor[0].totals.vault_collected_0, "3000");
      assert.equal(db.data.range_cursor[0].through_slot, 9000);
      // A node that stays behind: the pool waits a run with its cursor where it was.
      w.advance(9500, T0 + 5 * 3600);
      w.behind.push(9400, 9400, 9400, 9400, 9400);
      assert.equal(await run(w, db), 1);
      assert.equal(db.data.range_cursor[0].through_slot, 9000);
      assert.match(db.data.range_cursor[0].last_error, /Minimum context slot/);
      assert.ok(w.calls.filter((c) => c.method === "getSignaturesForAddress").every((c) => c.params[1].minContextSlot > 0));
    },
  ],
  [
    "a cut log is no hole when the trace says our program never ran in it, or ran wholly before the cut",
    async () => {
      const filler = [1, 2, 3].flatMap(() => ix(key(77), "Noop"));
      const cut = (lines) => [...lines, "Log truncated"];
      // A stranger lists the pool in a transaction of its own and runs the log past the limit.
      const stranger = cut(filler);
      const ours = ix(RANGE_PROGRAM_ID, "SwapV2", [swapData({ fee0: 10_000n, price: 2n << 64n })]);
      const before = cut([...ours, ...filler]);
      const w = world();
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "CreatePool", [createdData({ price: 1n << 64n })]), txSlot: 100 });
      w.tx({ lines: stranger, txSlot: 200, trace: traceOf(stranger, { keys: [POOL] }) });
      w.tx({ lines: stranger, txSlot: 250, trace: traceOf(stranger, { keys: [POOL, RANGE_PROGRAM_ID] }) });
      w.tx({ lines: before, txSlot: 300, trace: traceOf(before, { keys: [POOL] }) });
      w.pool(POOL, { price: 2n << 64n });
      const out = await countOnce(w);
      assert.deepEqual(out.rows.gaps, []);
      assert.equal(out.cursor.totals.fees_0, "10000");
      // Still a hole: ours ran again after the cut, was cut mid-frame, or the trace was not read.
      assert.equal(rangeTxEvents(answer(before, traceOf(before, { after: [[RANGE_PROGRAM_ID, 1]] }))).status, "truncated");
      const mid = cut(ours.slice(0, 3));
      assert.equal(rangeTxEvents(answer(mid, traceOf(mid))).status, "truncated");
      assert.equal(rangeTxEvents(answer(before)).status, "truncated");
      // A whole log that shows a run the trace lacks, or lacks one the trace has, is not read.
      assert.equal(rangeTxEvents(answer(ours, traceOf(filler))).status, "malformed");
      assert.equal(rangeTxEvents(answer(ours, traceOf(ours, { after: [[RANGE_PROGRAM_ID, 1]] }))).status, "malformed");
      // Real: Raydium ran once, inside Jupiter, from an address table, and ended before the cut.
      for (const t of RAYDIUM.txs) {
        const runs = t.meta.logMessages.filter((l) => l.startsWith(`Program ${RAYDIUM.program} invoke`)).length;
        assert.equal(RangeEvents.invocations?.(withTrace(t), RAYDIUM.program), runs, t.signature);
        const read = rangeTxEvents(withTrace(t), RAYDIUM.program);
        assert.equal(read.status, "ok", t.signature);
        assert.ok(read.events.some((e) => e.name === "SwapEvent" && encodeBack(e) === t.event), `${t.signature}: the recorded event`);
      }
    },
  ],
  [
    "a pool whose address was sent to before it opened still has its zero point",
    async () => {
      // Anyone can send to the pool's address before it is made, and the creation still lands.
      const transfer = ix("11111111111111111111111111111111", "Transfer");
      for (const cap of [2000, 1]) {
        const w = world();
        w.tx({ lines: transfer, txSlot: 50, trace: traceOf(transfer, { keys: [POOL] }) });
        w.tx({ lines: ix(RANGE_PROGRAM_ID, "CreatePool", [createdData({ price: 1n << 64n })]), txSlot: 100 });
        w.tx({ lines: ix(RANGE_PROGRAM_ID, "SwapV2", [swapData({ fee0: 10_000n, price: 2n << 64n })]), txSlot: 200 });
        w.pool(POOL, { price: 2n << 64n, protocolFees0: 1_040n, fundFees0: 560n });
        const db = fakeDb();
        // With a cap of 1, the transfer, the creation and the swap are each a run of their own.
        for (let i = 0; i < 3; i++) await run(w, db, { limits: { ...LIMITS, maxTransactions: cap } });
        assert.deepEqual(db.data.range_venue_snapshot.filter((s) => s.at_open).map((s) => s.slot), [99], `cap ${cap}`);
        assert.deepEqual(db.data.range_gap.filter((g) => g.resolved_at === null).map((g) => g.kind), [], `cap ${cap}`);
        assert.equal(db.data.range_pool[0].opened_slot, 100);
        assert.equal(db.data.range_cursor[0].totals.fees_0, "10000");
      }
    },
  ],
  [
    "a run cut short writes no snapshot, so no window pairs the pool's counters with totals that stop early",
    async () => {
      const w = world();
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "CreatePool", [createdData({ price: 1n << 64n })]), txSlot: 100 });
      for (const [slot, fee] of [[200, 10_000n], [300, 20_000n], [400, 30_000n]]) w.tx({ lines: ix(RANGE_PROGRAM_ID, "SwapV2", [swapData({ fee0: fee, price: BigInt(slot) << 64n })]), txSlot: slot });
      w.pool(POOL, { price: 400n << 64n, protocolFees0: 6_240n, fundFees0: 3_360n });
      const db = fakeDb();
      assert.equal(await run(w, db, { limits: { ...LIMITS, maxTransactions: 2 } }), 0);
      assert.equal(db.data.range_cursor[0].through_slot, 200);
      assert.deepEqual(db.data.range_venue_snapshot.filter((s) => !s.at_open), [], "no snapshot of slot 5000's counters beside totals cut at slot 200");
      assert.equal(await run(w, db), 0);
      assert.deepEqual(db.data.range_venue_snapshot.filter((s) => !s.at_open).map((s) => [s.slot, s.cum_fees_0]), [[w.slot, "60000"]]);
    },
  ],
  [
    "a pool that waits keeps its open waiting row until a run counts it to the newest slot",
    async () => {
      const w = world();
      const [A, B] = [key(10), key(11)];
      w.pool(A, { held0: 2000n });
      w.pool(B, { held0: 1000n });
      for (const p of [A, B]) w.tx({ pools: [p], lines: ix(RANGE_PROGRAM_ID, "CreatePool", [createdData({ pool: p, price: 1n << 64n })]) });
      const db = fakeDb();
      const tight = { limits: { ...LIMITS, maxTransactions: 2 } };
      const swapOn = (p, txSlot) => w.tx({ pools: [p], lines: ix(RANGE_PROGRAM_ID, "SwapV2", [swapData({ pool: p, price: 1n << 64n })]), txSlot });
      const waiting = () => db.data.range_gap.filter((g) => g.pool === B && g.gap_key.startsWith("backlog-truncated:wait:") && g.resolved_at === null).map((g) => g.gap_key);
      const through = (p) => db.data.range_cursor.find((c) => c.pool === p).through_slot;
      assert.equal(await run(w, db, tight), 0);
      // A, which holds more, takes the run's two transactions; B waits.
      w.advance(6000, T0 + 4 * 3600);
      [[A, 5100], [A, 5200], [B, 5300]].forEach(([p, s]) => swapOn(p, s));
      assert.equal(await run(w, db, tight), 0);
      assert.deepEqual(waiting(), ["backlog-truncated:wait:5001"]);
      // Again no room for B: it is still waiting, from the same slot.
      w.advance(7000, T0 + 5 * 3600);
      [[A, 6100], [A, 6200]].forEach(([p, s]) => swapOn(p, s));
      assert.equal(await run(w, db, tight), 0);
      assert.equal(through(B), 5000);
      assert.deepEqual(waiting(), ["backlog-truncated:wait:5001"]);
      // Room at last: B is counted to the newest slot and waits no more.
      assert.equal(await run(w, db, tight), 0);
      assert.equal(through(B), 7000);
      assert.deepEqual(waiting(), []);
    },
  ],
  [
    "a transaction after the pool read is summed against the next snapshot, not this one",
    async () => {
      const w = world();
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "CreatePool", [createdData({ price: 1n << 64n })]), txSlot: 100 });
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "SwapV2", [swapData({ fee0: 10_000n, price: 2n << 64n })]), txSlot: 300 });
      w.pool(POOL);
      // The pool read at slot 250: its counters do not hold the swap at 300 yet.
      const early = await countPool({ call: w.call, pool: { ...freshPool(w), slot: 250 }, cursor: null, budget: { left: 2000 }, deadline: Infinity, wait: noWait });
      assert.deepEqual([early.cursor.totals.fees_0, early.cursor.through_slot, early.snapshot.cum_fees_0], ["0", 250, "0"]);
      w.pool(POOL, { price: 2n << 64n, protocolFees0: 1_040n, fundFees0: 560n });
      const next = await countOnce(w, early.cursor);
      assert.deepEqual([next.cursor.totals.fees_0, next.snapshot.cum_fees_0], ["10000", "10000"]);
    },
  ],
  [
    "a pool read at a slot before the count's is not counted that run",
    async () => {
      const w = world();
      w.tx({ lines: ix(RANGE_PROGRAM_ID, "CreatePool", [createdData({ price: 1n << 64n })]), txSlot: 100 });
      w.pool();
      const first = await countOnce(w);
      const older = { ...freshPool(w), slot: 4000 };
      await assert.rejects(countPool({ call: w.call, pool: older, cursor: first.cursor, budget: { left: 2000 }, deadline: Infinity, wait: noWait }), /before the count's slot 5000/);
    },
  ],
];

/** The bytes a decoded SwapEvent came from, rebuilt, to compare with a recorded one. */
function encodeBack(e) {
  return encodeEvent("SwapEvent", e);
}

export async function runSelfTest({ log = console.log, error = console.error } = {}) {
  let failed = 0;
  for (const [name, fn] of CASES) {
    try {
      await fn();
      log(`ok   ${name}`);
    } catch (e) {
      failed++;
      error(`FAIL ${name}\n     ${e?.stack ?? e}`);
    }
  }
  log(`${CASES.length - failed} of ${CASES.length} range-stats cases passed`);
  return failed ? 1 : 0;
}
