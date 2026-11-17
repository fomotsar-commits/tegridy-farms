/**
 * Shared Seaport hard-cancel helper.
 *
 * THE BUG this fixes (4 cloned copies): Seaport `cancel()` takes
 * OrderComponents[], whose trailing field is the offerer's live `counter`. The
 * signed OrderParameters look identical EXCEPT their trailing field is
 * `totalOriginalConsiderationItems`. The old call sites declared the ABI with
 * `totalOriginalConsiderationItems` and passed the raw parameters straight in,
 * so that value landed in the `counter` slot — Seaport then hashed a PHANTOM
 * order. The tx mined (cancel of a non-existent hash returns true), burned gas,
 * and the UI toasted "cancelled" — but the real listing/bid stayed 100%
 * fillable. Correct approach mirrors lib/trades.js cancelTradeOnChain: read the
 * live counter via getCounter(offerer) and rebuild OrderComponents.
 */
import { CONDUIT_KEY, resolveSeaportTarget } from "../constants";
import { cancelChainFor, walletChainLabel, venueRefusalError } from "./venue";
import { SEAPORT_16_ADDRESS, SEAPORT_ORDER_TYPES, seaport16Domain } from "./seaportOffer";

const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";

export const SEAPORT_CANCEL_ABI = [
  "function getCounter(address) view returns (uint256)",
  "function cancel((address offerer, address zone, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 counter)[] orders) returns (bool)",
];

/**
 * Pure: map a signed Seaport OrderParameters object to the OrderComponents the
 * `cancel()` call expects, substituting the offerer's live counter for the
 * parameters' trailing `totalOriginalConsiderationItems`. Every other field is
 * preserved exactly — the cancel only works if the rebuilt components hash
 * matches the originally-signed order.
 */
export function buildOrderComponents(params, counter) {
  return {
    offerer: params.offerer,
    zone: params.zone || ZERO,
    offer: (params.offer || []).map((i) => ({
      itemType: Number(i.itemType),
      token: i.token,
      identifierOrCriteria: BigInt(i.identifierOrCriteria || "0"),
      startAmount: BigInt(i.startAmount || "0"),
      endAmount: BigInt(i.endAmount || "0"),
    })),
    consideration: (params.consideration || []).map((i) => ({
      itemType: Number(i.itemType),
      token: i.token,
      identifierOrCriteria: BigInt(i.identifierOrCriteria || "0"),
      startAmount: BigInt(i.startAmount || "0"),
      endAmount: BigInt(i.endAmount || "0"),
      recipient: i.recipient,
    })),
    orderType: Number(params.orderType || 0),
    startTime: BigInt(params.startTime || "0"),
    endTime: BigInt(params.endTime || "0"),
    zoneHash: params.zoneHash || ZERO_HASH,
    salt: BigInt(params.salt || "0"),
    conduitKey: params.conduitKey || CONDUIT_KEY,
    counter: BigInt(counter),
  };
}

/**
 * Hard-cancel a signed Seaport order on-chain. Reads the offerer's live counter,
 * rebuilds the correct OrderComponents, and submits cancel(). Returns the ethers
 * transaction (the caller waits with waitForTxOutcome). Throws on wallet rejection / RPC
 * error (callers already map err.code 4001 → "rejected").
 */
export async function cancelSeaportOrder({ ethers, signer, params, seaportAddress }) {
  // Sent on the order's own chain (lib/venue.js): a Base order on Base.
  const where = cancelChainFor(params);
  if (where.error) throw venueRefusalError(where);
  if (where.chainId !== 1) {
    const network = await signer.provider.getNetwork();
    if (Number(network.chainId) !== where.chainId) {
      throw venueRefusalError({ error: "wrong-chain", message: `Switch your wallet to ${walletChainLabel(where.chain)} to cancel this order.` });
    }
  }
  // SECURITY: pin the target HERE, at the sink, rather than at each call site —
  // every caller passes a server-supplied `protocol_address` (MyListings,
  // OrderBookPanel), and this is the one place that turns it into a contract the
  // user signs against. Fail closed: an unrecognised target is refused, never
  // silently rewritten to the default.
  const target = resolveSeaportTarget(seaportAddress, where.chainId);
  if (!target) throw new Error('Unexpected transaction target — aborting for safety');
  const seaport = new ethers.Contract(target, SEAPORT_CANCEL_ABI, signer);
  const counter = await seaport.getCounter(params.offerer);
  const components = buildOrderComponents(params, counter);
  return seaport.cancel([components]);
}

// ═══ THE GASLESS CANCEL (OpenSea's offchain cancel of a SignedZone order) ═══
//
// A Seaport 1.6 order restricted to OpenSea's SignedZone can only be filled with
// a fresh signature from that zone, which OpenSea hands out. OpenSea stops handing
// them out for an order once its offerer signs this message and posts it:
//   EIP-712 domain { name "Seaport", version "1.6", chainId, verifyingContract: the
//   order's Seaport }, type OrderHash(bytes32 orderHash)
// (opensea-js CancellationManager.getOffererSignature, read 2026-11-15), to
//   POST /api/v2/orders/chain/{chain}/protocol/{protocol}/{orderHash}/cancel
//   body { offererSignature }.
// It costs no gas. Its limit, from OpenSea's own spec: a zone signature issued
// BEFORE the cancel stays valid up to 5 minutes, so a buyer already holding one
// can still fill until then (`last_signature_issued_valid_until`). And a very new
// order may be refused, in which case the caller sends the on-chain cancel.

/** What the UI says after a gasless cancel OpenSea confirmed. */
export const GASLESS_CANCEL_DONE = "Cancelled. OpenSea can still complete a sale it approved in the last 5 minutes.";

export const GASLESS_CANCEL_TYPES = Object.freeze({ OrderHash: [{ name: "orderHash", type: "bytes32" }] });

const ORDER_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const GASLESS_CHAINS = { 1: "ethereum", 8453: "base" };

// Which orders qualify (Seaport 1.6 + OpenSea's SignedZone) is
// seaportOffer.isSeaport16SignedZoneOrder; a Seaport 1.5 or zone-less order
// keeps the on-chain cancel above.

/** The message the offerer signs to cancel `orderHash` on this chain. */
export function gaslessCancelTypedData(orderHash, chainId) {
  if (!ORDER_HASH_RE.test(String(orderHash))) throw new TypeError("an order hash is 32 bytes");
  return {
    domain: seaport16Domain(chainId),
    types: GASLESS_CANCEL_TYPES,
    primaryType: "OrderHash",
    message: { orderHash: String(orderHash).toLowerCase() },
  };
}

/** The proxy path the cancel is posted to (the proxy admits exactly this shape). */
export function gaslessCancelPath(chainId, orderHash) {
  const chain = GASLESS_CHAINS[chainId];
  if (!chain) throw new RangeError(`no gasless cancel on chain ${chainId}`);
  if (!ORDER_HASH_RE.test(String(orderHash))) throw new TypeError("an order hash is 32 bytes");
  return `orders/chain/${chain}/protocol/${SEAPORT_16_ADDRESS.toLowerCase()}/${String(orderHash).toLowerCase()}/cancel`;
}

/** Seaport's order hash (the OrderComponents struct hash) of these parameters at this counter. */
export function seaportOrderHash(ethers, params, counter) {
  return ethers.TypedDataEncoder.hashStruct("OrderComponents", {
    OrderComponents: SEAPORT_ORDER_TYPES.OrderComponents,
    OfferItem: SEAPORT_ORDER_TYPES.OfferItem,
    ConsiderationItem: SEAPORT_ORDER_TYPES.ConsiderationItem,
  }, buildOrderComponents(params, counter));
}

/**
 * Cancel a SignedZone order through OpenSea, gas free. Resolves to
 * `{ ok: true, lastSignatureValidUntil }` once OpenSea confirms, or
 * `{ ok: false, reason }` for anything that leaves the order possibly live: the
 * caller then sends the on-chain cancel. A wallet that refuses to sign throws,
 * as every other signing step does, so "the user said no" is never read as
 * "try the on-chain cancel instead".
 *
 * Before anything is signed, the order hash OpenSea reported is recomputed from
 * the order's own parameters and the offerer's live counter. Signing a cancel for
 * a hash that is not this order would cancel something else and leave this one
 * fillable while the page said "Cancelled".
 */
export async function cancelSeaportOrderGasless({ ethers, signer, params, orderHash, chainId, post }) {
  if (!ORDER_HASH_RE.test(String(orderHash))) return { ok: false, reason: "no-order-hash" };
  if (!GASLESS_CHAINS[chainId]) return { ok: false, reason: "chain" };
  const seaport = new ethers.Contract(SEAPORT_16_ADDRESS, SEAPORT_CANCEL_ABI, signer);
  const counter = await seaport.getCounter(params.offerer);
  if (seaportOrderHash(ethers, params, counter).toLowerCase() !== String(orderHash).toLowerCase()) {
    return { ok: false, reason: "hash-mismatch" };
  }
  const typed = gaslessCancelTypedData(orderHash, chainId);
  const signature = await signer.signTypedData(typed.domain, typed.types, typed.message);
  // The proxy admits only a 65-byte signature; anything else goes on chain instead.
  if (!SIGNATURE_RE.test(String(signature))) return { ok: false, reason: "signature-shape" };
  let answer;
  try {
    answer = await post(gaslessCancelPath(chainId, orderHash), { offererSignature: signature });
  } catch (err) {
    return { ok: false, reason: `refused${err?.status ? `-${err.status}` : ""}` };
  }
  const until = answer?.last_signature_issued_valid_until;
  if (typeof until !== "string") return { ok: false, reason: "unconfirmed" };
  return { ok: true, lastSignatureValidUntil: until };
}
