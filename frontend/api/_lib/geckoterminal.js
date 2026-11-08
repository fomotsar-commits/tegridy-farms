// The GeckoTerminal adapter for our Solana pool program: `?resource=gt&endpoint=<name>` on the
// aggregator catchall, reached through the vercel.json rewrite /api/gt/<name>. GeckoTerminal
// lists a DEX that is not one of its known forks only through four HTTP endpoints the DEX
// hosts, which its indexer polls ("GeckoTerminal Integration API Standards" v0.1, Nov 2024):
//
//   GET /api/gt/latest-block                     the newest finalized slot and its time
//   GET /api/gt/asset?id=<mint>                  a coin: name, symbol, decimals, supply
//   GET /api/gt/pair?id=<pool>                   a pool: its two coins, fee, when it opened
//   GET /api/gt/events?fromBlock=&toBlock=       every swap, deposit and withdrawal in our pools
//                                                 in those slots (inclusive), in block order
//
// WHY. Our program is a fork of Raydium's cp-swap with its own address, so DexScreener,
// GeckoTerminal and Jupiter's router do not know it (read 2026-11-07: both chart sites answer
// "not found" for BAYLA/SOL). Nothing routes to our pools but our own site, and the price
// robot earns only on what others trade in them (owner's research, reports/Solana arbitrage
// where the money is.md). A listing is the first door to outside traffic.
//
// WHAT IS SERVED, AND FROM WHERE. Every number is read from the chain through the keyed RPC
// (SOLANA_RPC_URL, else the public one): the pools from the program's accounts, each swap
// and liquidity change from the program's own events (cp-swap emits SwapEvent and
// LpChangeEvent as `Program data:` log lines), and reserves from the vaults' balances after
// the transaction. GeckoTerminal queries each slot once and halts on a bad schema, so the
// answer for a slot range never changes once the slots are finalized, and a read that fails
// is a 502 (the indexer retries), never a shorter list.
//
// WHAT IS NOT. No key, no send, no writes; nothing from a listing or a price service. The
// blocked `getProgramAccounts` (audit L-1) runs here, server side, against the program's
// own 637-byte accounts only, as pool-index.js does.
import { base58 } from "@scure/base";
import { checkRateLimit } from "./ratelimit.js";
import { isRequestOriginAllowed } from "./aggregator-proxy.js";
import { findProgramAddress } from "./launch-pins.js";
import { logSafe } from "./logSafe.js";

export const VENUE_PROGRAM = "EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT";
/** What GeckoTerminal shows as the DEX. */
export const DEX_KEY = "memetics";
export const POOL_SIZE = 637;
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const METAPLEX_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
/** Anchor's event tags: sha256("event:SwapEvent") and sha256("event:LpChangeEvent"), first 8 bytes. */
export const SWAP_EVENT_TAG = "40c6cde8260871e2";
export const LP_EVENT_TAG = "79a3cdc939da753c";
const PROGRAM_DATA = "Program data: ";
/** Slots a range may span in one call: GeckoTerminal's chunk is configurable; this bounds one request's reads. */
export const MAX_SLOT_RANGE = 50_000;
/** Transactions one /events call will decode; more than this in one range is a 502 that asks for a smaller chunk. */
export const MAX_TXS_PER_CALL = 60;
/** How far behind the tip a slot must be before its events are cached by the edge for a day. */
const SETTLED_SLOTS = 300;
const POOLS_FRESH_MS = 60_000;
/** Decimal places GeckoTerminal reads (it ignores the rest). */
export const DECIMAL_PLACES = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ──────────────────────────────── numbers ──────────────────────────────── */

/** `raw` base units as a decimal string with `decimals` places, trailing zeros dropped: "1.5", "0.000001", "12". */
export function decimal(raw, decimals) {
  const n = BigInt(raw);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const s = abs.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * `num` ÷ `den` (base units, with their decimals) as a decimal string to DECIMAL_PLACES
 * places: the price of one whole unit of the denominator's coin in whole units of the
 * numerator's. Exact integer arithmetic; null when the denominator is zero.
 */
export function ratio(num, numDecimals, den, denDecimals) {
  const n = BigInt(num);
  const d = BigInt(den);
  if (d === 0n) return null;
  // (n / 10^nd) / (d / 10^dd) = n · 10^dd / (d · 10^nd), scaled by 10^PLACES
  const scaled = (n * 10n ** BigInt(denDecimals + DECIMAL_PLACES)) / (d * 10n ** BigInt(numDecimals));
  return decimal(scaled, DECIMAL_PLACES);
}

/* ───────────────────────────────── chain ───────────────────────────────── */

const u64 = (d, at) => d.readBigUInt64LE(at);
const key = (d, at) => base58.encode(d.subarray(at, at + 32));

/** One of our pools, from its 637-byte account (cp-swap PoolState). */
export function decodePool(address, data) {
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data, "base64");
  if (d.length !== POOL_SIZE) throw new Error(`pool ${address} is ${d.length} bytes, not ${POOL_SIZE}`);
  return {
    address,
    ammConfig: key(d, 8),
    vault0: key(d, 72),
    vault1: key(d, 104),
    mint0: key(d, 168),
    mint1: key(d, 200),
    decimals0: d[331],
    decimals1: d[332],
    // A pool opened with the creator fee on pays it on top of the trade fee (byte 390, cp-swap).
    creatorFeeOn: d[390] !== 0,
  };
}

/** The trade fee a cp-swap AmmConfig charges, in basis points, with the creator fee when `creatorFeeOn`. */
export function feeBpsOf(configData, creatorFeeOn) {
  const d = Buffer.isBuffer(configData) ? configData : Buffer.from(configData, "base64");
  if (d.length < 116) return null;
  // Rates are parts per million: 10_000 = 1%. bps = rate / 100, rounded to whole bps.
  const trade = u64(d, 12);
  const creator = creatorFeeOn ? u64(d, 108) : 0n;
  return Number((trade + creator + 50n) / 100n);
}

/** The event lines of a transaction's logs that carry our program's events, decoded; others are skipped. */
export function programEvents(tx, pools) {
  const out = [];
  for (const line of tx?.meta?.logMessages ?? []) {
    if (!line.startsWith(PROGRAM_DATA)) continue;
    let d;
    try {
      d = Buffer.from(line.slice(PROGRAM_DATA.length), "base64");
    } catch {
      continue;
    }
    if (d.length < 40) continue;
    const tag = d.subarray(0, 8).toString("hex");
    const poolId = key(d, 8);
    const pool = pools.get(poolId);
    if (!pool) continue;
    if (tag === SWAP_EVENT_TAG && d.length >= 170) {
      out.push({
        kind: "swap", pool,
        inputVaultBefore: u64(d, 40), outputVaultBefore: u64(d, 48), inputAmount: u64(d, 56), outputAmount: u64(d, 64),
        inputTransferFee: u64(d, 72), outputTransferFee: u64(d, 80), baseInput: d[88] !== 0,
        inputMint: key(d, 89), outputMint: key(d, 121), tradeFee: u64(d, 153), creatorFee: u64(d, 161), creatorFeeOnInput: d[169] !== 0,
      });
    } else if (tag === LP_EVENT_TAG && d.length >= 97) {
      out.push({
        kind: d[96] === 0 ? "join" : "exit", pool,
        amount0: u64(d, 64), amount1: u64(d, 72), transferFee0: u64(d, 80), transferFee1: u64(d, 88),
      });
    }
  }
  return out;
}

/** Every account key of a transaction, static then loaded (`json` encoding; version 0 and 1 load from tables). */
export function accountKeysOf(tx) {
  const m = tx.transaction.message;
  const loaded = tx.meta?.loadedAddresses ?? {};
  return [...m.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey)), ...(loaded.writable ?? []), ...(loaded.readonly ?? [])];
}

/** A vault's balance after the transaction, from the post token balances; null when the vault is not in the transaction. */
export function vaultAfter(tx, keys, vault) {
  const i = keys.indexOf(vault);
  if (i < 0) return null;
  const b = (tx.meta?.postTokenBalances ?? []).find((x) => x.accountIndex === i);
  return b ? BigInt(b.uiTokenAmount.amount) : null;
}

/**
 * One transaction's events as GeckoTerminal takes them: a swap gives what the pool received
 * (after any transfer fee), the fee kept from it, what the curve paid out and the fee kept
 * from that, the price of asset0 in asset1 at that swap, and both vaults after; a deposit or
 * withdrawal gives what moved and both vaults after. `txnIndex` is the transaction's place in
 * its block; events are numbered within the transaction. A failed transaction has none.
 */
export function eventsOf(tx, pools, txnIndex) {
  if (!tx || tx.meta?.err) return [];
  const keys = accountKeysOf(tx);
  const txnId = tx.transaction.signatures[0];
  const maker = keys[0];
  const block = { blockNumber: tx.slot, blockTimestamp: tx.blockTime };
  const out = [];
  for (const [eventIndex, e] of programEvents(tx, pools).entries()) {
    const { pool } = e;
    const after0 = vaultAfter(tx, keys, pool.vault0);
    const after1 = vaultAfter(tx, keys, pool.vault1);
    if (after0 === null || after1 === null) throw new Error(`${txnId}: the pool's vaults are not in the transaction`);
    const reserves = { asset0: decimal(after0, pool.decimals0), asset1: decimal(after1, pool.decimals1) };
    const head = { block, txnId, txnIndex, eventIndex, maker, pairId: pool.address };
    if (e.kind === "swap") {
      const in0 = e.inputMint === pool.mint0;
      if (!in0 && e.inputMint !== pool.mint1) throw new Error(`${txnId}: a swap of a coin the pool does not hold`);
      const [inDec, outDec] = in0 ? [pool.decimals0, pool.decimals1] : [pool.decimals1, pool.decimals0];
      const feesIn = e.tradeFee + (e.creatorFeeOnInput ? e.creatorFee : 0n);
      const feesOut = e.creatorFeeOnInput ? 0n : e.creatorFee;
      // The curve saw the input less its fees, and paid the output: the price of asset0 in asset1.
      const curveIn = e.inputAmount - feesIn;
      const price = in0 ? ratio(e.outputAmount, outDec, curveIn, inDec) : ratio(curveIn, inDec, e.outputAmount, outDec);
      if (price === null) throw new Error(`${txnId}: a swap with nothing in`);
      out.push({
        ...head,
        eventType: "swap",
        [in0 ? "asset0In" : "asset1In"]: decimal(e.inputAmount, inDec),
        [in0 ? "asset1Out" : "asset0Out"]: decimal(e.outputAmount, outDec),
        priceNative: price,
        reserves,
        metadata: {
          [in0 ? "fees0In" : "fees1In"]: decimal(feesIn, inDec),
          [in0 ? "fees1Out" : "fees0Out"]: decimal(feesOut, outDec),
        },
      });
    } else {
      out.push({ ...head, eventType: e.kind, amount0: decimal(e.amount0, pool.decimals0), amount1: decimal(e.amount1, pool.decimals1), reserves });
    }
  }
  return out;
}

/* ─────────────────────────────── token names ───────────────────────────── */

const WELL_KNOWN = {
  So11111111111111111111111111111111111111112: { name: "Wrapped SOL", symbol: "SOL", coinGeckoId: "wrapped-solana" },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { name: "USD Coin", symbol: "USDC", coinGeckoId: "usd-coin" },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { name: "Tether USD", symbol: "USDT", coinGeckoId: "tether" },
};

const borshString = (d, at) => {
  if (at + 4 > d.length) return null;
  const len = d.readUInt32LE(at);
  if (at + 4 + len > d.length) return null;
  return { value: d.subarray(at + 4, at + 4 + len).toString("utf8").replace(/\0+$/, ""), next: at + 4 + len };
};

/** A Token-2022 mint's own metadata extension (type 19): its name and symbol, or null. */
export function token2022Metadata(d) {
  // 82-byte mint, padded to the 165-byte account size, one account-type byte, then TLV entries.
  let at = 166;
  while (at + 4 <= d.length) {
    const type = d.readUInt16LE(at);
    const len = d.readUInt16LE(at + 2);
    const start = at + 4;
    if (type === 19 && start + 64 <= d.length) {
      const name = borshString(d, start + 64);
      const symbol = name && borshString(d, name.next);
      return name && symbol ? { name: name.value, symbol: symbol.value } : null;
    }
    if (len === 0 && type === 0) break;
    at = start + len;
  }
  return null;
}

/** A Metaplex metadata account's name and symbol, or null. */
export function metaplexMetadata(d) {
  if (!Buffer.isBuffer(d) || d.length < 70 || d[0] !== 4) return null;
  const name = borshString(d, 65);
  const symbol = name && borshString(d, name.next);
  return name && symbol ? { name: name.value, symbol: symbol.value } : null;
}

export const metaplexPda = (mint) => findProgramAddress([new TextEncoder().encode("metadata"), base58.decode(METAPLEX_PROGRAM), base58.decode(mint)], METAPLEX_PROGRAM);

/* ───────────────────────────────── reads ───────────────────────────────── */

export function parseKey(v) {
  if (typeof v !== "string" || v.length < 32 || v.length > 44) return null;
  try {
    const bytes = base58.decode(v);
    return bytes.length === 32 && base58.encode(bytes) === v ? v : null;
  } catch {
    return null;
  }
}

/** One JSON-RPC call against the keyed RPC (else the public one): `result`, or a throw. Three tries on a refusal. */
export function makeRpc(fetchImpl = globalThis.fetch, url = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", pauseMs = 0) {
  return async function rpc(method, params) {
    let last = "";
    for (let i = 0; i < 3; i++) {
      if (pauseMs) await sleep(pauseMs);
      let r;
      try {
        r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      } catch (e) {
        last = e?.message ?? String(e);
        await sleep(400 * (i + 1));
        continue;
      }
      if (r.status === 429 || r.status >= 500) {
        last = `HTTP ${r.status}`;
        await sleep(600 * (i + 1));
        continue;
      }
      const j = await r.json();
      if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 160)}`);
      return j.result;
    }
    throw new Error(`${method}: no answer (${last})`);
  };
}

/** Per-instance memory: the pool list, decoded transactions, each block's signature order. */
const state = { pools: null, poolsAt: 0, txs: new Map(), blocks: new Map(), pairs: new Map() };
export function __reset() {
  state.pools = null;
  state.poolsAt = 0;
  state.txs.clear();
  state.blocks.clear();
  state.pairs.clear();
}

/** Every pool on the program, with its fee, read at most once a minute per instance. */
export async function listPools(rpc, now = Date.now()) {
  if (state.pools && now - state.poolsAt < POOLS_FRESH_MS) return state.pools;
  const accounts = await rpc("getProgramAccounts", [VENUE_PROGRAM, { encoding: "base64", commitment: "finalized", filters: [{ dataSize: POOL_SIZE }] }]);
  const pools = new Map();
  for (const a of accounts) pools.set(a.pubkey, decodePool(a.pubkey, a.account.data[0]));
  const configs = [...new Set([...pools.values()].map((p) => p.ammConfig))];
  const fees = new Map();
  for (let i = 0; i < configs.length; i += 10) {
    const part = configs.slice(i, i + 10);
    const r = await rpc("getMultipleAccounts", [part, { encoding: "base64", commitment: "finalized" }]);
    part.forEach((k, j) => fees.set(k, r?.value?.[j]?.data?.[0] ?? null));
  }
  for (const p of pools.values()) {
    const cfg = fees.get(p.ammConfig);
    p.feeBps = cfg ? feeBpsOf(cfg, p.creatorFeeOn) : null;
  }
  state.pools = pools;
  state.poolsAt = now;
  return pools;
}

/** The newest finalized slot that has a time (a skipped slot has none; the one before it does). */
export async function latestBlock(rpc) {
  const tip = await rpc("getSlot", [{ commitment: "finalized" }]);
  for (let slot = tip; slot > tip - 64; slot--) {
    const t = await rpc("getBlockTime", [slot]);
    if (typeof t === "number") return { blockNumber: slot, blockTimestamp: t };
  }
  throw new Error("no finalized slot with a time in the last 64");
}

/** A transaction, decoded once per instance. */
async function transaction(rpc, signature) {
  if (state.txs.has(signature)) return state.txs.get(signature);
  const tx = await rpc("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "finalized" }]);
  if (!tx) throw new Error(`transaction ${signature} did not come back`);
  if (state.txs.size > 2000) state.txs.clear();
  state.txs.set(signature, tx);
  return tx;
}

/** Where each transaction sits in its block: the block's signatures in order, read once per slot. */
async function txnIndexIn(rpc, slot, signature) {
  let order = state.blocks.get(slot);
  if (!order) {
    const b = await rpc("getBlock", [slot, { encoding: "json", transactionDetails: "signatures", rewards: false, maxSupportedTransactionVersion: 1, commitment: "finalized" }]);
    order = new Map((b?.signatures ?? []).map((s, i) => [s, i]));
    if (state.blocks.size > 500) state.blocks.clear();
    state.blocks.set(slot, order);
  }
  const i = order.get(signature);
  if (i === undefined) throw new Error(`block ${slot} does not list ${signature}`);
  return i;
}

/**
 * The program's finalized transactions in [fromBlock, toBlock], oldest first. The RPC lists
 * newest first, so pages are walked back until one dips below `fromBlock`.
 */
export async function signaturesIn(rpc, fromBlock, toBlock) {
  const hits = [];
  let before;
  for (let page = 0; page < 200; page++) {
    const list = await rpc("getSignaturesForAddress", [VENUE_PROGRAM, { limit: 1000, commitment: "finalized", ...(before ? { before } : {}) }]);
    if (!Array.isArray(list) || !list.length) break;
    for (const s of list) if (s.slot >= fromBlock && s.slot <= toBlock && !s.err) hits.push(s);
    if (list[list.length - 1].slot < fromBlock || list.length < 1000) break;
    before = list[list.length - 1].signature;
  }
  return hits.reverse();
}

/** Every event in [fromBlock, toBlock], in block, transaction and event order. */
export async function eventsIn(rpc, fromBlock, toBlock) {
  const pools = await listPools(rpc);
  const sigs = await signaturesIn(rpc, fromBlock, toBlock);
  if (sigs.length > MAX_TXS_PER_CALL) throw Object.assign(new Error(`${sigs.length} transactions in slots ${fromBlock}-${toBlock}: ask for a smaller chunk (at most ${MAX_TXS_PER_CALL} transactions a call)`), { tooMany: true });
  const events = [];
  for (const s of sigs) {
    const tx = await transaction(rpc, s.signature);
    if (!programEvents(tx, pools).length) continue;
    const txnIndex = await txnIndexIn(rpc, s.slot, s.signature);
    events.push(...eventsOf(tx, pools, txnIndex));
  }
  return events.sort((a, b) => a.block.blockNumber - b.block.blockNumber || a.txnIndex - b.txnIndex || a.eventIndex - b.eventIndex);
}

/** A pool as a GeckoTerminal pair: when it opened is its oldest transaction, read once per instance. */
export async function pairOf(rpc, address) {
  if (state.pairs.has(address)) return state.pairs.get(address);
  const pools = await listPools(rpc);
  const p = pools.get(address);
  if (!p) return null;
  let oldest = null;
  let before;
  for (let page = 0; page < 50; page++) {
    const list = await rpc("getSignaturesForAddress", [address, { limit: 1000, commitment: "finalized", ...(before ? { before } : {}) }]);
    if (!Array.isArray(list) || !list.length) break;
    oldest = list[list.length - 1];
    if (list.length < 1000) break;
    before = oldest.signature;
  }
  const pair = {
    id: address, dexKey: DEX_KEY, asset0Id: p.mint0, asset1Id: p.mint1,
    ...(oldest ? { createdAtBlockNumber: oldest.slot, createdAtBlockTimestamp: oldest.blockTime, createdAtTxnId: oldest.signature } : {}),
    ...(p.feeBps === null ? {} : { feeBps: p.feeBps }),
  };
  state.pairs.set(address, pair);
  return pair;
}

/** A coin as a GeckoTerminal asset: decimals and supply from its mint, its name from its own metadata, or null when there is no such mint. */
export async function assetOf(rpc, mint) {
  const info = (await rpc("getAccountInfo", [mint, { encoding: "base64", commitment: "finalized" }]))?.value;
  if (!info?.data?.[0]) return null;
  const d = Buffer.from(info.data[0], "base64");
  if (d.length < 82) return null;
  const decimals = d[44];
  const supply = u64(d, 36);
  let names = WELL_KNOWN[mint] ?? null;
  if (!names && info.owner === TOKEN_2022_PROGRAM && d.length > 166) names = token2022Metadata(d);
  if (!names) {
    const meta = (await rpc("getAccountInfo", [metaplexPda(mint), { encoding: "base64", commitment: "finalized" }]))?.value;
    if (meta?.data?.[0]) names = metaplexMetadata(Buffer.from(meta.data[0], "base64"));
  }
  return {
    id: mint,
    name: names?.name || mint,
    symbol: names?.symbol || mint.slice(0, 6),
    decimals,
    // Wrapped SOL's mint reports no supply: left out rather than a zero that would make its market cap nil.
    ...(supply > 0n ? { totalSupply: decimal(supply, decimals) } : {}),
    ...(names?.coinGeckoId ? { coinGeckoId: names.coinGeckoId } : {}),
  };
}

/* ──────────────────────────────── handler ──────────────────────────────── */

const ENDPOINTS = new Set(["latest-block", "asset", "pair", "events"]);
const slotOf = (v) => (typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : null);

export async function handleGeckoTerminal(req, res, deps = {}) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  const method = String(req.method || "").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!isRequestOriginAllowed(req)) return res.status(403).json({ error: "Origin not allowed" });
  const endpoint = String(req.query?.endpoint ?? "");
  if (!ENDPOINTS.has(endpoint)) return res.status(404).json({ error: "No such endpoint: latest-block, asset, pair or events" });
  // GeckoTerminal polls every 2 s from a few addresses; a stranger hammering this hits the limit.
  if (!(await (deps.checkRateLimit ?? checkRateLimit)(req, res, { limit: 120, windowSec: 60, identifier: "gt" }))) return;
  const rpc = deps.rpc ?? makeRpc(deps.fetchImpl);
  const now = deps.now ?? Date.now;
  try {
    if (endpoint === "latest-block") {
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ block: await latestBlock(rpc) });
    }
    if (endpoint === "asset") {
      const id = parseKey(req.query?.id);
      if (!id) return res.status(400).json({ error: "id must be a Solana mint address" });
      const asset = await assetOf(rpc, id);
      if (!asset) return res.status(404).json({ error: "No such mint" });
      res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
      return res.status(200).json({ asset });
    }
    if (endpoint === "pair") {
      const id = parseKey(req.query?.id);
      if (!id) return res.status(400).json({ error: "id must be a pool address" });
      const pair = await pairOf(rpc, id);
      if (!pair) return res.status(404).json({ error: "No such pool on the program" });
      res.setHeader("Cache-Control", "s-maxage=86400");
      return res.status(200).json({ pair });
    }
    const fromBlock = slotOf(req.query?.fromBlock);
    const toBlock = slotOf(req.query?.toBlock);
    if (fromBlock === null || toBlock === null || toBlock < fromBlock) return res.status(400).json({ error: "fromBlock and toBlock must be slots, fromBlock first" });
    if (toBlock - fromBlock > MAX_SLOT_RANGE) return res.status(400).json({ error: `at most ${MAX_SLOT_RANGE} slots a call` });
    const events = await eventsIn(rpc, fromBlock, toBlock);
    // Slots well behind the finalized tip never change: the edge may keep them a day.
    const tip = await rpc("getSlot", [{ commitment: "finalized" }]);
    res.setHeader("Cache-Control", toBlock <= tip - SETTLED_SLOTS ? "s-maxage=86400" : "no-store");
    return res.status(200).json({ events });
  } catch (e) {
    const why = logSafe(e?.message ?? String(e));
    console.error(`[gt] ${endpoint} ${now()}: ${why}`);
    return res.status(502).json({ error: e?.tooMany ? why : "The chain could not be read; try again" });
  }
}
