// AUDIT F10: canonical Seaport orderHash derivation.
//
// Why this module exists
// ──────────────────────
// Seaport emits the `OrderFulfilled(bytes32 orderHash, address indexed offerer,
// address indexed zone, address recipient, SpentItem[] offer, ReceivedItem[]
// consideration)` event whenever an order is fulfilled. The on-chain
// `orderHash` is the keccak256 struct-hash of OrderComponents (NOT the
// full EIP-712 digest — Seaport stores hashStruct, not the prefixed digest,
// because struct equality is sufficient inside a single contract instance).
//
// Reference: ProjectOpenSea/seaport `lib/GettersAndDerivers.sol`
//   function _deriveOrderHash(...) — keccak256(abi.encode(typehash, ...))
//
// To verify a fill we need to compare this on-chain orderHash to a
// server-stored value. Pre-fix the application stored sha256(JSON(params))
// which never matched anything Seaport emitted; this module computes the
// real keccak256 struct-hash both client-side (at create-time, sent in the
// POST body) and server-side (defense in depth — re-derived from the
// canonical parameters before INSERT).
//
// Battle-tested patterns referenced:
//   - Seaport SDK `getOrderHash`              (canonical reference)
//   - viem `hashStruct(OrderComponents)`      (matches Seaport byte-for-byte)
//
// We use viem's `hashStruct` directly: it implements EIP-712 type encoding
// exactly per spec, with alphabetic sub-type ordering. For a struct that
// nests OfferItem and ConsiderationItem, hashStruct produces:
//   keccak256( OrderComponents-typehash || encoded-fields )
// which is precisely what Seaport's _deriveOrderHash returns. We confirmed
// this with a side-by-side viem-vs-manual derivation; both produce the
// same 32-byte hash for arbitrary OrderComponents.

import { hashStruct } from "viem/utils";

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Same type definitions as `seaport-verify.js` (single-source-of-truth would
// require a shared module; keeping them inline here keeps the helper
// self-contained and the fields are stable for the life of Seaport 1.5/1.6).
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

const SEAPORT_HASH_RE = /^0x[0-9a-f]{64}$/;

/**
 * Compute Seaport's canonical orderHash (the value emitted in OrderFulfilled
 * and used for `cancel`/`validate` lookups inside Seaport itself).
 *
 * The hash is `hashStruct(OrderComponents)` per EIP-712 — i.e.
 *   keccak256( type-hash(OrderComponents) ++ encodedFields )
 * with `OfferItem[]` / `ConsiderationItem[]` flattened to keccak256(concat(
 *   keccak256(typehash || item) for item in array )).
 *
 * Counter MUST match the value the offerer's wallet was at when the order
 * was signed. The client passes it in alongside `parameters`; the server
 * trusts the client's claim, then re-derives from the same inputs to
 * detect tampering between client and DB write.
 *
 * @param {object} parameters Seaport OrderComponents minus `counter`
 * @param {string|number|bigint} counter Seaport per-offerer nonce at sign-time
 * @returns {`0x${string}`} 0x-prefixed lowercase 32-byte hash
 */
export function computeSeaportOrderHash(parameters, counter) {
  if (!parameters || typeof parameters !== "object") {
    throw new Error("computeSeaportOrderHash: parameters required");
  }
  if (counter == null) {
    throw new Error("computeSeaportOrderHash: counter required");
  }

  // Coerce all numeric/bytes fields to the types viem.hashStruct expects.
  // Stored params may come back as JSON so big numbers are strings.
  const offer = (parameters.offer || []).map((o) => ({
    itemType: Number(o.itemType ?? 0),
    token: o.token,
    identifierOrCriteria: BigInt(o.identifierOrCriteria ?? "0"),
    startAmount: BigInt(o.startAmount ?? "0"),
    endAmount: BigInt(o.endAmount ?? "0"),
  }));
  const consideration = (parameters.consideration || []).map((c) => ({
    itemType: Number(c.itemType ?? 0),
    token: c.token,
    identifierOrCriteria: BigInt(c.identifierOrCriteria ?? "0"),
    startAmount: BigInt(c.startAmount ?? "0"),
    endAmount: BigInt(c.endAmount ?? "0"),
    recipient: c.recipient,
  }));

  const data = {
    offerer: parameters.offerer,
    zone: parameters.zone || ZERO_ADDRESS,
    offer,
    consideration,
    orderType: Number(parameters.orderType ?? 0),
    startTime: BigInt(parameters.startTime ?? "0"),
    endTime: BigInt(parameters.endTime ?? "0"),
    zoneHash: parameters.zoneHash || ZERO_BYTES32,
    salt: BigInt(parameters.salt ?? "0"),
    conduitKey: parameters.conduitKey || ZERO_BYTES32,
    counter: BigInt(counter),
  };

  const h = hashStruct({
    data,
    primaryType: "OrderComponents",
    types: SEAPORT_ORDER_TYPES,
  });

  // Normalize to lowercase so DB equality and CHECK constraint pass.
  return h.toLowerCase();
}

/**
 * Validate that a string looks like a Seaport orderHash (0x + 64 hex chars,
 * lowercase). Used at the API boundary for request validation.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidSeaportOrderHash(value) {
  return typeof value === "string" && SEAPORT_HASH_RE.test(value);
}
