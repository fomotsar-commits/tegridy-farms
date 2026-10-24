#!/usr/bin/env node
// The venue's own count of every range pool's swaps, run hourly by range-stats.yml into
// migration 030's tables, which api/_lib/rangeStats.js serves. From the repo root:
//   node frontend/scripts/range-stats.mjs            (SUPABASE_URL, SUPABASE_SERVICE_KEY)
//   node frontend/scripts/range-stats.mjs --dry-run  (no secrets: from zero, writes nothing)
//   node frontend/scripts/range-stats.mjs --self-test
// Exit 1 when a pool, the pool list or a write did not complete this run.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { POOL_STATE, RANGE_PROGRAM_ID, base58, decodeAmmConfigRates, decodePool, fromBase64, rangeTxEvents } from "../api/_lib/rangeEvents.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const BAYLA_MINT = "7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump";
/** After the registry's pools, pools are counted by the first of these they hold, then by how much. */
export const PAIRING = [SOL_MINT, USDC_MINT, BAYLA_MINT];

/** A run's caps. Pools past them wait for the next run as backlog rows; the registry's never do. */
export const LIMITS = Object.freeze({ maxPools: 40, maxTransactions: 2000, maxSignaturePages: 20, runBudgetMs: 20 * 60 * 1000 });

export const TOTAL_KEYS = ["swaps", "volume_0", "volume_1", "fees_0", "fees_1", "vault_collected_0", "vault_collected_1", "workshop_collected_0", "workshop_collected_1"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (sec) => new Date(sec * 1000).toISOString();
const hourOf = (sec) => iso(Math.floor(sec / 3600) * 3600);

// ── chain ────────────────────────────────────────────────────────────────────

/** A JSON-RPC error, with its code, so a refusal of one transaction can be told from an outage. */
export class RpcError extends Error {
  constructor(method, code, message) {
    super(`${method}: ${message}`);
    this.code = code;
  }
}

// The RPC says it will never serve this transaction (pruned, skipped, a newer version): the
// count leaves a gap row and moves on. Any other failure stops the pool where it was.
const WILL_NOT_SERVE = new Set([-32004, -32007, -32009, -32011, -32015]);

/** Keyless Solana JSON-RPC, retried on 429, 5xx and dropped connections. */
export function rpc({ fetchImpl = globalThis.fetch, url = SOLANA_RPC, pauseMs = 250, wait = sleep } = {}) {
  return async function call(method, params) {
    let last = "";
    for (let i = 0; i < 8; i++) {
      if (pauseMs) await wait(pauseMs);
      let r;
      try {
        r = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        last = e.message;
        await wait(2000 * (i + 1));
        continue;
      }
      if (r.status === 429 || r.status >= 500) {
        last = `HTTP ${r.status}`;
        await wait(2500 * (i + 1));
        continue;
      }
      let j;
      try {
        j = await r.json();
      } catch {
        last = `HTTP ${r.status}, not JSON`;
        await wait(2000 * (i + 1));
        continue;
      }
      if (j.error) throw new RpcError(method, j.error.code ?? null, String(j.error.message ?? "").slice(0, 160));
      return j.result;
    }
    throw new RpcError(method, null, `no answer after 8 tries (${last})`);
  };
}

/** The RPC's refusal when its node has not reached `minContextSlot`. */
export const MIN_CONTEXT_SLOT_NOT_REACHED = -32016;

// A node behind `atSlot` refuses rather than list short. The public RPC spreads calls over
// nodes, so a later try usually meets one that has caught up; else the pool waits a run.
async function listedFrom(call, params, atSlot, wait) {
  for (let i = 0; ; i++) {
    try {
      return await call("getSignaturesForAddress", [params[0], { ...params[1], minContextSlot: atSlot }]);
    } catch (e) {
      if (e?.code !== MIN_CONTEXT_SLOT_NOT_REACHED || i >= 4) throw e;
      await wait(2000 * (i + 1));
    }
  }
}

/**
 * The address's finalized signatures after slot `through`, oldest first, from a node that has
 * reached `atSlot`. `reachedEnd`: paging met `until`, that slot or the first signature.
 */
export async function signaturesSince(call, address, until, through, maxPages, atSlot, wait = sleep) {
  const out = [];
  let before;
  for (let page = 0; page < maxPages; page++) {
    const got = await listedFrom(call, [address, { limit: 1000, commitment: "finalized", ...(until ? { until } : {}), ...(before ? { before } : {}) }], atSlot, wait);
    if (!Array.isArray(got)) throw new Error("getSignaturesForAddress did not answer a list");
    out.push(...got);
    if (got.length < 1000 || got[got.length - 1].slot <= through) return { list: out.reverse(), reachedEnd: true };
    before = got[got.length - 1].signature;
  }
  return { list: out.reverse(), reachedEnd: false };
}

/** One transaction, version 1 included (mainnet carries them since 2026-10). */
async function fetchTx(call, signature, wait) {
  for (let i = 0; i < 2; i++) {
    try {
      const tx = await call("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "finalized" }]);
      if (tx) return { tx };
    } catch (e) {
      if (!WILL_NOT_SERVE.has(e?.code)) throw e;
      return { unavailable: e.message };
    }
    await wait(2000);
  }
  return { unavailable: "getTransaction answered null twice" };
}

async function getMany(call, keys) {
  const out = new Map();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const got = await call("getMultipleAccounts", [chunk, { encoding: "base64", commitment: "finalized" }]);
    if (!Array.isArray(got?.value) || got.value.length !== chunk.length) throw new Error("getMultipleAccounts did not answer every account");
    chunk.forEach((k, j) => out.set(k, got.value[j] ? { ...got.value[j], slot: got.context?.slot } : null));
  }
  return out;
}

function poolOf(address, account, slot) {
  if (account?.owner !== RANGE_PROGRAM_ID) throw new Error(`${address} is not the range program's`);
  return { address, slot, ...decodePool(account.data[0]) };
}

/**
 * Every pool of the program, each at the slot it was read. When the program scan is refused,
 * the pools the count already knows are read instead and `listRead` is false.
 */
export async function listPools(call, known) {
  try {
    const got = await call("getProgramAccounts", [
      RANGE_PROGRAM_ID,
      { encoding: "base64", commitment: "finalized", withContext: true, filters: [{ dataSize: POOL_STATE.len }, { memcmp: { offset: 0, bytes: base58(Uint8Array.from(POOL_STATE.disc)) } }] },
    ]);
    const slot = got?.context?.slot;
    if (!Number.isSafeInteger(slot) || !Array.isArray(got?.value)) throw new Error("getProgramAccounts did not answer a slot and a list");
    return { listRead: true, listError: null, pools: got.value.map((a) => poolOf(a.pubkey, a.account, slot)) };
  } catch (e) {
    const accounts = await getMany(call, known);
    const pools = known.filter((k) => accounts.get(k)).map((k) => poolOf(k, accounts.get(k), accounts.get(k).slot));
    return { listRead: false, listError: String(e.message).slice(0, 200), pools };
  }
}

/** Each pool's tier rates and its vaults' balances; a part that does not read stays null. */
async function readSide(call, pools, warn) {
  const tiers = [...new Set(pools.map((p) => p.ammConfig))];
  try {
    const got = await getMany(call, [...tiers, ...pools.flatMap((p) => [p.vault0, p.vault1])]);
    for (const p of pools) {
      const tier = got.get(p.ammConfig);
      try {
        p.rates = tier?.owner === RANGE_PROGRAM_ID ? decodeAmmConfigRates(tier.data[0]) : null;
      } catch {
        p.rates = null;
      }
      const held = (v) => {
        const d = got.get(v) ? fromBase64(got.get(v).data[0]) : null;
        return d && d.length >= 72 ? new DataView(d.buffer, d.byteOffset).getBigUint64(64, true) : null;
      };
      p.held0 = held(p.vault0);
      p.held1 = held(p.vault1);
    }
  } catch (e) {
    warn(`tiers and vaults not read: ${e.message}`);
    for (const p of pools) Object.assign(p, { rates: null, held0: null, held1: null });
  }
}

async function blockTimes(call, slots) {
  const out = new Map();
  for (const slot of new Set(slots)) {
    try {
      const t = await call("getBlockTime", [slot]);
      out.set(slot, Number.isSafeInteger(t) ? t : null);
    } catch {
      out.set(slot, null);
    }
  }
  return out;
}

/** The registry's range pools, in file order (scripts/addresses.json, `range-pool-*` rows). */
export function registryPools(addresses) {
  return (addresses?.solana ?? []).filter((r) => typeof r?.id === "string" && r.id.startsWith("range-pool-") && typeof r.address === "string").map((r) => r.address);
}

/**
 * Which pools this run counts: every registry pool, then the rest by pairing coin and how much
 * of it the pool holds, up to `maxPools`. The rest are `backlog`.
 */
export function orderPools(pools, registry, maxPools) {
  const reg = registry.map((a) => pools.find((p) => p.address === a)).filter(Boolean);
  const rank = (p) => {
    const i = PAIRING.findIndex((m) => m === p.mint0 || m === p.mint1);
    if (i < 0) return { i: PAIRING.length, held: -1n };
    const held = p.mint0 === PAIRING[i] ? p.held0 : p.held1;
    return { i, held: held ?? -1n };
  };
  const rest = pools
    .filter((p) => !registry.includes(p.address))
    .map((p) => ({ p, r: rank(p) }))
    .sort((a, b) => a.r.i - b.r.i || (b.r.held > a.r.held ? 1 : b.r.held < a.r.held ? -1 : 0) || (a.p.address < b.p.address ? -1 : 1))
    .map((x) => x.p);
  const room = Math.max(0, maxPools - reg.length);
  return { counted: [...reg, ...rest.slice(0, room)], backlog: rest.slice(room) };
}

// ── one pool ─────────────────────────────────────────────────────────────────

const GAP_KIND = { truncated: "log-truncated", "no-log": "tx-unavailable", unavailable: "tx-unavailable", malformed: "event-undecodable", undecodable: "event-undecodable" };
const GAP_WHY = {
  truncated: "The runtime cut this transaction's log, so its events may be missing; none of it is summed.",
  "no-log": "This transaction came back without its log, so its events cannot be read.",
  malformed: "This transaction's log frames do not nest, so its events cannot be placed.",
};

/** A gap row. `key` makes a second detection of the same gap the same row. */
export function gapRow(pool, kind, { key, signature = null, from = null, to = null, fromTime = null, toTime = null, detail, standing = false }) {
  return { pool, gap_key: key, kind, standing, signature, from_slot: from, to_slot: to, from_time: fromTime, to_time: toTime, detail: detail.slice(0, 300) };
}

const historyGap = (pool, firstSlot) =>
  gapRow(pool, "history-not-backfilled", { key: "history-not-backfilled", from: 0, to: firstSlot - 1, detail: `The pool's history before slot ${firstSlot} was not read, so no figure reaches back past it.` });

const bigTotals = (t) => Object.fromEntries(TOTAL_KEYS.map((k) => [k, BigInt(t?.[k] ?? 0)]));
const textTotals = (t) => Object.fromEntries(TOTAL_KEYS.map((k) => [k, t[k].toString()]));
const HOUR_SUMS = ["volume_0", "volume_1", "fees_0", "fees_1"];
const PRICES = ["open_price", "high_price", "low_price", "close_price"];
const hourIn = (h) => h && { hour: h.hour, swaps: h.swaps, ...Object.fromEntries([...HOUR_SUMS, ...PRICES].map((k) => [k, BigInt(h[k])])) };
const hourOut = (h) => h && { hour: h.hour, swaps: h.swaps, ...Object.fromEntries([...HOUR_SUMS, ...PRICES].map((k) => [k, h[k].toString()])) };

/**
 * Read one pool's transactions after its cursor up to the slot its account was read at, and
 * return the rows to write and the next cursor. A transaction that cannot be read whole adds
 * nothing and leaves a gap row. Writes nothing.
 */
export async function countPool({ call, pool, cursor, budget, deadline, now = Date.now, wait = sleep, maxPages = LIMITS.maxSignaturePages }) {
  const address = pool.address;
  const through0 = cursor ? Number(cursor.through_slot) : 0;
  // Its counters would sit beside totals counted past them.
  if (pool.slot < through0) throw new Error(`the pool was read at slot ${pool.slot}, before the count's slot ${through0}: an RPC node behind`);
  const st = {
    totals: bigTotals(cursor?.totals),
    hour: hourIn(cursor?.open_hour ?? null),
    lastPrice: cursor?.last_price != null ? BigInt(cursor.last_price) : null,
    lastPriceSlot: cursor?.last_price_slot ?? null,
    lastSig: cursor?.last_signature ?? null,
    through: through0,
    lastTime: null,
    opened: cursor?.opened ?? null,
  };
  const rows = { swaps: [], collections: [], gaps: [], hours: [], openPoint: null, openedNow: null };
  const seen = new Set();
  let txs = 0;
  let firstPending = !st.opened;

  const closeHour = () => {
    if (st.hour) rows.hours.push({ pool: address, ...hourOut(st.hour) });
    st.hour = null;
  };
  const addSwap = (time, e) => {
    const h = hourOf(time);
    if (!st.hour || h > st.hour.hour) {
      closeHour();
      st.hour = { hour: h, swaps: 0, volume_0: 0n, volume_1: 0n, fees_0: 0n, fees_1: 0n, open_price: e.sqrtPriceX64, high_price: e.sqrtPriceX64, low_price: e.sqrtPriceX64, close_price: e.sqrtPriceX64 };
    }
    const hr = st.hour;
    hr.swaps++;
    hr.volume_0 += e.amount0;
    hr.volume_1 += e.amount1;
    hr.fees_0 += e.tradeFee0;
    hr.fees_1 += e.tradeFee1;
    if (e.sqrtPriceX64 > hr.high_price) hr.high_price = e.sqrtPriceX64;
    if (e.sqrtPriceX64 < hr.low_price) hr.low_price = e.sqrtPriceX64;
    hr.close_price = e.sqrtPriceX64;
  };

  async function one(s) {
    seen.add(s.signature);
    st.lastSig = s.signature;
    if (s.err) return;
    budget.left--;
    txs++;
    const got = await fetchTx(call, s.signature, wait);
    const time = got.tx?.blockTime ?? s.blockTime ?? null;
    let read = got.tx ? rangeTxEvents(got.tx) : { status: "unavailable", why: got.unavailable };
    if (read.status === "failed") return;
    if (read.status === "ok" && !Number.isSafeInteger(time)) read = { status: "unavailable", why: "no block time" };
    const first = firstPending;
    firstPending = false;
    if (read.status !== "ok") {
      const why = GAP_WHY[read.status] ?? `This transaction could not be read: ${read.why}.`;
      rows.gaps.push(gapRow(address, GAP_KIND[read.status], { key: `${GAP_KIND[read.status]}:${s.signature}`, signature: s.signature, from: s.slot, to: s.slot, fromTime: time && iso(time), toTime: time && iso(time), detail: why }));
      st.lastPrice = null;
      st.lastPriceSlot = s.slot;
      if (first) {
        rows.gaps.push(historyGap(address, s.slot));
        st.opened = { seen: false, first_slot: s.slot };
      }
      return;
    }
    const mine = read.events.filter((e) => e.pool === address);
    const born = mine.find((e) => e.name === "PoolCreatedEvent");
    if (first && !born) {
      rows.gaps.push(historyGap(address, s.slot));
      st.opened = { seen: false, first_slot: s.slot };
    }
    // Anyone can send to the pool's address before it is made, but no event of the pool can
    // come before its creation: that is its zero point, and nothing before it is a hole.
    if (born && st.opened?.seen !== true && TOTAL_KEYS.every((k) => st.totals[k] === 0n)) {
      rows.openPoint = { slot: s.slot - 1, time, price: born.sqrtPriceX64 };
      rows.gaps = rows.gaps.filter((g) => g.kind !== "history-not-backfilled");
    }
    const t = st.totals;
    for (const e of mine) {
      if (e.name === "SwapEvent") {
        rows.swaps.push({
          signature: s.signature, pool: address, event_index: e.index, slot: s.slot, block_time: iso(time), zero_for_one: e.zeroForOne,
          amount_0: e.amount0.toString(), amount_1: e.amount1.toString(), fee_0: e.tradeFee0.toString(), fee_1: e.tradeFee1.toString(),
          sqrt_price_x64: e.sqrtPriceX64.toString(), liquidity: e.liquidity.toString(), tick: e.tick,
        });
        t.swaps += 1n;
        t.volume_0 += e.amount0;
        t.volume_1 += e.amount1;
        t.fees_0 += e.tradeFee0;
        t.fees_1 += e.tradeFee1;
        addSwap(time, e);
        st.lastPrice = e.sqrtPriceX64;
        st.lastPriceSlot = s.slot;
      } else if (e.name === "CollectProtocolFeeEvent") {
        rows.collections.push({ signature: s.signature, pool: address, event_index: e.index, slot: s.slot, block_time: iso(time), by_whom: e.by, amount_0: e.amount0.toString(), amount_1: e.amount1.toString() });
        t[`${e.by}_collected_0`] += e.amount0;
        t[`${e.by}_collected_1`] += e.amount1;
      } else if (e.name === "PoolCreatedEvent") {
        st.opened = { seen: true, slot: s.slot, at: iso(time) };
        rows.openedNow = st.opened;
        st.lastPrice = e.sqrtPriceX64;
        st.lastPriceSlot = s.slot;
      }
    }
    st.lastTime = time;
  }

  // Oldest first, a whole slot at a time, so `through` always means every transaction to it.
  async function walk(list) {
    for (let i = 0; i < list.length; ) {
      let j = i;
      while (j < list.length && list[j].slot === list[i].slot) j++;
      const cost = list.slice(i, j).filter((s) => !s.err).length;
      if (cost > budget.left || now() > deadline) return false;
      for (const s of list.slice(i, j)) await one(s);
      st.through = Math.max(st.through, list[i].slot);
      i = j;
    }
    return true;
  }

  const fresh = (list) => list.filter((s) => s.slot > through0 && s.slot <= pool.slot && !seen.has(s.signature));
  const page = await signaturesSince(call, address, cursor?.last_signature ?? null, through0, maxPages, pool.slot, wait);
  if (!page.reachedEnd) {
    // Paging stopped short: the oldest slot it reached may hold more, so the gap includes it.
    const oldest = page.list[0];
    if (firstPending) {
      rows.gaps.push(historyGap(address, oldest.slot + 1));
      st.opened = { seen: false, first_slot: oldest.slot + 1 };
      firstPending = false;
    } else {
      rows.gaps.push(gapRow(address, "backlog-truncated", { key: `backlog-truncated:skip:${through0 + 1}`, from: through0 + 1, to: oldest.slot, detail: `More than ${maxPages * 1000} new transactions since the last count: slots ${through0 + 1} to ${oldest.slot} were not all read.` }));
    }
  }
  let complete = await walk(fresh(page.list));

  // Only a swap moves the price, so the pool's price must be the last counted swap's. If not,
  // read the signatures once more (an RPC can trail its own finalized slot), then say so.
  if (complete && st.lastPrice !== null && st.lastPrice !== pool.sqrtPriceX64) {
    const again = await signaturesSince(call, address, cursor?.last_signature ?? null, through0, maxPages, pool.slot, wait);
    complete = await walk(fresh(again.list));
    if (complete && st.lastPrice !== null && st.lastPrice !== pool.sqrtPriceX64) {
      const from = (st.lastPriceSlot ?? through0) + 1;
      rows.gaps.push(gapRow(address, "tx-unavailable", { key: `tx-unavailable:price:${pool.slot}`, from: Math.min(from, pool.slot), to: pool.slot, toTime: pool.blockTime != null ? iso(pool.blockTime) : null, detail: `The pool's price at slot ${pool.slot} is not the price after its last counted swap, so a swap after slot ${from - 1} was not read.` }));
    }
  }
  if (complete) st.through = Math.max(st.through, pool.slot);
  // Read to the newest slot and no landed transaction made the pool: its start was not seen.
  if (complete && firstPending) {
    rows.gaps.push(historyGap(address, pool.slot + 1));
    st.opened = { seen: false, first_slot: pool.slot + 1 };
  }
  const reach = complete ? pool.blockTime : st.lastTime;
  if (st.hour && reach != null && reach >= Date.parse(st.hour.hour) / 1000 + 3600) closeHour();

  const r = pool.rates;
  const was = cursor?.last_rates;
  if (complete && r && was && (was.tradeFeeRate !== r.tradeFeeRate || was.protocolFeeRate !== r.protocolFeeRate || was.fundFeeRate !== r.fundFeeRate)) {
    rows.gaps.push(gapRow(address, "tier-changed", { key: `tier-changed:${pool.slot}`, standing: true, from: Math.min(through0 + 1, pool.slot), to: pool.slot, toTime: pool.blockTime != null ? iso(pool.blockTime) : null, detail: `The tier's rates changed between slots ${through0 + 1} and ${pool.slot}, so the share that went to the team's vault with no range in use is not worked out across it.` }));
  }
  const snapshot = complete && pool.blockTime != null ? snapshotRow(address, pool.slot, pool.blockTime, pool, r, st.totals) : null;
  if (rows.openPoint) {
    const zero = bigTotals(null);
    const p = rows.openPoint;
    rows.openPoint = { ...snapshotRow(address, p.slot, p.time, { protocolFees0: 0n, protocolFees1: 0n, fundFees0: 0n, fundFees1: 0n, sqrtPriceX64: p.price }, pool.rates, zero), at_open: true };
  }
  if (!complete) {
    rows.gaps.push(gapRow(address, "backlog-truncated", { key: `backlog-truncated:wait:${st.through + 1}`, from: st.through + 1, to: pool.slot, detail: "Not counted to the newest slot this run: past the run's cap. It resumes next run." }));
  }
  const next = {
    pool: address,
    last_signature: st.lastSig,
    through_slot: st.through,
    totals: textTotals(st.totals),
    open_hour: hourOut(st.hour),
    last_price: st.lastPrice?.toString() ?? null,
    last_price_slot: st.lastPriceSlot,
    last_rates: complete && pool.rates ? pool.rates : (cursor?.last_rates ?? null),
    opened: st.opened,
  };
  return { rows, snapshot, cursor: next, complete, transactions: txs };
}

function snapshotRow(pool, slot, time, c, rates, totals) {
  return {
    pool, slot, block_time: iso(time), at_open: false,
    protocol_fees_0: c.protocolFees0.toString(), protocol_fees_1: c.protocolFees1.toString(),
    fund_fees_0: c.fundFees0.toString(), fund_fees_1: c.fundFees1.toString(),
    sqrt_price_x64: c.sqrtPriceX64.toString(),
    trade_fee_rate: rates?.tradeFeeRate ?? null, protocol_fee_rate: rates?.protocolFeeRate ?? null, fund_fee_rate: rates?.fundFeeRate ?? null,
    cum_swaps: totals.swaps.toString(),
    cum_volume_0: totals.volume_0.toString(), cum_volume_1: totals.volume_1.toString(),
    cum_fees_0: totals.fees_0.toString(), cum_fees_1: totals.fees_1.toString(),
    cum_vault_collected_0: totals.vault_collected_0.toString(), cum_vault_collected_1: totals.vault_collected_1.toString(),
    cum_workshop_collected_0: totals.workshop_collected_0.toString(), cum_workshop_collected_1: totals.workshop_collected_1.toString(),
  };
}

// ── database ─────────────────────────────────────────────────────────────────

export function postgrest(env, fetchImpl) {
  return async (path, init = {}) => {
    const r = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // judged by its status
    }
    return { status: r.status, body };
  };
}

const okWrite = (r) => r.status === 200 || r.status === 201 || r.status === 204;

async function insert(db, table, rows, conflict, resolution = "ignore-duplicates") {
  for (let i = 0; i < rows.length; i += 500) {
    const r = await db(`${table}?on_conflict=${conflict}`, { method: "POST", body: JSON.stringify(rows.slice(i, i + 500)), headers: { Prefer: `resolution=${resolution},return=minimal` } });
    if (!okWrite(r)) throw new Error(`${table} write refused (HTTP ${r.status})`);
  }
}

async function patch(db, path, body) {
  const r = await db(path, { method: "PATCH", body: JSON.stringify(body), headers: { Prefer: "return=minimal" } });
  if (!okWrite(r)) throw new Error(`${path.split("?")[0]} update refused (HTTP ${r.status})`);
}

/**
 * One pool's rows, then its cursor at the version this run read, then its snapshot. Rows are
 * keyed, so a run that dies before the cursor is redone exactly by the next; a snapshot is
 * written only once its cursor is, so every snapshot's totals are a cursor's.
 */
async function writePool(db, address, out, row, nowIso) {
  const enc = encodeURIComponent(address);
  await insert(db, "range_swap", out.rows.swaps, "signature,pool,event_index");
  await insert(db, "range_collection", out.rows.collections, "signature,pool,event_index");
  // A wait this run writes again keeps its open row; any other has been counted past.
  const wait = out.rows.gaps.find((g) => g.gap_key.startsWith("backlog-truncated:wait:"));
  const still = wait ? `&gap_key=neq.${encodeURIComponent(wait.gap_key)}` : "";
  await patch(db, `range_gap?pool=eq.${enc}&gap_key=like.backlog-truncated:wait:*${still}&resolved_at=is.null`, { resolved_at: nowIso });
  if (out.rows.openPoint) await patch(db, `range_gap?pool=eq.${enc}&kind=eq.history-not-backfilled&resolved_at=is.null`, { resolved_at: nowIso });
  await insert(db, "range_gap", out.rows.gaps, "pool,gap_key");
  await insert(db, "range_hour", out.rows.hours, "pool,hour", "merge-duplicates");
  if (out.rows.openPoint) await insert(db, "range_venue_snapshot", [out.rows.openPoint], "pool,slot");
  const next = { ...out.cursor, last_ok_at: nowIso, last_error: null };
  if (row) {
    const r = await db(`range_cursor?pool=eq.${enc}&version=eq.${row.version}`, { method: "PATCH", body: JSON.stringify({ ...next, version: row.version + 1 }) });
    if (r.status !== 200 || !Array.isArray(r.body) || r.body.length !== 1) throw new Error(`cursor write refused (HTTP ${r.status}); another run may have counted first`);
  } else {
    const r = await db("range_cursor", { method: "POST", body: JSON.stringify({ ...next, version: 1 }) });
    if (r.status !== 201) throw new Error(`first cursor write refused (HTTP ${r.status})`);
  }
  if (out.snapshot) await insert(db, "range_venue_snapshot", [out.snapshot], "pool,slot");
  if (out.rows.openedNow) await patch(db, `range_pool?address=eq.${enc}`, { opened_slot: out.rows.openedNow.slot, opened_at: out.rows.openedNow.at });
}

const poolRow = (p, registry, nowIso) => ({
  address: p.address, mint_0: p.mint0, mint_1: p.mint1, vault_0: p.vault0, vault_1: p.vault1,
  decimals_0: p.decimals0, decimals_1: p.decimals1, amm_config: p.ammConfig, tick_spacing: p.tickSpacing,
  registry: registry.includes(p.address), last_seen_at: nowIso,
});

function readAddresses() {
  return JSON.parse(readFileSync(join(HERE, "addresses.json"), "utf8"));
}

const missingTable = (r) => r.status === 404 || r.body?.code === "PGRST205" || r.body?.code === "42P01";

// ── a run ────────────────────────────────────────────────────────────────────

export async function main({
  env = process.env,
  fetchImpl = globalThis.fetch,
  call = null,
  wait = sleep,
  now = Date.now,
  log = console.log,
  error = console.error,
  dryRun = false,
  limits = LIMITS,
  registry = null,
} = {}) {
  const chain = call ?? rpc({ fetchImpl, wait });
  const reg = registry ?? registryPools(readAddresses());
  const warn = (m) => log(`::warning title=Range stats::${m}`);
  if (dryRun) return dryRunAll({ chain, reg, limits, now, wait, log, error, warn });
  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"].filter((k) => !env[k]);
  if (missing.length) {
    error(`::error title=Range stats not configured::Missing repo secrets: ${missing.join(" ")}. Nothing was counted.`);
    return 1;
  }
  const db = postgrest(env, fetchImpl);
  const startedAt = new Date(now()).toISOString();
  const read = await db("range_cursor?select=*").catch((e) => ({ status: 0, body: { message: e.message } }));
  if (missingTable(read)) {
    log("::notice title=range tables do not exist yet::Migration 030 has not been applied, so there is nowhere to count into.");
    return 0;
  }
  const known = await db("range_pool?select=address").catch(() => ({ status: 0 }));
  if (read.status !== 200 || !Array.isArray(read.body) || known.status !== 200 || !Array.isArray(known.body)) {
    error(`::error title=Range stats could not read its tables::HTTP ${read.status}/${known.status}. Nothing was counted.`);
    return 1;
  }
  const cursors = new Map(read.body.map((r) => [r.pool, r]));
  const deadline = now() + limits.runBudgetMs;
  const budget = { left: limits.maxTransactions };
  let failed = 0;
  let counted = 0;
  let backlog = 0;
  let txs = 0;
  let firstError = null;
  const fail = (title, msg) => {
    failed++;
    firstError ??= msg.slice(0, 300);
    error(`::error title=${title}::${msg}`);
  };

  let listed;
  try {
    listed = await listPools(chain, known.body.map((r) => r.address));
    await readSide(chain, listed.pools, warn);
    const times = await blockTimes(chain, listed.pools.map((p) => p.slot));
    for (const p of listed.pools) p.blockTime = times.get(p.slot);
    await insert(db, "range_pool", listed.pools.map((p) => poolRow(p, reg, startedAt)), "address", "merge-duplicates");
  } catch (e) {
    fail("Range pools not read", String(e?.message ?? e).slice(0, 300));
    await db("range_run", { method: "POST", body: JSON.stringify({ started_at: startedAt, finished_at: new Date(now()).toISOString(), ok: false, list_read: false, error: firstError }) }).catch(() => {});
    return 1;
  }
  const order = orderPools(listed.pools, reg, limits.maxPools);
  for (const pool of order.counted) {
    const row = cursors.get(pool.address) ?? null;
    try {
      const out = await countPool({ call: chain, pool, cursor: row, budget, deadline, now, wait, maxPages: limits.maxSignaturePages });
      txs += out.transactions;
      await writePool(db, pool.address, out, row, new Date(now()).toISOString());
      counted++;
      if (!out.complete) {
        backlog++;
        warn(`${pool.address}: counted to slot ${out.cursor.through_slot} of ${pool.slot}; the rest waits for the next run.`);
      }
      log(`${pool.address}: +${out.rows.swaps.length} swap(s), ${out.rows.gaps.length} gap row(s), through slot ${out.cursor.through_slot}`);
    } catch (e) {
      fail(`Range pool ${pool.address} not counted`, String(e?.message ?? e).slice(0, 300));
      if (row) await patch(db, `range_cursor?pool=eq.${encodeURIComponent(pool.address)}`, { last_error: firstError, last_error_at: new Date(now()).toISOString() }).catch(() => {});
    }
  }
  try {
    const waiting = order.backlog.map((p) => {
      const through = Number(cursors.get(p.address)?.through_slot ?? 0);
      return gapRow(p.address, "backlog-truncated", { key: `backlog-truncated:wait:${through + 1}`, from: Math.min(through + 1, p.slot), to: p.slot, detail: `Not counted this run: past the run's cap of ${limits.maxPools} pools. It resumes when there is room.` });
    });
    await insert(db, "range_gap", waiting, "pool,gap_key");
    backlog += waiting.length;
    if (waiting.length) warn(`${waiting.length} pool(s) past the cap of ${limits.maxPools} wait for a later run.`);
    const list = `range_gap?pool=eq.${RANGE_PROGRAM_ID}&kind=eq.pool-list-unread&resolved_at=is.null`;
    if (listed.listRead) await patch(db, list, { resolved_at: new Date(now()).toISOString() });
    else {
      await insert(db, "range_gap", [gapRow(RANGE_PROGRAM_ID, "pool-list-unread", { key: "pool-list-unread:open", detail: `The program's pool list could not be read (${listed.listError}); only pools already known were counted.` })], "pool,gap_key");
      fail("Range pool list not read", `only the ${listed.pools.length} pool(s) already known were counted: ${listed.listError}`);
    }
  } catch (e) {
    fail("Range stats gap rows not written", String(e?.message ?? e).slice(0, 300));
  }
  const run = { started_at: startedAt, finished_at: new Date(now()).toISOString(), ok: failed === 0, list_read: listed.listRead, pools_listed: listed.pools.length, pools_counted: counted, pools_backlog: backlog, transactions: txs, error: firstError };
  const r = await db("range_run", { method: "POST", body: JSON.stringify(run) }).catch((e) => ({ status: 0, body: e.message }));
  if (r.status !== 201) fail("Range run not logged", `HTTP ${r.status}`);
  log(`range pools: ${listed.pools.length} listed, ${counted} counted, ${backlog} behind, ${txs} transaction(s) read`);
  return failed ? 1 : 0;
}

async function dryRunAll({ chain, reg, limits, now, wait, log, error, warn }) {
  let failed = 0;
  const listed = await listPools(chain, []);
  if (!listed.listRead) {
    error(`the pool list could not be read: ${listed.listError}`);
    return 1;
  }
  await readSide(chain, listed.pools, warn);
  const times = await blockTimes(chain, listed.pools.map((p) => p.slot));
  for (const p of listed.pools) p.blockTime = times.get(p.slot);
  const order = orderPools(listed.pools, reg, limits.maxPools);
  log(`${listed.pools.length} range pool(s) at slot ${listed.pools[0]?.slot ?? "(none)"}; ${order.counted.length} counted, ${order.backlog.length} past the cap`);
  const budget = { left: limits.maxTransactions };
  const deadline = now() + limits.runBudgetMs;
  for (const pool of order.counted) {
    try {
      const out = await countPool({ call: chain, pool, cursor: null, budget, deadline, now, wait, maxPages: limits.maxSignaturePages });
      const t = out.cursor.totals;
      log(`${pool.address}: ${t.swaps} swaps, fees ${t.fees_0} / ${t.fees_1} raw, ${out.rows.gaps.length} gap row(s), ${out.complete ? "to the newest slot" : "stopped at the cap"}`);
    } catch (e) {
      failed++;
      error(`${pool.address}: not counted: ${e?.message ?? e}`);
    }
  }
  return failed ? 1 : 0;
}

// Not a top-level await: the cases import this module, which must finish loading first.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const done = process.argv.includes("--self-test")
    ? import("./lib/range-stats-cases.mjs").then((m) => m.runSelfTest())
    : main({ dryRun: process.argv.includes("--dry-run") });
  done.then(
    (code) => (process.exitCode = code),
    (e) => {
      console.error(e);
      process.exitCode = 1;
    },
  );
}
