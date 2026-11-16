// Builds the one kind of order the house signs: a Seaport 1.6 collection offer, every field
// chosen here, never taken from the bot or from OpenSea beyond the checked NFT line.
//
// Shape (OpenSea's SDK, OrdersManager.createCollectionOffer + seaport-js _formatOrder):
//   offer         [ WETH, unit x qty ]
//   consideration [ the build's NFT line, OpenSea 1%, creator fee (if the policy sets one),
//                   venue fee (if the policy sets one) ]
//   zone SignedZone, zoneHash 0, conduitKey OpenSea's, orderType PARTIAL_RESTRICTED,
//   salt 32 random bytes from the signer, counter read by the signer from Seaport 1.6.
// policy.mjs then re-checks the result independently before it is hashed.

import {
  BPS_DENOMINATOR, ITEM, OPENSEA_CONDUIT_KEY, OPENSEA_FEE_RECIPIENT, SIGNED_ZONE, WETH, ZERO_BYTES32,
} from './constants.mjs';
import { orderTypeForBid } from './policy.mjs';
import { bigintToBytes, bytesToHex, hexToBigint, isBytes32 } from './hex.mjs';

function feeLine(recipient, offerTotal, bps) {
  const amount = (offerTotal * bps) / BPS_DENOMINATOR;
  return { itemType: ITEM.ERC20, token: WETH, identifierOrCriteria: 0n, startAmount: amount, endAmount: amount, recipient };
}

/** OrderComponents (bigints), plus totalOriginalConsiderationItems. */
export function buildBidOrder({ policy, slug, qty, unitPriceWei, startTime, endTime, nftLine, house, salt, counter }) {
  const total = unitPriceWei * BigInt(qty);
  const consideration = [
    { ...nftLine },
    feeLine(OPENSEA_FEE_RECIPIENT, total, policy.openseaFee.bps),
  ];
  const creator = policy.collections[slug].creatorFee;
  if (creator) consideration.push(feeLine(creator.recipient, total, creator.bps));
  if (policy.venueFee) consideration.push(feeLine(policy.venueFee.recipient, total, policy.venueFee.bps));
  return {
    offerer: house,
    zone: SIGNED_ZONE,
    offer: [{ itemType: ITEM.ERC20, token: WETH, identifierOrCriteria: 0n, startAmount: total, endAmount: total }],
    consideration,
    orderType: orderTypeForBid(qty),
    startTime: BigInt(startTime),
    endTime: BigInt(endTime),
    zoneHash: ZERO_BYTES32,
    salt,
    conduitKey: OPENSEA_CONDUIT_KEY,
    counter,
    totalOriginalConsiderationItems: consideration.length,
  };
}

const itemJson = (i) => ({
  itemType: i.itemType,
  token: i.token,
  identifierOrCriteria: i.identifierOrCriteria.toString(),
  startAmount: i.startAmount.toString(),
  endAmount: i.endAmount.toString(),
  ...(i.recipient !== undefined ? { recipient: i.recipient } : {}),
});

/**
 * The order as OpenSea's POST /api/v2/offers body takes it (protocol_data.parameters,
 * SeaportParameters in the OpenAPI spec): amounts and times as decimal strings, itemType
 * and orderType as numbers, the salt as 0x + 64 hex like seaport-js writes it, and the
 * counter included, which that schema requires.
 */
export function toJsonParameters(order) {
  return {
    offerer: order.offerer,
    zone: order.zone,
    offer: order.offer.map(itemJson),
    consideration: order.consideration.map(itemJson),
    orderType: order.orderType,
    startTime: order.startTime.toString(),
    endTime: order.endTime.toString(),
    zoneHash: order.zoneHash,
    salt: bytesToHex(bigintToBytes(order.salt, 32)),
    conduitKey: order.conduitKey,
    totalOriginalConsiderationItems: order.totalOriginalConsiderationItems,
    counter: order.counter.toString(),
  };
}

const itemFromJson = (i, withRecipient) => {
  const out = {
    itemType: i.itemType,
    token: i.token,
    identifierOrCriteria: BigInt(i.identifierOrCriteria),
    startAmount: BigInt(i.startAmount),
    endAmount: BigInt(i.endAmount),
  };
  if (withRecipient) out.recipient = i.recipient;
  return out;
};

/** Back from toJsonParameters (as stored in signer-orders.jsonl) to OrderComponents. */
export function fromJsonParameters(p) {
  if (!isBytes32(p.salt) || !isBytes32(p.zoneHash) || !isBytes32(p.conduitKey)) throw new Error('stored order has malformed hex fields');
  return {
    offerer: p.offerer,
    zone: p.zone,
    offer: p.offer.map((i) => itemFromJson(i, false)),
    consideration: p.consideration.map((i) => itemFromJson(i, true)),
    orderType: p.orderType,
    startTime: BigInt(p.startTime),
    endTime: BigInt(p.endTime),
    zoneHash: p.zoneHash,
    salt: hexToBigint(p.salt),
    conduitKey: p.conduitKey,
    counter: BigInt(p.counter),
    totalOriginalConsiderationItems: p.totalOriginalConsiderationItems,
  };
}
