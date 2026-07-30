// AUDIT R053: Server-side Seaport order verification + on-chain ownership check.
//
// Why this module exists
// ──────────────────────
// Earlier the orderbook only verified a wrapper personal_sign auth message
// ("Create order for 0x... | Contract: ... | Price: ...") — never the
// Seaport EIP-712 signature itself, and never on-chain ownership. A malicious
// caller could:
//
//   1. Sign a *valid auth message* with their own wallet (so the auth check
//      passes), but stuff `parameters.offerer` with somebody else's address
//      and replay a previously-collected Seaport signature for a different
//      collection / price → spoofed listing.
//   2. List NFTs they don't own. The order is never fulfillable on-chain
//      (Seaport will revert), but in the meantime the row pollutes the
//      orderbook's "lowest price" sort and griefs every listing UI.
//
// This module fixes both gaps by:
//
//   - Verifying the Seaport EIP-712 signature against `parameters.offerer`
//     using viem's `verifyTypedData` helper (full domain + struct hash +
//     ecrecover). Counter is fetched from Seaport on-chain so the typed-data
//     payload exactly matches what the wallet signed (Seaport uses the
//     offerer's nonce).
//   - Calling `IERC721.ownerOf(tokenId)` against the NFT contract via
//     Alchemy RPC and requiring the result equals `parameters.offerer`.
//
// Both checks are skipped (with a warning) outside production when no
// Alchemy key is configured — matches the policy in `ratelimit.js`. In
// production a missing key returns a 503, never silently allows the order.
//
// Battle-tested patterns referenced:
//   - OpenZeppelin EIP712 + ECDSA       (typed-data hashing + recover)
//   - Reservoir Protocol orderbook      (signature + ownership pre-checks)
//   - Seaport SDK `verifyOrder`          (parameters + signature → offerer)

import { verifyTypedData, createPublicClient, http, fallback } from "viem";
import { mainnet, sepolia } from "viem/chains";

// AUDIT FIX H-1-FINDING-2: chainId was hardcoded to `1` in SEAPORT_DOMAIN, so
// any future deploy targeting a testnet (or an L2 Seaport instance) would
// silently produce wrong EIP-712 digests and reject every honest signature.
// Read from env with a mainnet default; validate against an allowlist so a
// typo in `SEAPORT_CHAIN_ID` fails fast at module load instead of after the
// first user listing fails. The allowlist matches the SIWE chainId guard in
// `frontend/api/auth/siwe.js` (mainnet-only today; sepolia kept for staging).
const SUPPORTED_VIEM_CHAINS = Object.freeze({
  1: mainnet,
  11155111: sepolia,
});
function seaportChainId() {
  const raw = process.env.SEAPORT_CHAIN_ID;
  if (raw == null || raw === "") return 1;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || !SUPPORTED_VIEM_CHAINS[parsed]) {
    throw new Error(
      `Invalid SEAPORT_CHAIN_ID=${raw}; supported: ${Object.keys(SUPPORTED_VIEM_CHAINS).join(",")}`,
    );
  }
  return parsed;
}
const SEAPORT_CHAIN_ID = seaportChainId();
const SEAPORT_VIEM_CHAIN = SUPPORTED_VIEM_CHAINS[SEAPORT_CHAIN_ID];

// REVIEW H-1-FINDING-1: viem's standalone `verifyTypedData` is EOA-only — it
// runs ECDSA recovery and compares to `address`. Smart Contract Wallets
// (Safe / Argent / Coinbase Smart Wallet / 4337 accounts) sign via EIP-1271
// `isValidSignature(hash, sig)` — recovery against the SCW address fails
// even though the signature is valid for the SCW.
//
// `publicClient.verifyTypedData` does ECDSA recovery first; if the address is
// a contract, it falls back to an `isValidSignature` staticcall (and ERC-6492
// pre-deploy signatures). Reuses the same Alchemy URL we already use for
// `fetchSeaportCounter` / `fetchNftOwner`.
let _publicClient = null;
function getPublicClient() {
  if (_publicClient) return _publicClient;
  const url = alchemyUrl();
  if (!url) return null;
  // RESIL-1: viem's canonical `fallback` transport — the EIP-1271 staticcall
  // (and ERC-6492 deployless validation) survives a lapsed Alchemy key by
  // demoting to the fallback key, then the public RPC list.
  _publicClient = createPublicClient({
    chain: SEAPORT_VIEM_CHAIN,
    transport: fallback(rpcUrlChain().map((u) => http(u))),
  });
  return _publicClient;
}

// Pinned Seaport address — the verifyingContract used in SEAPORT_DOMAIN on
// the client (`frontend/src/nakamigos/constants.js`). MUST match exactly or
// EIP-712 hash differs and signature verification fails for honest users.
const SEAPORT_VERIFYING_CONTRACT = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC";
const SEAPORT_DOMAIN = Object.freeze({
  name: "Seaport",
  version: "1.5",
  chainId: SEAPORT_CHAIN_ID,
  verifyingContract: SEAPORT_VERIFYING_CONTRACT,
});

const SEAPORT_ORDER_TYPES = Object.freeze({
  OrderComponents: [
    { name: "offerer", type: "address" },
    { name: "zone", type: "address" },
    { name: "offer", type: "OfferItem[]" },
    { name: "consideration", type: "ConsiderationItem[]" },
    { name: "orderType", type: "uint8" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "zoneHash", type: "bytes32" },
    { name: "salt", type: "uint256" },
    { name: "conduitKey", type: "bytes32" },
    { name: "counter", type: "uint256" },
  ],
  OfferItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
  ],
  ConsiderationItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
    { name: "recipient", type: "address" },
  ],
});

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// keccak256("getCounter(address)") = 0xf07ec373
const SELECTOR_GET_COUNTER = "0xf07ec373";
// keccak256("ownerOf(uint256)") = 0x6352211e
const SELECTOR_OWNER_OF = "0x6352211e";

const IS_PRODUCTION = process.env.NODE_ENV === "production";

function alchemyUrl() {
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
const PUBLIC_RPC_URLS = Object.freeze([
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  "https://eth.merkle.io",
]);

function rpcUrlChain() {
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
function pad32(value) {
  let h = BigInt(value).toString(16);
  if (h.length > 64) throw new Error("uint256 out of range");
  return h.padStart(64, "0");
}

// Hex-encode an address padded to 32 bytes.
function padAddr(addr) {
  const stripped = String(addr).toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(stripped)) throw new Error("bad address");
  return stripped.padStart(64, "0");
}

async function ethCallOnce(url, to, data) {
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
async function ethCall(to, data) {
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

/**
 * Fetch the current Seaport counter for an offerer. Required because the
 * Seaport EIP-712 message includes a nonce that the wallet doesn't expose.
 *
 * @param {string} offerer
 * @returns {Promise<bigint>}
 */
export async function fetchSeaportCounter(offerer) {
  if (!alchemyUrl()) throw new Error("alchemy-not-configured");
  const data = `${SELECTOR_GET_COUNTER}${padAddr(offerer)}`;
  const result = await ethCall(SEAPORT_VERIFYING_CONTRACT, data);
  if (!result || result === "0x") return 0n;
  return BigInt(result);
}

/**
 * Read `ownerOf(tokenId)` on the given NFT contract.
 *
 * @param {string} contract
 * @param {string|bigint} tokenId
 * @returns {Promise<string>} lowercase address
 */
export async function fetchNftOwner(contract, tokenId) {
  if (!alchemyUrl()) throw new Error("alchemy-not-configured");
  const data = `${SELECTOR_OWNER_OF}${pad32(tokenId)}`;
  let result;
  try {
    result = await ethCall(contract, data);
  } catch (err) {
    // Token not minted / burned / contract reverts → propagate so caller
    // can return a 4xx, not a 5xx. RESIL-1: only deterministic JSON-RPC
    // reverts carry the 4xx tag; a transport failure that exhausted the
    // whole RPC chain stays untagged so callers map it to rpc-unavailable.
    if (err.rpcError) err.code = "OWNER_OF_REVERT";
    throw err;
  }
  if (!result || result === "0x" || result.length < 66) {
    const err = new Error("ownerOf returned empty data");
    err.code = "OWNER_OF_EMPTY";
    throw err;
  }
  // address is right-aligned in 32-byte word
  const owner = "0x" + result.slice(-40).toLowerCase();
  return owner;
}

/**
 * Build the EIP-712 message exactly as the wallet signed it. Counter is
 * appended (it's part of OrderComponents but not transmitted in the listing
 * row — fetch it from chain).
 */
export function buildSeaportMessage(parameters, counter) {
  // Coerce all numeric / bytes fields to the types viem.verifyTypedData
  // expects. Stored params come back as JSON so big numbers are strings.
  return {
    offerer: parameters.offerer,
    zone: parameters.zone || ZERO_ADDRESS,
    offer: parameters.offer.map(o => ({
      itemType: Number(o.itemType),
      token: o.token,
      identifierOrCriteria: BigInt(o.identifierOrCriteria || "0"),
      startAmount: BigInt(o.startAmount || "0"),
      endAmount: BigInt(o.endAmount || "0"),
    })),
    consideration: parameters.consideration.map(c => ({
      itemType: Number(c.itemType),
      token: c.token,
      identifierOrCriteria: BigInt(c.identifierOrCriteria || "0"),
      startAmount: BigInt(c.startAmount || "0"),
      endAmount: BigInt(c.endAmount || "0"),
      recipient: c.recipient,
    })),
    orderType: Number(parameters.orderType ?? 0),
    startTime: BigInt(parameters.startTime || "0"),
    endTime: BigInt(parameters.endTime || "0"),
    zoneHash: parameters.zoneHash || ZERO_BYTES32,
    salt: BigInt(parameters.salt || "0"),
    conduitKey: parameters.conduitKey || ZERO_BYTES32,
    counter: BigInt(counter),
  };
}

/**
 * Verify a Seaport order's EIP-712 signature recovers to `parameters.offerer`.
 *
 * Pulls the offerer's current Seaport counter via Alchemy. Returns
 * `{ ok: true }` on success, or `{ ok: false, error }` on failure.
 *
 * If `ALCHEMY_API_KEY` is unset:
 *   - production → returns { ok: false, error: 'rpc-unavailable' } (503 caller-side)
 *   - non-prod   → returns { ok: true, skipped: true } so dev/tests still work
 */
export async function verifySeaportSignature({ parameters, signature }) {
  if (!alchemyUrl()) {
    if (IS_PRODUCTION) return { ok: false, error: "rpc-unavailable" };
    console.warn("[seaport-verify] ALCHEMY_API_KEY missing — skipping signature verification (non-prod)");
    return { ok: true, skipped: true };
  }
  let counter;
  try {
    counter = await fetchSeaportCounter(parameters.offerer);
  } catch (err) {
    console.error("[seaport-verify] getCounter failed:", err.message);
    return { ok: false, error: "rpc-unavailable" };
  }
  let message;
  try {
    message = buildSeaportMessage(parameters, counter);
  } catch {
    return { ok: false, error: "bad-parameters" };
  }
  // REVIEW H-1-FINDING-1: prefer `publicClient.verifyTypedData` so EIP-1271
  // (Smart Contract Wallets) is supported. Falls back to the EOA-only
  // standalone `verifyTypedData` if the public client cannot be constructed
  // (e.g. ALCHEMY_API_KEY unset in dev — already handled above by the
  // `alchemyUrl()` early-return, but keep the fallback defensively).
  let ok;
  try {
    const pc = getPublicClient();
    if (pc) {
      ok = await pc.verifyTypedData({
        address: parameters.offerer,
        domain: SEAPORT_DOMAIN,
        types: SEAPORT_ORDER_TYPES,
        primaryType: "OrderComponents",
        message,
        signature,
      });
    } else {
      ok = await verifyTypedData({
        address: parameters.offerer,
        domain: SEAPORT_DOMAIN,
        types: SEAPORT_ORDER_TYPES,
        primaryType: "OrderComponents",
        message,
        signature,
      });
    }
  } catch {
    return { ok: false, error: "bad-signature" };
  }
  if (!ok) return { ok: false, error: "signature-mismatch" };
  return { ok: true };
}

/**
 * Verify the offerer actually owns the NFT being listed. For listings
 * (itemType 2 = ERC721, 3 = ERC1155), the NFT lives in `parameters.offer[0]`.
 * For ERC1155 the on-chain check is a balance not ownership — out of scope
 * for the v1 audit; we only enforce for ERC721.
 *
 * Returns `{ ok: true }` or `{ ok: false, error }`.
 */
export async function verifyNftOwnership({ parameters }) {
  if (!alchemyUrl()) {
    if (IS_PRODUCTION) return { ok: false, error: "rpc-unavailable" };
    console.warn("[seaport-verify] ALCHEMY_API_KEY missing — skipping ownership check (non-prod)");
    return { ok: true, skipped: true };
  }
  const item = parameters.offer?.[0];
  if (!item) return { ok: false, error: "no-offer-item" };
  // FAIL CLOSED at the sink. This used to `return { ok: true, skipped: true }` for any
  // non-ERC721 item — an ownership check that answers "yes" when it did not check. The
  // caller could then store a listing for an NFT the poster does not own just by sending
  // itemType 3. ERC1155 ownership really is a balanceOf+id check we don't implement, so
  // the honest answer is "unsupported", not "fine". If ERC1155 is ever supported, add the
  // balanceOf branch here rather than reinstating the skip.
  if (Number(item.itemType) !== 2) return { ok: false, error: "unsupported-item-type" };
  const tokenId = item.identifierOrCriteria;
  if (tokenId == null) return { ok: false, error: "no-token-id" };
  let owner;
  try {
    owner = await fetchNftOwner(item.token, tokenId);
  } catch (err) {
    if (err.code === "OWNER_OF_REVERT" || err.code === "OWNER_OF_EMPTY") {
      // Token not minted, contract not ERC721, etc. — reject 4xx.
      return { ok: false, error: "token-not-found" };
    }
    console.error("[seaport-verify] ownerOf failed:", err.message);
    return { ok: false, error: "rpc-unavailable" };
  }
  if (owner !== String(parameters.offerer).toLowerCase()) {
    return { ok: false, error: "not-owner" };
  }
  return { ok: true };
}

/**
 * Bundle variant of verifyNftOwnership: the offerer must own EVERY ERC721 offer
 * item. Mirrors verifyNftOwnership's per-item logic + error mapping exactly, looped
 * over all offer items — any single item failing fails the whole bundle (all-or-
 * nothing, like the Seaport order itself). Returns `{ ok: true }` or `{ ok: false, error }`.
 * Only reached from the env-gated create-bundle handler, which already restricts offer
 * items to ERC721 from allowed collections.
 */
export async function verifyBundleOwnership({ parameters }) {
  if (!alchemyUrl()) {
    if (IS_PRODUCTION) return { ok: false, error: "rpc-unavailable" };
    console.warn("[seaport-verify] ALCHEMY_API_KEY missing — skipping bundle ownership check (non-prod)");
    return { ok: true, skipped: true };
  }
  const offer = parameters.offer;
  if (!Array.isArray(offer) || offer.length === 0) return { ok: false, error: "no-offer-item" };

  // PERF 2026-07-19: these ownerOf calls used to run SEQUENTIALLY. Each one can burn up
  // to its own 2.5s abort across a multi-URL failover chain, so a large bundle could
  // exceed the serverless deadline — and it would do so AFTER the seller had already
  // paid approval gas and signed twice, which is exactly the state that produces a
  // duplicate bundle on retry. Fanning out turns worst-case latency from N×2.5s into
  // ~2.5s. Bounded by MAX_BUNDLE_ITEMS (15) on the caller, so the fan-out is small.
  const checks = await Promise.allSettled(
    offer.map((item) => {
      // Only ERC721 enforced (matches verifyNftOwnership). ERC1155 ownership is a
      // balance check, out of scope; the create-bundle handler rejects non-ERC721 anyway.
      if (Number(item.itemType) !== 2) return Promise.resolve(null); // skipped
      const tokenId = item.identifierOrCriteria;
      if (tokenId == null) return Promise.reject(Object.assign(new Error("no-token-id"), { code: "NO_TOKEN_ID" }));
      return fetchNftOwner(item.token, tokenId);
    }),
  );

  // Evaluate in ORIGINAL ORDER so error precedence stays deterministic — same first
  // error the sequential loop would have returned.
  const offerer = String(parameters.offerer).toLowerCase();
  for (const result of checks) {
    if (result.status === "rejected") {
      const err = result.reason || {};
      if (err.code === "NO_TOKEN_ID") return { ok: false, error: "no-token-id" };
      if (err.code === "OWNER_OF_REVERT" || err.code === "OWNER_OF_EMPTY") {
        return { ok: false, error: "token-not-found" };
      }
      console.error("[seaport-verify] bundle ownerOf failed:", err.message);
      return { ok: false, error: "rpc-unavailable" };
    }
    if (result.value === null) continue; // non-ERC721, skipped
    if (result.value !== offerer) return { ok: false, error: "not-owner" };
  }
  return { ok: true };
}

// ── Price sanity ────────────────────────────────────────────────────
// Hard cap on `priceWei` so a single overflowing listing can't pollute the
// `price_eth ASC` sort. 10**24 wei = 1,000,000 ETH. Real-world floor for any
// of our supported collections is < 1 ETH, so this is generous by 6 orders
// of magnitude.
export const MAX_PRICE_WEI = 10n ** 24n;

/**
 * Convert a wei BigInt to a Number suitable for the `numeric` column,
 * with full BigInt arithmetic (no Infinity / no precision loss in the
 * "below cap" range).
 *
 * Caller is expected to have rejected priceWei > MAX_PRICE_WEI.
 */
export function priceWeiToEthNumber(priceWei, decimals) {
  const divisor = 10n ** BigInt(decimals);
  // 8 decimal places of precision (matches the original code's intent
  // of `(priceBig * 1e8) / divisor / 1e8`). With priceWei <= 10**24 and
  // decimals = 18, the intermediate (priceWei * 10**8) <= 10**32 which
  // is fine for BigInt.
  const scaled = (priceWei * 100000000n) / divisor;
  // scaled now fits comfortably in Number.MAX_SAFE_INTEGER for all
  // priceWei <= MAX_PRICE_WEI:  10**24 * 10**8 / 10**18 = 10**14 <<< 2**53.
  return Number(scaled) / 100000000;
}
