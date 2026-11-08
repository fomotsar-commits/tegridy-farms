// What a Seaport fulfilment call commits the user to, read back from the calldata
// that is about to be signed, and the two checks that hold it to the trade on
// screen. OpenSea builds this calldata, so nothing in it is taken on trust:
//
//   a BUY pays only ETH, no more than the shown price, for the listed token, and
//     the NFT is delivered to the buyer;
//   an ACCEPT sends no ETH, hands over only the one token being sold, and every
//     payment on the seller's side of the trade goes to the seller.
//
// Both also refuse "tips": Seaport lets whoever fills an order append payments the
// order's signer never asked for, paid by the filler. Measured 2026-10-25 against
// live Nakamigos fills: a buy is `fulfillAdvancedOrder` (all-ETH consideration,
// recipient = buyer, no criteria) and a collection-offer accept is
// `matchAdvancedOrders` (the bidder's signed order plus the seller's unsigned
// counter-order offering exactly the one token) — both pass, see seaportTrade.test.js.

const ZERO = "0x0000000000000000000000000000000000000000";
const NATIVE = 0;
const ERC20 = 1;
const ERC721 = 2;
const ERC1155 = 3;
const EXACT_NFT = new Set([ERC721, ERC1155]);
const CRITERIA_NFT = new Set([4, 5]);

const BASIC_ORDER_FUNCTIONS = new Set(["fulfillBasicOrder", "fulfillBasicOrder_efficient_6GL6yc"]);
// Where each entrypoint keeps its orders, criteria resolvers and recipient. An
// absent recipient means Seaport delivers to the caller.
const LAYOUT = {
  fulfillOrder: { kind: "fulfill", many: false },
  fulfillAdvancedOrder: { kind: "fulfill", many: false, resolvers: 1, recipient: 3 },
  fulfillAvailableOrders: { kind: "fulfill", many: true },
  fulfillAvailableAdvancedOrders: { kind: "fulfill", many: true, resolvers: 1, recipient: 5 },
  matchOrders: { kind: "match", many: true },
  matchAdvancedOrders: { kind: "match", many: true, resolvers: 1, recipient: 3 },
};

const lower = (v) => String(v).toLowerCase();

// OfferItem (itemType, token, identifierOrCriteria, startAmount, endAmount) and
// ConsiderationItem (…, recipient). The larger of the two amounts is what an
// ascending or descending order can reach.
function item(raw, withRecipient) {
  const start = BigInt(raw[3]);
  const end = BigInt(raw[4]);
  const out = { itemType: Number(raw[0]), token: lower(raw[1]), identifier: BigInt(raw[2]).toString(), amount: start > end ? start : end };
  if (withRecipient) out.recipient = lower(raw[5]);
  return out;
}

// OrderParameters: (offerer, zone, offer[], consideration[], orderType, startTime,
// endTime, zoneHash, salt, conduitKey, totalOriginalConsiderationItems).
function orderOf(parameters) {
  return {
    offerer: lower(parameters[0]),
    offer: Array.from(parameters[2]).map((i) => item(i, false)),
    consideration: Array.from(parameters[3]).map((i) => item(i, true)),
    totalOriginal: Number(parameters[10]),
  };
}

// BasicOrderParameters, as the order it stands for. Route = basicOrderType / 4:
// 0-1 pay ETH for an NFT, 2-3 pay an ERC-20 for an NFT, 4-5 hand an NFT over for
// an ERC-20. additionalRecipients are paid in the payment token, by the filler.
function basicOrderOf(p) {
  const route = Math.floor(Number(p[8]) / 4);
  const offerer = lower(p[3]);
  const tips = Array.from(p[16]);
  const totalOriginal = 1 + Number(p[15]);
  if (route >= 0 && route <= 3) {
    const payType = route <= 1 ? NATIVE : ERC20;
    const payToken = route <= 1 ? ZERO : lower(p[0]);
    const pay = (amount, recipient) => ({ itemType: payType, token: payToken, identifier: "0", amount: BigInt(amount), recipient: lower(recipient) });
    return {
      offerer,
      offer: [{ itemType: route % 2 === 0 ? ERC721 : ERC1155, token: lower(p[5]), identifier: BigInt(p[6]).toString(), amount: BigInt(p[7]) }],
      consideration: [pay(p[2], offerer), ...tips.map((t) => pay(t[0], t[1]))],
      totalOriginal,
    };
  }
  if (route === 4 || route === 5) {
    const erc20 = lower(p[5]);
    return {
      offerer,
      offer: [{ itemType: ERC20, token: erc20, identifier: "0", amount: BigInt(p[7]) }],
      consideration: [
        { itemType: route === 4 ? ERC721 : ERC1155, token: lower(p[0]), identifier: BigInt(p[1]).toString(), amount: BigInt(p[2]), recipient: offerer },
        ...tips.map((t) => ({ itemType: ERC20, token: erc20, identifier: "0", amount: BigInt(t[0]), recipient: lower(t[1]) })),
      ],
      totalOriginal,
    };
  }
  throw new Error("unknown basic order route");
}

/**
 * @param {import("ethers").Interface} iface  built from the response's own signature
 * @param {string} fnName                      the allowlisted function name
 * @param {string} data                        the encoded calldata
 * @returns {{ kind: "basic"|"fulfill"|"match", orders: object[], recipient: string|null,
 *            resolvers: { orderIndex: number, side: number, index: number, identifier: string }[] } | null}
 *          null when the call cannot be read, which both checks treat as a refusal
 */
export function decodeSeaportTrade(iface, fnName, data) {
  try {
    const args = iface.decodeFunctionData(fnName, data);
    if (BASIC_ORDER_FUNCTIONS.has(fnName)) {
      return { kind: "basic", orders: [basicOrderOf(args[0])], recipient: null, resolvers: [] };
    }
    const layout = LAYOUT[fnName];
    if (!layout) return null;
    // Order = (parameters, signature); AdvancedOrder = (parameters, numerator,
    // denominator, signature, extraData). Parameters lead in both.
    const raw = layout.many ? Array.from(args[0]) : [args[0]];
    const resolvers = layout.resolvers == null
      ? []
      : Array.from(args[layout.resolvers]).map((r) => ({
        orderIndex: Number(r[0]),
        side: Number(r[1]),
        index: Number(r[2]),
        identifier: BigInt(r[3]).toString(),
      }));
    return {
      kind: layout.kind,
      orders: raw.map((o) => orderOf(o[0])),
      recipient: layout.recipient == null ? null : lower(args[layout.recipient]),
      resolvers,
    };
  } catch {
    return null;
  }
}

const refuse = (error, message) => ({ error, message: `${message} Nothing was sent.` });

function recipientRefusal(trade, me) {
  if (trade.recipient && trade.recipient !== ZERO && trade.recipient !== me) {
    return refuse("wrong-recipient", "The fill would deliver to a different wallet than yours.");
  }
  return null;
}

/**
 * The most ETH a buy may send: the exact listing price when the card carries it,
 * else the shown price plus the rounding the display drops (it floors to 4 dp).
 * @returns {bigint|null}
 */
export function shownPriceCeilingWei(listing) {
  if (typeof listing?.priceWei === "string" && /^\d+$/.test(listing.priceWei)) return BigInt(listing.priceWei);
  const price = Number(listing?.price);
  if (!Number.isFinite(price) || price < 0) return null;
  // 0.0911 * 10_000 is 910.999…; the 1e-6 keeps float noise from losing a step.
  return (BigInt(Math.floor(price * 10_000 + 1e-6)) + 1n) * 100_000_000_000_000n - 1n;
}

/**
 * @param trade      decodeSeaportTrade output
 * @param buyer      the wallet that signs and pays
 * @param tokenId    the token the card is for
 * @param txValue    the ETH the call sends (bigint)
 * @param maxValue   shownPriceCeilingWei(listing)
 * @returns {{error:string,message:string}|null}
 */
export function buyTradeRefusal(trade, { buyer, tokenId, txValue, maxValue }) {
  if (!trade) return refuse("unreadable-fill", "The fill could not be read back to check it.");
  const me = lower(buyer);
  const wrongRecipient = recipientRefusal(trade, me);
  if (wrongRecipient) return wrongRecipient;
  // A listing names its token; a criteria pick has no place in a buy.
  if (trade.resolvers.length) return refuse("unexpected-criteria", "The fill picks a token by criteria, which a listing never does.");
  for (const o of trade.orders) {
    // An order the buyer "offers" needs no signature from them, so it could spend
    // anything their wallet has approved to Seaport. A buy has none.
    if (o.offerer === me) return refuse("own-order", "The fill includes an order from your own wallet.");
    if (o.consideration.length !== o.totalOriginal) return refuse("added-payments", "The fill adds payments the seller never asked for.");
    if (o.consideration.some((c) => c.itemType !== NATIVE)) return refuse("not-eth", "This listing is not paid in ETH.");
    for (const it of o.offer) {
      if (CRITERIA_NFT.has(it.itemType)) return refuse("unexpected-criteria", "The fill offers an NFT by criteria, which a listing never does.");
      if (EXACT_NFT.has(it.itemType) && it.identifier !== String(tokenId)) {
        return refuse("nft-mismatch", "The fill would deliver a different token than the one listed.");
      }
    }
  }
  if (maxValue == null) return refuse("no-price", "There is no shown price to check the fill against.");
  if (txValue > maxValue) return refuse("over-price", "The fill asks for more ETH than the price shown.");
  return null;
}

/**
 * @param trade        decodeSeaportTrade output
 * @param seller       the wallet that signs and hands the NFT over
 * @param nftContract  the offer's NFT contract
 * @param tokenId      the token being sold (null when the offer did not say)
 * @param txValue      the ETH the call sends (bigint)
 * @returns {{error:string,message:string}|null}
 */
export function acceptTradeRefusal(trade, { seller, nftContract, tokenId, txValue }) {
  if (!trade) return refuse("unreadable-fill", "The fill could not be read back to check it.");
  if (txValue !== 0n) return refuse("sends-eth", "Accepting an offer never costs ETH, and this fill asks for some.");
  const me = lower(seller);
  const nft = lower(nftContract);
  const id = tokenId == null ? null : String(tokenId);
  const wrongRecipient = recipientRefusal(trade, me);
  if (wrongRecipient) return wrongRecipient;

  const offered = new Map();
  const owed = new Map();
  const add = (map, token, amount) => map.set(token, (map.get(token) ?? 0n) + amount);
  for (const o of trade.orders) {
    if (o.offerer === me) {
      // The seller's own, unsigned counter-order (how OpenSea fills a criteria
      // bid). It may offer exactly the token being sold, and nothing else, and
      // everything it asks for must come back to the seller.
      if (trade.kind !== "match") return refuse("own-order", "The fill includes an order from your own wallet.");
      if (id == null) return refuse("no-token", "The fill hands over a token this offer never named.");
      const onlyTheToken = o.offer.length > 0 && o.offer.every((it) =>
        EXACT_NFT.has(it.itemType) && it.token === nft && it.identifier === id && it.amount === 1n);
      if (!onlyTheToken) return refuse("hands-over-more", "The fill would hand over more than this one NFT.");
      if (o.consideration.some((c) => c.recipient !== me)) {
        return refuse("pays-others", "The fill would pay someone else from your side of the trade.");
      }
      continue;
    }
    if (o.consideration.length !== o.totalOriginal) return refuse("added-payments", "The fill adds payments the bidder never asked for.");
    for (const it of o.offer) if (it.itemType === ERC20) add(offered, it.token, it.amount);
    for (const c of o.consideration) {
      if (EXACT_NFT.has(c.itemType) || CRITERIA_NFT.has(c.itemType)) {
        if (c.token !== nft) return refuse("nft-mismatch", "The fill asks for an NFT from a different collection.");
        if (EXACT_NFT.has(c.itemType) && id != null && c.identifier !== id) {
          return refuse("nft-mismatch", "The fill asks for a different token than the one being sold.");
        }
      } else if (c.itemType === ERC20) {
        add(owed, c.token, c.amount);
      } else {
        return refuse("pays-eth", "The fill would make you pay ETH to accept an offer.");
      }
    }
  }
  // Fees on a bid come out of the bid. More than it offers would be paid by the seller.
  for (const [token, amount] of owed) {
    if (amount > (offered.get(token) ?? 0n)) return refuse("fees-exceed-offer", "The fill's fees are larger than the offer itself.");
  }
  for (const r of trade.resolvers) {
    const o = trade.orders[r.orderIndex];
    const it = o && r.side === 1 ? o.consideration[r.index] : null;
    if (!it || !CRITERIA_NFT.has(it.itemType) || it.token !== nft || id == null || r.identifier !== id) {
      return refuse("nft-mismatch", "The fill would hand over a different token than the one being sold.");
    }
  }
  return null;
}
