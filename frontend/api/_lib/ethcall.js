/**
 * Minimal, dependency-free `eth_call` transport for serverless routes.
 *
 * Extracted VERBATIM from `_lib/seaport-verify.js` (the RPC-failover block
 * that lived at lines 142-247) so a route needing a single 32-byte on-chain
 * read does NOT have to import `seaport-verify.js` — that module pulls `viem`
 * in at the top level, which would land the whole EIP-712 stack in an
 * unrelated lambda's cold start.
 *
 * NOTHING in this file is new logic. Comments are carried across unchanged so
 * the operational history (which public RPCs are dead and why) travels with
 * the code.
 *
 * NOTE: `seaport-verify.js` still carries its own copy of this block — the
 * de-duplication half of the change needs an edit to that file, which the
 * agent that created this module did not own. `__tests__/ethcall.test.js`
 * pins the two RPC rosters byte-for-byte so they cannot drift apart in the
 * meantime. Once seaport-verify.js imports from here, delete that guard.
 */

export function alchemyUrl() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key || key === "demo") return null;
  return `https://eth-mainnet.g.alchemy.com/v2/${key}`;
}

// ── RESIL-1 (2026-06-11): RPC failover chain ────────────────────────
// A lapsed/disabled Alchemy key used to 503 every order create (getCounter +
// ownerOf both dead). The chain below degrades instead: primary Alchemy key →
// optional ALCHEMY_API_KEY_FALLBACK → public JSON-RPC endpoints (mirrors the
// client-side transport list in `frontend/src/lib/wagmi.ts`). The chain is
// only consulted when Alchemy IS configured — the no-key-at-all policy stays
// exactly as before (prod fails closed with `rpc-unavailable`, non-prod skips
// with a warning), so a misconfigured deploy still can't silently verify
// nothing. Fail-closed is reached only when EVERY path fails.
// Roster re-verified live 2026-06-14 via a REAL read (eth_blockNumber, not the
// eth_chainId trap that sunset gateways still answer): publicnode, drpc,
// eth.merkle.io all return the current block. Dropped BOTH cloudflare-eth
// (answers eth_chainId but -32046 "Cannot fulfill request" on every real
// read/eth_call — and that JSON-RPC error would even abort the chain here) and
// eth.llamarpc.com (HTTP 521, origin down). This is the server path, so CORS is
// irrelevant — only real-read liveness matters.
export const PUBLIC_RPC_URLS = Object.freeze([
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  // eth.merkle.io DROPPED 2026-08-25: 429s every request (rate-limited the
  // keyless tier off) — a dead third slot that closed the failover chain and
  // burned a retry on every rotation. Re-verify with a REAL read (eth_blockNumber
  // + Origin) before ever re-adding. publicnode + drpc re-verified live today.
]);

export function rpcUrlChain() {
  const urls = [];
  const primary = alchemyUrl();
  if (primary) urls.push(primary);
  const fb = process.env.ALCHEMY_API_KEY_FALLBACK;
  if (fb && fb !== "demo") {
    const fbUrl = `https://eth-mainnet.g.alchemy.com/v2/${fb}`;
    if (fbUrl !== primary) urls.push(fbUrl);
  }
  urls.push(...PUBLIC_RPC_URLS);
  return urls;
}

// Hex-encode a uint256 padded to 32 bytes (no `0x` prefix).
export function pad32(value) {
  let h = BigInt(value).toString(16);
  if (h.length > 64) throw new Error("uint256 out of range");
  return h.padStart(64, "0");
}

// Hex-encode an address padded to 32 bytes.
export function padAddr(addr) {
  const stripped = String(addr).toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(stripped)) throw new Error("bad address");
  return stripped.padStart(64, "0");
}

/**
 * Generic single-endpoint JSON-RPC call. `ethCallOnce` is the `eth_call` special case.
 *
 * Added for the birth-record route, which needs `eth_getCode` (presence + template
 * provenance) and `eth_getTransactionByHash` (the create-tx sender) alongside plain
 * `eth_call`. Deliberately generic rather than three near-copies: the failover, the
 * 2.5s abort and the "deterministic JSON-RPC errors are NOT retried" rule are the parts
 * worth having exactly once.
 *
 * ⚠️ NOT body-capped (`res.json()` below). Fine for 32-byte returns, EIP-170-bounded
 * `eth_getCode` and a single transaction object. Do NOT reach for this with
 * `eth_getLogs` or a receipt-heavy method without adding `readBoundedText`.
 */
export async function ethRpcOnce(url, method, params) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) {
    const err = new Error(json.error.message || "rpc error");
    err.rpcError = json.error;
    throw err;
  }
  return json.result;
}

/** Walk the RPC chain for any method. Same retry doctrine as `ethCall`. */
export async function ethRpc(method, params) {
  let lastErr = null;
  for (const url of rpcUrlChain()) {
    try {
      return await ethRpcOnce(url, method, params);
    } catch (err) {
      if (err.rpcError) throw err;
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("alchemy-not-configured");
}

/** Deployed bytecode at an address. `'0x'` means nothing is deployed there. */
export function ethGetCode(address) {
  return ethRpc("eth_getCode", [address, "latest"]);
}

/** A transaction by hash, or null when the node has never seen it. */
export function ethTxByHash(hash) {
  return ethRpc("eth_getTransactionByHash", [hash]);
}

export async function ethCallOnce(url, to, data) {
  // PERF/RESIL: bound each attempt so a hung node (no response, not a fast
  // error) is abandoned in ~2.5s and ethCall() advances to the next URL,
  // instead of consuming the whole request budget on Node's default timeout.
  // AbortError has no .rpcError, so ethCall treats it as a transport failure
  // and falls through (deterministic execution-reverts still short-circuit).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to, data }, "latest"],
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) {
    const msg = json.error.message || "rpc error";
    const err = new Error(msg);
    err.rpcError = json.error;
    throw err;
  }
  return json.result;
}

// RESIL-1: walk the RPC chain. Deterministic JSON-RPC errors (execution
// revert — the "token not minted / not ERC721" signal) are NOT retried:
// every node returns the same answer and callers map them to a 4xx. Only
// transport-level failures (HTTP !ok, network throw) move to the next URL.
export async function ethCall(to, data) {
  let lastErr = null;
  for (const url of rpcUrlChain()) {
    try {
      return await ethCallOnce(url, to, data);
    } catch (err) {
      if (err.rpcError) throw err;
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("alchemy-not-configured");
}
