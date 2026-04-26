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

import { verifyTypedData } from "viem";

// Pinned Seaport address — the verifyingContract used in SEAPORT_DOMAIN on
// the client (`frontend/src/nakamigos/constants.js`). MUST match exactly or
// EIP-712 hash differs and signature verification fails for honest users.
const SEAPORT_VERIFYING_CONTRACT = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC";
const SEAPORT_DOMAIN = Object.freeze({
  name: "Seaport",
  version: "1.5",
  chainId: 1,
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

async function ethCall(url, to, data) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
  });
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

/**
 * Fetch the current Seaport counter for an offerer. Required because the
 * Seaport EIP-712 message includes a nonce that the wallet doesn't expose.
 *
 * @param {string} offerer
 * @returns {Promise<bigint>}
 */
export async function fetchSeaportCounter(offerer) {
  const url = alchemyUrl();
  if (!url) throw new Error("alchemy-not-configured");
  const data = `${SELECTOR_GET_COUNTER}${padAddr(offerer)}`;
  const result = await ethCall(url, SEAPORT_VERIFYING_CONTRACT, data);
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
  const url = alchemyUrl();
  if (!url) throw new Error("alchemy-not-configured");
  const data = `${SELECTOR_OWNER_OF}${pad32(tokenId)}`;
  let result;
  try {
    result = await ethCall(url, contract, data);
  } catch (err) {
    // Token not minted / burned / contract reverts → propagate so caller
    // can return a 4xx, not a 5xx.
    err.code = "OWNER_OF_REVERT";
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
  } catch (err) {
    return { ok: false, error: "bad-parameters" };
  }
  let ok;
  try {
    ok = await verifyTypedData({
      address: parameters.offerer,
      domain: SEAPORT_DOMAIN,
      types: SEAPORT_ORDER_TYPES,
      primaryType: "OrderComponents",
      message,
      signature,
    });
  } catch (err) {
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
  // Only ERC721 enforced here. ERC1155 (itemType 3) needs balanceOf+id; punt.
  if (Number(item.itemType) !== 2) return { ok: true, skipped: true };
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
