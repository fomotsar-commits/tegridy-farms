// A whole cart of listings in ONE Seaport transaction, on any wallet.
//
// Seaport's `fulfillAvailableAdvancedOrders` takes many signed orders at once.
// Any order that is no longer available when the transaction lands (sold,
// cancelled, expired) is skipped and its ETH stays with the buyer, so one sniped
// item no longer sinks the cart. This is how OpenSea's own seaport-js
// (`fulfillOrders`) buys several listings.
//
// Each listing's order still comes from OpenSea's fulfillment_data, one listing
// at a time, because OpenSea's zone signs every fill for the wallet that will
// send it (`extraData`). Each of those single fills has already passed every
// check in api.js buildSeaportFulfillCall before it reaches here. This file only
// re-packs those checked orders into one call, and then reads that call back and
// checks it again as a whole: what is signed is what is checked.

import { decodeSeaportTrade, buyTradeRefusal } from "./seaportTrade";

const ZERO32 = "0x" + "0".repeat(64);
const ERC721 = 2;

// Seaport 1.5 and 1.6 share this signature (seaport-types ConsiderationInterface).
export const FULFILL_AVAILABLE_ADVANCED_ORDERS =
  "function fulfillAvailableAdvancedOrders(((address offerer, address zone, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 totalOriginalConsiderationItems) parameters, uint120 numerator, uint120 denominator, bytes signature, bytes extraData)[] advancedOrders, (uint256 orderIndex, uint8 side, uint256 index, uint256 identifier, bytes32[] criteriaProof)[] criteriaResolvers, (uint256 orderIndex, uint256 itemIndex)[][] offerFulfillments, (uint256 orderIndex, uint256 itemIndex)[][] considerationFulfillments, bytes32 fulfillerConduitKey, address recipient, uint256 maximumFulfilled) payable returns (bool[] availableOrders, ((uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient) item, address offerer, bytes32 conduitKey)[] executions)";

export const ORDER_FULFILLED_EVENT =
  "event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)";

// An ethers Result, deep-copied to plain arrays so it can be encoded again.
function plain(v) {
  if (v && typeof v === "object" && typeof v !== "string" && typeof v.length === "number") {
    return Array.from(v, plain);
  }
  return v;
}

const BASIC_ORDER_FUNCTIONS = new Set(["fulfillBasicOrder", "fulfillBasicOrder_efficient_6GL6yc"]);

// A basic ETH-for-NFT order (routes 0 and 1) as the full order it was signed as.
// This is the mapping Seaport itself makes when it hashes a basic order
// (BasicOrderFulfiller._prepareBasicFulfillmentFromCalldata): one NFT offered,
// the main payment to the offerer, then each additional recipient, all in the
// consideration token, start = end. BasicOrderParameters fields: 0 considerationToken,
// 1 considerationIdentifier, 2 considerationAmount, 3 offerer, 4 zone, 5 offerToken,
// 6 offerIdentifier, 7 offerAmount, 8 basicOrderType, 9 startTime, 10 endTime,
// 11 zoneHash, 12 salt, 13 offererConduitKey, 14 fulfillerConduitKey,
// 15 totalOriginalAdditionalRecipients, 16 additionalRecipients, 17 signature.
function advancedFromBasic(p) {
  const type = Number(p[8]);
  const route = Math.floor(type / 4);
  if (route !== 0 && route !== 1) return null; // only a buy paid in ETH
  const payment = (amount, recipient) => [0, p[0], p[1], amount, amount, recipient];
  const parameters = [
    p[3], // offerer
    p[4], // zone
    [[route === 0 ? 2 : 3, p[5], p[6], p[7], p[7]]],
    [payment(p[2], p[3]), ...Array.from(p[16], (r) => payment(r[0], r[1]))],
    type % 4, // orderType
    p[9], p[10], p[11], p[12], p[13],
    BigInt(p[15]) + 1n,
  ];
  return [parameters, 1n, 1n, p[17], "0x"];
}

/**
 * The AdvancedOrder a checked single-listing fill carries, as a plain positional
 * array (parameters, numerator, denominator, signature, extraData), or null when
 * the fill cannot join a batch (anything but a whole ETH buy).
 */
export function advancedOrderOf(iface, fnName, data) {
  try {
    const args = iface.decodeFunctionData(fnName, data);
    let order;
    if (BASIC_ORDER_FUNCTIONS.has(fnName)) {
      order = advancedFromBasic(plain(args[0]));
    } else if (fnName === "fulfillAdvancedOrder") {
      order = plain(args[0]);
      // A listing is bought whole; a fraction has no place in a cart.
      if (BigInt(order[1]) !== 1n || BigInt(order[2]) !== 1n) return null;
    } else if (fnName === "fulfillOrder") {
      const o = plain(args[0]);
      order = [o[0], 1n, 1n, o[1], "0x"];
    } else {
      return null;
    }
    return order;
  } catch {
    return null;
  }
}

/**
 * Which order items Seaport moves together. Copied from seaport-js
 * `generateFulfillOrdersFulfillments`: offer items group by offerer, conduit,
 * token and id (an ERC-721 never groups); payments group by who is paid, in what,
 * so every fee to the same address is one transfer instead of one per item.
 *
 * @param {Array} orders plain AdvancedOrders
 */
export function generateFulfillments(orders) {
  const offer = new Map();
  const consideration = new Map();
  const push = (map, key, component) => map.set(key, [...(map.get(key) ?? []), component]);
  orders.forEach((order, orderIndex) => {
    const [offerer, , offerItems, , , , , , , conduitKey] = order[0];
    offerItems.forEach((item, itemIndex) => {
      const key = `${String(offerer).toLowerCase()}-${conduitKey}-${String(item[1]).toLowerCase()}-${BigInt(item[2])}`
        + (Number(item[0]) === ERC721 ? `-${itemIndex}` : "");
      push(offer, key, [orderIndex, itemIndex]);
    });
  });
  orders.forEach((order, orderIndex) => {
    order[0][3].forEach((item, itemIndex) => {
      const key = `${String(item[5]).toLowerCase()}-${String(item[1]).toLowerCase()}-${BigInt(item[2])}`;
      push(consideration, key, [orderIndex, itemIndex]);
    });
  });
  return { offerFulfillments: [...offer.values()], considerationFulfillments: [...consideration.values()] };
}

/**
 * The checks buyTradeRefusal makes on one listing, made on every order of the
 * one call, against the listing it came from, plus the whole call's ETH.
 *
 * @param trade     decodeSeaportTrade of the encoded batch
 * @param buyer     the wallet that signs and pays
 * @param listings  the cart, in the order of the call's orders
 * @param ceilings  shownPriceCeilingWei of each listing (bigint), same order
 * @param txValue   the ETH the call sends (bigint)
 */
export function sweepTradeRefusal(trade, { buyer, listings, ceilings, txValue }) {
  const refuse = (error, message) => ({ error, message: `${message} Nothing was sent.` });
  if (!trade || trade.kind !== "fulfill") return refuse("unreadable-fill", "The purchase could not be read back to check it.");
  if (trade.orders.length !== listings.length) return refuse("unreadable-fill", "The purchase does not hold one order per item.");
  // A cart delivers to the buyer by name, never "whoever sends it".
  if (trade.recipient !== String(buyer).toLowerCase()) {
    return refuse("wrong-recipient", "The purchase would deliver to a different wallet than yours.");
  }
  const seen = new Set();
  let ceilingTotal = 0n;
  for (let i = 0; i < listings.length; i++) {
    const o = trade.orders[i];
    const ceiling = ceilings[i];
    if (ceiling == null) return refuse("no-price", "An item has no shown price to check against.");
    const paid = o.consideration.reduce((sum, c) => sum + c.amount, 0n);
    const one = buyTradeRefusal(
      { kind: trade.kind, orders: [o], recipient: trade.recipient, resolvers: trade.resolvers },
      { buyer, tokenId: listings[i].tokenId ?? listings[i].id, txValue: paid, maxValue: ceiling },
    );
    if (one) return one;
    // buyTradeRefusal holds the ids; the cart also holds the collection, one NFT per order.
    const nfts = o.offer.filter((it) => it.itemType === 2 || it.itemType === 3);
    const contract = String(listings[i].contract ?? listings[i].orderData?.parameters?.offer?.[0]?.token ?? "").toLowerCase();
    if (nfts.length !== 1 || o.offer.length !== 1 || nfts[0].amount !== 1n || (contract && nfts[0].token !== contract)) {
      return refuse("nft-mismatch", "The purchase would deliver something other than the listed NFT.");
    }
    const key = `${nfts[0].token}-${nfts[0].identifier}`;
    if (seen.has(key)) return refuse("nft-mismatch", "The purchase names the same NFT twice.");
    seen.add(key);
    ceilingTotal += ceiling;
  }
  if (txValue > ceilingTotal) return refuse("over-price", "The purchase asks for more ETH than the prices shown.");
  return null;
}

/**
 * One fulfillAvailableAdvancedOrders call for checked single fills that all go
 * to the same Seaport.
 *
 * @param ethers
 * @param fills   [{ listing, to, value (bigint), data, fn (the fill's function signature) }]
 * @param buyer   the paying wallet (from the signer)
 * @param ceilings shownPriceCeilingWei of each fill's listing, same order
 * @returns {{ to, value, data } | { error, message }}
 */
export function buildSweepCall(ethers, fills, buyer, ceilings) {
  if (fills.length < 2) return { error: "too-few", message: "A batch needs two or more items." };
  const to = fills[0].to;
  if (fills.some((f) => String(f.to).toLowerCase() !== String(to).toLowerCase())) {
    return { error: "mixed-seaport", message: "These items settle on different Seaport contracts." };
  }
  const orders = [];
  for (const f of fills) {
    const name = String(f.fn).split("(")[0].trim();
    const order = advancedOrderOf(new ethers.Interface([`function ${f.fn}`]), name, f.data);
    if (!order) return { error: "not-batchable", message: "An item's fill cannot join a batch." };
    orders.push(order);
  }
  const { offerFulfillments, considerationFulfillments } = generateFulfillments(orders);
  const iface = new ethers.Interface([FULFILL_AVAILABLE_ADVANCED_ORDERS]);
  const value = fills.reduce((sum, f) => sum + f.value, 0n);
  // No conduit for the buyer: a buy pays only ETH, which never passes through one.
  const data = iface.encodeFunctionData("fulfillAvailableAdvancedOrders", [
    orders, [], offerFulfillments, considerationFulfillments, ZERO32, buyer, orders.length,
  ]);
  const refusal = sweepTradeRefusal(
    decodeSeaportTrade(iface, "fulfillAvailableAdvancedOrders", data),
    { buyer, listings: fills.map((f) => f.listing), ceilings, txValue: value },
  );
  if (refusal) return refusal;
  return { to, value, data };
}

/**
 * The order hashes a mined transaction filled, read from Seaport's own
 * OrderFulfilled events on `seaport`. An item whose hash is missing was skipped.
 */
export function filledOrderHashes(ethers, receipt, seaport) {
  const iface = new ethers.Interface([ORDER_FULFILLED_EVENT]);
  const topic = iface.getEvent("OrderFulfilled").topicHash;
  const out = new Set();
  for (const log of receipt?.logs ?? []) {
    if (String(log.address).toLowerCase() !== String(seaport).toLowerCase()) continue;
    if (log.topics?.[0] !== topic) continue;
    try {
      out.add(String(iface.parseLog(log).args.orderHash).toLowerCase());
    } catch {
      // not ours to read
    }
  }
  return out;
}
