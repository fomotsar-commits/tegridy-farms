// The DexTools adapter for our Solana pool program: `?resource=dextools&endpoint=<name>` on the
// aggregator catchall, reached through the vercel.json rewrites /api/dextools/<name>. DexTools
// indexes a DEX it does not parse itself only through an HTTP API the DEX hosts, which its
// indexer reads block by block ("DEX/Blockchain integration API" v0.0.1,
// github.com/dextools-io/integration-sdk, http-adapter):
//
//   GET /api/dextools/latest-block                 the newest finalized slot and its time
//   GET /api/dextools/block?number=<slot>          one slot's time (404 for a skipped slot)
//   GET /api/dextools/asset?id=<mint>              a coin: name, symbol, supply
//   GET /api/dextools/pair?id=<pool>               a pool: its two coins, when and where it opened
//   GET /api/dextools/events?fromBlock=&toBlock=   every pool opening, swap, deposit and withdrawal
//                                                  in those slots (inclusive), in block order
//   GET /api/dextools/exchange?id=<program>        the DEX itself: its program, name and logo
//
// It is the GeckoTerminal adapter's reads (api/_lib/geckoterminal.js: the same program, pools,
// events, vault balances and RPC) in DexTools' shapes. Three things differ, and they are why
// this file exists:
//   - eventIndex is unique within the BLOCK (DexTools sorts by it), not within the transaction:
//     the transaction's place in the block × EVENTS_PER_TXN + the event's place in it.
//   - A pool's opening is an event. Our program logs nothing when a pool opens (cp-swap's
//     `initialize` emits no event), so it is read from the instruction itself: a "creation",
//     then a "join" of what the pool opened with, so its reserves are known from its first block.
//   - Errors are DexTools' {code, message, issues}; a pair names its factory (our program).
//
// WHAT IS NOT SERVED. /asset/holders: a Solana holder list means scanning every token account
// of the mint, which no RPC we use allows for SOL or USDC, and a count from the 20 largest
// accounts would be a wrong number. It answers 404 with that reason; DexTools reads Solana
// holders from its own index. /block?timestamp=: the spec asks for it only on sharded chains.
//
// No key, no send, no writes. Every number is read from the chain, as in the GeckoTerminal file.
import { base58 } from "@scure/base";
import { checkRateLimit } from "./ratelimit.js";
import { isRequestOriginAllowed } from "./aggregator-proxy.js";
import { logSafe } from "./logSafe.js";
import {
  MAX_SLOT_RANGE, MAX_TXS_PER_CALL, SETTLED_SLOTS, VENUE_PROGRAM, accountKeysOf, assetOf, decimal, eventsOf,
  latestBlock, makeRpc, pairOf, parseKey, poolsFor, programEvents, signaturesIn, transaction, txnIndexIn, vaultAfter,
} from "./geckoterminal.js";

/**
 * Anchor's instruction tags for opening a pool, sha256("global:initialize") and
 * sha256("global:initialize_with_permission") first 8 bytes, each with the place of
 * `pool_state` in its accounts (cp-swap instructions/initialize*.rs). Only that place counts:
 * the program creates that account there (`init`), so it is new, while any account can be
 * appended after the fixed ones, an existing pool's included.
 */
export const OPEN_TAGS = new Map([["afaf6d1f0d989bed", 3], ["3f37fe4131b25979", 4]]);
/** eventIndex = txnIndex × this + the event's place in its transaction: unique in the block, in order. */
export const EVENTS_PER_TXN = 1000;
export const EXCHANGE = Object.freeze({ factoryAddress: VENUE_PROGRAM, name: "Memetics Finance", logoURL: "https://memetics.finance/apple-touch-icon.png" });

/* ───────────────────────────────── events ──────────────────────────────── */

/** The pool each instruction to our program that opens one creates (top level, then inner). */
export function openings(tx) {
  const keys = accountKeysOf(tx);
  const m = tx.transaction.message;
  const all = [...m.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions)];
  const out = [];
  for (const ix of all) {
    if (keys[ix.programIdIndex] !== VENUE_PROGRAM) continue;
    let tag;
    try {
      tag = Buffer.from(base58.decode(ix.data)).subarray(0, 8).toString("hex");
    } catch {
      continue;
    }
    const at = OPEN_TAGS.get(tag);
    if (at !== undefined && ix.accounts[at] !== undefined) out.push(keys[ix.accounts[at]]);
  }
  return out;
}

/** The pools a transaction opens, among those we hold. */
export function openedPools(tx, pools) {
  const out = [];
  for (const id of openings(tx)) if (pools.has(id) && !out.includes(pools.get(id))) out.push(pools.get(id));
  return out;
}

/** True when a transaction opens a pool we do not hold: one newer than the list. */
const opensUnknown = (txs) => (pools) => txs.some((tx) => !tx?.meta?.err && openings(tx).some((id) => !pools.has(id)));

/**
 * What a pool opened with: its vaults just before the first event of it in the same
 * transaction (each event logs them, less fees owed, which are none at the opening), else
 * its vaults after the transaction.
 */
function openingBalances(tx, keys, pool, decoded) {
  const first = decoded.find((e) => e.pool === pool);
  if (first?.kind === "swap") {
    const in0 = first.inputMint === pool.mint0;
    return in0 ? [first.inputVaultBefore, first.outputVaultBefore] : [first.outputVaultBefore, first.inputVaultBefore];
  }
  if (first) return [first.vault0Before, first.vault1Before];
  return [vaultAfter(tx, keys, pool.vault0), vaultAfter(tx, keys, pool.vault1)];
}

/**
 * One transaction's events as DexTools takes them: each pool it opens as a "creation" and a
 * "join" of the opening balances, then every swap, deposit and withdrawal (the GeckoTerminal
 * adapter's, without the fields DexTools has no place for). A failed transaction has none.
 */
export function dexToolsEventsOf(tx, pools, txnIndex) {
  if (!tx || tx.meta?.err) return [];
  const keys = accountKeysOf(tx);
  const txnId = tx.transaction.signatures[0];
  const head = { block: { blockNumber: tx.slot, blockTimestamp: tx.blockTime }, txnId, txnIndex, maker: keys[0] };
  const decoded = programEvents(tx, pools);
  const out = [];
  for (const pool of openedPools(tx, pools)) {
    const [open0, open1] = openingBalances(tx, keys, pool, decoded);
    if (open0 === null || open1 === null) throw new Error(`${txnId}: the opened pool's vaults are not in the transaction`);
    const reserves = { asset0: decimal(open0, pool.decimals0), asset1: decimal(open1, pool.decimals1) };
    out.push({ ...head, pairId: pool.address, eventType: "creation" });
    out.push({ ...head, pairId: pool.address, eventType: "join", amount0: reserves.asset0, amount1: reserves.asset1, reserves });
  }
  for (const e of eventsOf(tx, pools, txnIndex)) {
    const { eventIndex: _i, priceNative: _p, metadata: _m, ...kept } = e;
    out.push(kept);
  }
  if (out.length > EVENTS_PER_TXN) throw new Error(`${txnId}: more than ${EVENTS_PER_TXN} events in one transaction`);
  return out.map((e, i) => ({ ...e, eventIndex: txnIndex * EVENTS_PER_TXN + i }));
}

/** Every event in [fromBlock, toBlock], in block order and, within a block, by eventIndex. */
export async function dexToolsEventsIn(rpc, fromBlock, toBlock) {
  const sigs = await signaturesIn(rpc, fromBlock, toBlock);
  if (sigs.length > MAX_TXS_PER_CALL) throw Object.assign(new Error(`${sigs.length} transactions in slots ${fromBlock}-${toBlock}: ask for a smaller range (at most ${MAX_TXS_PER_CALL} transactions a call)`), { tooMany: true });
  const txs = [];
  for (const s of sigs) txs.push(await transaction(rpc, s.signature));
  const pools = await poolsFor(rpc, txs, opensUnknown(txs));
  const events = [];
  for (const [i, s] of sigs.entries()) {
    const tx = txs[i];
    if (!programEvents(tx, pools).length && !openedPools(tx, pools).length) continue;
    events.push(...dexToolsEventsOf(tx, pools, await txnIndexIn(rpc, s.slot, s.signature)));
  }
  return events.sort((a, b) => a.block.blockNumber - b.block.blockNumber || a.eventIndex - b.eventIndex);
}

/* ──────────────────────────────── handler ──────────────────────────────── */

const ENDPOINTS = new Set(["latest-block", "block", "asset", "pair", "events", "exchange", "asset-holders"]);
const slotOf = (v) => (typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : null);
/** RPC answers for a slot with no block: skipped, or not kept (-32004, -32007, -32009). */
const NO_BLOCK = /"code":-320(04|07|09)\b/;

/** DexTools' error shape: {code, message, issues?}, the code being the HTTP status as a string. */
function fail(res, status, message, issues) {
  return res.status(status).json({ code: String(status), message, ...(issues ? { issues } : {}) });
}
const issue = (param, code, message) => ({ param, code, message });

export async function handleDexTools(req, res, deps = {}) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  const method = String(req.method || "").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return fail(res, 405, "Method not allowed");
  }
  if (!isRequestOriginAllowed(req)) return fail(res, 403, "Origin not allowed");
  const endpoint = String(req.query?.endpoint ?? "");
  if (!ENDPOINTS.has(endpoint)) return fail(res, 404, "No such endpoint: latest-block, block, asset, pair, events or exchange");
  if (endpoint === "asset-holders") return fail(res, 404, "Holder lists are not served: on Solana they need a scan of every token account of the mint. Read holders from your own Solana index.");
  // The limiter answers a refusal itself; this hands it DexTools' error shape to answer in.
  const limited = { setHeader: (h, v) => res.setHeader(h, v), status: (c) => ({ json: () => fail(res, c, "Rate limit occured handling request") }) };
  if (!(await (deps.checkRateLimit ?? checkRateLimit)(req, limited, { limit: 120, windowSec: 60, identifier: "dextools" }))) return;
  const rpc = deps.rpc ?? makeRpc(deps.fetchImpl);
  const now = deps.now ?? Date.now;
  try {
    if (endpoint === "latest-block") {
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ block: await latestBlock(rpc) });
    }
    if (endpoint === "block") {
      const number = slotOf(req.query?.number);
      if (number === null) return fail(res, 400, "Invalid parameters", [issue("number", req.query?.number === undefined ? "required" : "integer", "number must be a slot; a search by timestamp is not served (Solana is not sharded)")]);
      const tip = await rpc("getSlot", [{ commitment: "finalized" }]);
      if (number > tip) return fail(res, 404, "Block not found");
      let time;
      try {
        time = await rpc("getBlockTime", [number]);
      } catch (e) {
        if (!NO_BLOCK.test(e?.message ?? "")) throw e;
        time = null;
      }
      if (typeof time !== "number") return fail(res, 404, "Block not found");
      res.setHeader("Cache-Control", "s-maxage=86400");
      return res.status(200).json({ block: { blockNumber: number, blockTimestamp: time } });
    }
    if (endpoint === "exchange") {
      if (req.query?.id !== VENUE_PROGRAM) return fail(res, 404, "Exchange not found");
      res.setHeader("Cache-Control", "s-maxage=86400");
      return res.status(200).json({ exchange: { ...EXCHANGE } });
    }
    if (endpoint === "asset") {
      const id = parseKey(req.query?.id);
      if (!id) return fail(res, 400, "Invalid parameters", [issue("id", req.query?.id === undefined ? "required" : "invalid", "id must be a Solana mint address")]);
      const a = await assetOf(rpc, id);
      if (!a) return fail(res, 404, "Asset not found");
      res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
      return res.status(200).json({ asset: { id: a.id, name: a.name, symbol: a.symbol, ...(a.totalSupply ? { totalSupply: a.totalSupply } : {}) } });
    }
    if (endpoint === "pair") {
      const id = parseKey(req.query?.id);
      if (!id) return fail(res, 400, "Invalid parameters", [issue("id", req.query?.id === undefined ? "required" : "invalid", "id must be a pool address")]);
      const p = await pairOf(rpc, id);
      if (!p) return fail(res, 404, "Pair not found");
      if (p.createdAtTxnId === undefined) throw new Error(`pool ${id}: no transactions found`);
      res.setHeader("Cache-Control", "s-maxage=86400");
      return res.status(200).json({
        pair: { id: p.id, asset0Id: p.asset0Id, asset1Id: p.asset1Id, createdAtBlockNumber: p.createdAtBlockNumber, createdAtBlockTimestamp: p.createdAtBlockTimestamp, createdAtTxnId: p.createdAtTxnId, factoryAddress: VENUE_PROGRAM },
      });
    }
    const fromBlock = slotOf(req.query?.fromBlock);
    const toBlock = slotOf(req.query?.toBlock);
    const bad = [];
    if (fromBlock === null) bad.push(issue("fromBlock", req.query?.fromBlock === undefined ? "required" : "integer", "fromBlock must be a slot"));
    if (toBlock === null) bad.push(issue("toBlock", req.query?.toBlock === undefined ? "required" : "integer", "toBlock must be a slot"));
    if (!bad.length && toBlock < fromBlock) bad.push(issue("toBlock", "range", "toBlock must not be below fromBlock"));
    if (!bad.length && toBlock - fromBlock > MAX_SLOT_RANGE) bad.push(issue("toBlock", "range", `at most ${MAX_SLOT_RANGE} slots a call`));
    if (bad.length) return fail(res, 400, "Invalid parameters", bad);
    let events;
    try {
      events = await dexToolsEventsIn(rpc, fromBlock, toBlock);
    } catch (e) {
      if (e?.tooMany) return fail(res, 400, "Invalid parameters", [issue("toBlock", "range", logSafe(e.message))]);
      throw e;
    }
    // Slots well behind the finalized tip never change: the edge may keep them a day.
    const tip = await rpc("getSlot", [{ commitment: "finalized" }]);
    res.setHeader("Cache-Control", toBlock <= tip - SETTLED_SLOTS ? "s-maxage=86400" : "no-store");
    return res.status(200).json({ events });
  } catch (e) {
    console.error(`[dextools] ${endpoint} ${now()}: ${logSafe(e?.message ?? String(e))}`);
    return fail(res, 500, "Server was not able to return a response. Try later");
  }
}
