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
 * transaction (the caller awaits `.wait()`). Throws on wallet rejection / RPC
 * error (callers already map err.code 4001 → "rejected").
 */
export async function cancelSeaportOrder({ ethers, signer, params, seaportAddress }) {
  // SECURITY: pin the target HERE, at the sink, rather than at each call site —
  // every caller passes a server-supplied `protocol_address` (MyListings,
  // OrderBookPanel), and this is the one place that turns it into a contract the
  // user signs against. Fail closed: an unrecognised target is refused, never
  // silently rewritten to the default.
  const target = resolveSeaportTarget(seaportAddress);
  if (!target) throw new Error('Unexpected transaction target — aborting for safety');
  const seaport = new ethers.Contract(target, SEAPORT_CANCEL_ABI, signer);
  const counter = await seaport.getCounter(params.offerer);
  const components = buildOrderComponents(params, counter);
  return seaport.cancel([components]);
}
