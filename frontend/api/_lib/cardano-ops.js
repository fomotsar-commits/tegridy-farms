// The Cardano chain reads this site makes, by name, and the Koios request each one becomes.
//
// A NAMED LIST, NOT A PASSTHROUGH. The browser asks /api/cardano/<op>?<params>; only the ops
// below exist, each param is checked against a strict pattern, and the request sent upstream
// is built here, whole. So nobody can use this site as an open proxy to a keyed provider: no
// path, no filter and no body from the caller ever reaches Koios (the lesson of
// aggregator-proxy.js AUDIT FE-CRIT-01 and solrpc.js L-1).
//
// Shared by api/cardano.js (production) and vite.config.ts (the dev server), so the two cannot
// drift.

import { OWN_POOLS_DEPLOYMENT } from "./cardano-own-pools.js";

export const KOIOS_BASE = "https://api.koios.rest/api/v1";

// Minswap V2 mainnet (minswap-dex-v2 @ c3293ad43, deployed/mainnet/script.json): the pool
// script's payment hash and the authen policy that mints every pool's LP token. Pinned here,
// not taken from the caller, so a pool read can only ever ask about Minswap V2 pools.
// src/lib/cardano/minswapV2.ts holds the same two; cardano.test.js holds them equal.
export const MINSWAP_V2_POOL_SCRIPT = "ea07b733d932129c378af627436e7cbc2ef0bf96e0036bb51b3bde6b";
export const MINSWAP_V2_AUTHEN_POLICY = "f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c";

const HEX64 = /^[0-9a-f]{64}$/;
const HEX56 = /^[0-9a-f]{56}$/;
const ASSET_NAME = /^(?:[0-9a-f]{2}){0,32}$/;
const UTXO_REF = /^([0-9a-f]{64})#(\d{1,5})$/;
const HEIGHT = /^\d{1,10}$/;

const NO_STORE = "private, no-store";

/**
 * op → { params, cache, build(query) }. `params` are the only query keys the read takes: any
 * other key, or one repeated, is refused before Koios is asked, so `tip?x=1`, `tip?x=2`, ...
 * cannot each miss the edge cache and spend the shared key's quota. build returns the upstream
 * request, or null when a param is missing or malformed. Cache: only reads that are the same
 * for every visitor are cached at the edge; anything about one wallet or one transaction is
 * no-store.
 */
const BASE_OPS = {
  tip: {
    params: [],
    cache: "public, max-age=5, s-maxage=10",
    build: () => ({ path: "/tip", method: "GET" }),
  },
  params: {
    params: [],
    cache: "public, max-age=300, s-maxage=600",
    build: () => ({ path: "/cli_protocol_params", method: "GET" }),
  },
  // Every UTxO at Minswap V2's pool script holding this LP token: the pool, and any pool that
  // holds the LP token as its coin. The browser decides which is the pool (minswapV2.readPool).
  pool: {
    params: ["lp"],
    cache: NO_STORE,
    build: (q) =>
      HEX64.test(q.lp ?? "")
        ? {
            path: `/asset_utxos?payment_cred=eq.${MINSWAP_V2_POOL_SCRIPT}`,
            method: "POST",
            body: { _asset_list: [[MINSWAP_V2_AUTHEN_POLICY, q.lp]], _extended: true },
          }
        : null,
  },
  asset: {
    params: ["policy", "name"],
    cache: "public, max-age=600, s-maxage=3600",
    build: (q) =>
      HEX56.test(q.policy ?? "") && ASSET_NAME.test(q.name ?? "")
        ? { path: "/asset_info", method: "POST", body: { _asset_list: [[q.policy, q.name ?? ""]] } }
        : null,
  },
  txstatus: {
    params: ["tx"],
    cache: NO_STORE,
    build: (q) => (HEX64.test(q.tx ?? "") ? { path: "/tx_status", method: "POST", body: { _tx_hashes: [q.tx] } } : null),
  },
  utxo: {
    params: ["ref"],
    cache: NO_STORE,
    build: (q) => (UTXO_REF.test(q.ref ?? "") ? { path: "/utxo_info", method: "POST", body: { _utxo_refs: [q.ref], _extended: false } } : null),
  },
  // A wallet's transactions from the order's block on, OLDEST first, capped: how a fill is
  // found. The batcher fills within a few blocks, so the fill is among the first rows however
  // busy the wallet has been since (newest first, an active wallet pushed it past the cap).
  credtxs: {
    params: ["cred", "after"],
    cache: NO_STORE,
    build: (q) =>
      HEX56.test(q.cred ?? "") && HEIGHT.test(q.after ?? "")
        ? {
            path: "/credential_txs?order=block_height.asc&limit=40",
            method: "POST",
            body: { _payment_credentials: [q.cred], _after_block_height: Number(q.after) },
          }
        : null,
  },
  tx: {
    params: ["tx"],
    cache: NO_STORE,
    build: (q) =>
      HEX64.test(q.tx ?? "")
        ? {
            path: "/tx_info",
            method: "POST",
            body: { _tx_hashes: [q.tx], _inputs: true, _metadata: false, _assets: true, _withdrawals: false, _certs: false, _scripts: false, _bytecode: false },
          }
        : null,
  },
};

// utils.ak: the factory's NFT ("MSF") and the global setting's ("MSGS"), under the authen policy.
const FACTORY_NFT = "4d5346";
const SETTING_NFT = "4d534753";

/**
 * The venue's own pools' reads, pinned to `dep` (cardano-own-pools.js): our pool script, our
 * factory, our settings, our authen policy; the caller names only an LP token. They exist only
 * once the record does, so until the deploy no request can reach our pools or anyone's.
 */
export function ownPoolOps(dep) {
  const assetUtxos = (cred, asset, limit) => ({
    path: `/asset_utxos?payment_cred=eq.${cred}${limit ? `&limit=${limit}` : ""}`,
    method: "POST",
    body: { _asset_list: [[dep.authenPolicy, asset]], _extended: true },
  });
  return {
    ownpool: {
      params: ["lp"],
      cache: NO_STORE,
      build: (q) => (HEX64.test(q.lp ?? "") ? assetUtxos(dep.poolScriptHash, q.lp) : null),
    },
    // The factory's linked list: one entry per pool, plus one. A new pool takes the entry whose
    // gap holds its LP name. Read whole or called unread (chainReads.ts KOIOS_PAGE).
    ownfactory: {
      params: [],
      cache: NO_STORE,
      build: () => assetUtxos(dep.factoryScriptHash, FACTORY_NFT, 1000),
    },
    // The global setting sits at the authen policy's own script address.
    ownsetting: {
      params: [],
      cache: "public, max-age=30, s-maxage=60",
      build: () => assetUtxos(dep.authenPolicy, SETTING_NFT),
    },
  };
}

export const CARDANO_OPS = { ...BASE_OPS, ...(OWN_POOLS_DEPLOYMENT ? ownPoolOps(OWN_POOLS_DEPLOYMENT) : {}) };

/** One string per param, the first if repeated; anything else is dropped. */
function flatQuery(query) {
  const out = {};
  for (const [k, v] of Object.entries(query ?? {})) {
    const first = Array.isArray(v) ? v[0] : v;
    if (typeof first === "string") out[k] = first;
  }
  return out;
}

/**
 * The Koios request for `op` with `query`, or { error } with the status to answer.
 * `apiKey` is KOIOS_API_KEY: sent as a bearer token upstream, never back to the browser.
 */
export function buildKoiosRequest(op, query, apiKey) {
  const def = typeof op === "string" && Object.prototype.hasOwnProperty.call(CARDANO_OPS, op) ? CARDANO_OPS[op] : null;
  if (!def) return { error: 404, message: "Unknown Cardano read" };
  for (const [k, v] of Object.entries(query ?? {})) {
    if (!def.params.includes(k) || Array.isArray(v)) return { error: 400, message: "Bad parameters" };
  }
  const built = def.build(flatQuery(query));
  if (!built) return { error: 400, message: "Bad parameters" };
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const init = { method: built.method, headers };
  if (built.body) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(built.body);
  }
  return { url: `${KOIOS_BASE}${built.path}`, init, cache: def.cache };
}
