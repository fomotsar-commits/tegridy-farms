// THE ONE SEAPORT 1.6 BID BUILDER FOR THE SITE.
//
// Every bid the marketplace signs (a collection bid, a trait bid, a bid on one
// NFT, on Ethereum or on Base) is built here, from pinned constants and the
// caller's own numbers. Nothing in a signed bid comes from an API answer except
// the NFT line of a collection or trait bid, and that line is held to the
// collection, the bidder and the quantity by `validateBuildResponse` first.
//
// Why it exists (measured 2026-11-15): every bid button failed. OpenSea answered
// 400 to the collection/trait build (no `protocol_address`), the site then posted
// to `criteria_offers` (404, the route is gone), and single-NFT bids were signed
// for Seaport 1.5 with no zone, a format OpenSea stopped taking in April 2024.
//
// The shapes follow OpenSea's own SDK (opensea-js OrdersManager, read 2026-11-15):
//   - every bid is zone-restricted to OpenSea's SignedZone and allows partial
//     fills (`restrictedByZone: true`, `allowPartialFills: true`), which seaport-js
//     turns into PARTIAL_RESTRICTED (3) for EVERY bid, quantity 1 included;
//   - zoneHash stays zero (the SDK never passes the build's zoneHash on);
//   - the consideration is the NFT line(s), then one WETH line per REQUIRED
//     collection fee, each an exact share of the whole offer.
//
// Plain data in, plain data out: no wallet, no network, no app imports, so a
// Node script (the house bidder's checks, a live probe) can load it as it is.
// lib/seaportOffer.test.js holds every constant here equal to constants.js.

/** Seaport 1.6: the same address on Ethereum and on Base (read on chain 2026-11-07). */
export const SEAPORT_16_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395";
/** Its EIP-712 domain name and version. */
export const SEAPORT_16_NAME = "Seaport";
export const SEAPORT_16_VERSION = "1.6";
/** OpenSea's SignedZone for Seaport 1.6 (opensea-js OPENSEA_SIGNED_ZONE_V2, the same on Base). */
export const OPENSEA_SIGNED_ZONE = "0x000056F7000000EcE9003ca63978907a00FFD100";
/** OpenSea's conduit key; the conduit it names is what a bidder approves WETH to. */
export const OPENSEA_CONDUIT_KEY = "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000";
export const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";
/** The WETH a bid is paid in, by chain id. */
export const BID_WETH_BY_CHAIN = Object.freeze({
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  8453: "0x4200000000000000000000000000000000000006",
});

export const ITEM_TYPE = Object.freeze({
  NATIVE: 0, ERC20: 1, ERC721: 2, ERC1155: 3, ERC721_WITH_CRITERIA: 4, ERC1155_WITH_CRITERIA: 5,
});
export const ORDER_TYPE = Object.freeze({
  FULL_OPEN: 0, PARTIAL_OPEN: 1, FULL_RESTRICTED: 2, PARTIAL_RESTRICTED: 3,
});
export const BID_KINDS = Object.freeze(["collection", "trait", "item"]);

/**
 * THE PRICE TICK, shared by the site, the house signer and the house bot: a unit
 * price in wei is a multiple of 10^13 (0.00001 ETH). Then for any quantity q and
 * any whole-bps fee, offer = unit x q and fee = offer x bps / 10000 are whole
 * numbers that divide by q, which a partial fill needs or it reverts.
 */
export const PRICE_TICK_WEI = 10n ** 13n;

/** Seaport's EIP-712 types, unchanged since 1.1. */
export const SEAPORT_ORDER_TYPES = Object.freeze({
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

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT_RE = /^\d{1,78}$/;
const MAX_UINT256 = (1n << 256n) - 1n;

const lower = (v) => (typeof v === "string" ? v.toLowerCase() : "");

function toBigInt(value, what) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && (UINT_RE.test(value) || /^0x[0-9a-fA-F]{1,64}$/.test(value))) return BigInt(value);
  throw new TypeError(`${what} must be a whole number`);
}

function positiveInt(value, what) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${what} must be a whole number of at least 1`);
  return value;
}

/** True when a unit price sits on the tick. */
export function isOnPriceTick(wei) {
  return toBigInt(wei, "price") % PRICE_TICK_WEI === 0n;
}

/** A unit price rounded DOWN to the tick (never up: a bid never pays more than was asked). */
export function roundUnitPriceDown(wei) {
  const v = toBigInt(wei, "price");
  if (v < 0n) throw new RangeError("price must not be negative");
  return v - (v % PRICE_TICK_WEI);
}

/**
 * The order type of a bid. OpenSea's SDK builds every offer with
 * `restrictedByZone: true` and `allowPartialFills: true` (opensea-js
 * OrdersManager._buildOfferOrder and createCollectionOffer), and seaport-js maps
 * that pair to PARTIAL_RESTRICTED. So the answer is 3 for every kind and every
 * quantity; the arguments are checked so a bad call fails here, not on chain.
 */
export function orderTypeFor(kind, quantity) {
  if (!BID_KINDS.includes(kind)) throw new RangeError(`unknown bid kind: ${kind}`);
  positiveInt(quantity, "quantity");
  if (kind === "item" && quantity !== 1) throw new RangeError("a bid on one NFT is for exactly 1");
  return ORDER_TYPE.PARTIAL_RESTRICTED;
}

const BUILD_REFUSALS = {
  "nft-mismatch": "OpenSea built this bid for something other than this collection, so nothing was funded or signed.",
  "wrong-recipient": "OpenSea built this bid to deliver the NFT to a different wallet than yours, so nothing was funded or signed.",
  "build-mismatch": "OpenSea built this bid with settings this venue does not sign, so nothing was funded or signed.",
};
const refuse = (error, field) => ({ error, field, message: BUILD_REFUSALS[error] });

function amountIs(value, want) {
  try { return toBigInt(value, "amount") === BigInt(want); } catch { return false; }
}

/**
 * OpenSea's `offers/build` answer for a collection or trait bid, held to what
 * the bidder asked for: null when it may be signed, else `{ error, field,
 * message }`. The answer's consideration must be exactly ONE line, the NFT line:
 * a criteria item (itemType 4) on the collection's contract, delivered to the
 * bidder, for exactly the quantity asked. Its zone must be OpenSea's SignedZone
 * and its zoneHash zero. A collection bid's criteria is "0" (any token); a trait
 * bid's criteria is OpenSea's (its "0" means the SignedZone checks the trait at
 * fill time, anything else is a merkle root this page cannot rebuild).
 *
 * The NFT checks run first, so a build for a foreign NFT is always named as one.
 */
export function validateBuildResponse(partial, { collectionContract, offerer, kind, quantity } = {}) {
  if (kind !== "collection" && kind !== "trait") return refuse("build-mismatch", "kind"); // PIN:kind
  if (!partial || typeof partial !== "object" || !Array.isArray(partial.consideration)) return refuse("build-mismatch", "shape"); // PIN:shape
  const nftLines = partial.consideration.filter((c) => Number(c?.itemType) >= ITEM_TYPE.ERC721 && Number(c?.itemType) <= ITEM_TYPE.ERC1155_WITH_CRITERIA);
  if (nftLines.length === 0) return refuse("nft-mismatch", "consideration"); // PIN:no-nft-line
  if (!nftLines.every((c) => lower(c.token) === lower(collectionContract) && ADDRESS_RE.test(String(c.token)))) return refuse("nft-mismatch", "token"); // PIN:token
  if (partial.consideration.length !== 1) return refuse("nft-mismatch", "consideration"); // PIN:one-line
  const line = partial.consideration[0];
  if (Number(line.itemType) !== ITEM_TYPE.ERC721_WITH_CRITERIA) return refuse("nft-mismatch", "itemType"); // PIN:itemType
  if (!ADDRESS_RE.test(String(offerer)) || lower(line.recipient) !== lower(offerer)) return refuse("wrong-recipient", "recipient"); // PIN:recipient
  if (!amountIs(line.startAmount, quantity)) return refuse("build-mismatch", "startAmount"); // PIN:startAmount
  if (!amountIs(line.endAmount, quantity)) return refuse("build-mismatch", "endAmount"); // PIN:endAmount
  if (kind === "collection" && !amountIs(line.identifierOrCriteria, 0)) return refuse("build-mismatch", "criteria"); // PIN:criteria
  if (kind === "trait" && !(UINT_RE.test(String(line.identifierOrCriteria)) && BigInt(line.identifierOrCriteria) <= MAX_UINT256)) return refuse("build-mismatch", "criteria"); // PIN:trait-criteria
  if (lower(partial.zone) !== lower(OPENSEA_SIGNED_ZONE)) return refuse("build-mismatch", "zone"); // PIN:zone
  if (lower(partial.zoneHash) !== lower(ZERO_HASH)) return refuse("build-mismatch", "zoneHash"); // PIN:zoneHash
  // OpenSea's build names no conduit and no order type (measured 2026-11-15), and
  // the bid never takes either from it: buildBidParameters pins both. One that
  // names another conduit, or an open or contract order, is not the build this
  // venue signs against, so it is refused rather than quietly overridden.
  if (partial.conduitKey != null && lower(partial.conduitKey) !== lower(OPENSEA_CONDUIT_KEY)) return refuse("build-mismatch", "conduitKey"); // PIN:conduitKey
  if (partial.orderType != null && ![ORDER_TYPE.FULL_RESTRICTED, ORDER_TYPE.PARTIAL_RESTRICTED].includes(Number(partial.orderType))) return refuse("build-mismatch", "orderType"); // PIN:orderType
  return null;
}

function saltHex(salt) {
  const v = toBigInt(salt, "salt");
  if (v < 0n || v > MAX_UINT256) throw new RangeError("salt must fit in 32 bytes");
  return `0x${v.toString(16).padStart(64, "0")}`;
}

/**
 * The whole OrderParameters of one bid (OrderComponents without the counter,
 * plus totalOriginalConsiderationItems), every amount a decimal string.
 *
 * @param {object} p
 * @param {1|8453} p.chainId
 * @param {string} p.offerer            the bidder
 * @param {"collection"|"trait"|"item"} p.kind
 * @param {string} p.collectionContract
 * @param {string|number} [p.tokenId]   an item bid's token
 * @param {number} p.quantity           NFTs bid for (1 for an item bid)
 * @param {bigint} p.unitPriceWei       price per NFT, on the tick
 * @param {{recipient:string,bps:number}[]} p.feeLines  each paid as bps of the whole offer
 * @param {object} [p.build]            OpenSea's partialParameters (collection/trait)
 * @param {number} p.startTime          unix seconds
 * @param {number} p.endTime            unix seconds
 * @param {bigint|string} p.salt        32 random bytes
 */
export function buildBidParameters({
  chainId, offerer, kind, collectionContract, tokenId, quantity, unitPriceWei, feeLines = [], build, startTime, endTime, salt,
}) {
  const weth = BID_WETH_BY_CHAIN[chainId];
  if (!weth) throw new RangeError(`bids are not signed on chain ${chainId}`);
  if (!ADDRESS_RE.test(String(offerer))) throw new TypeError("offerer must be an address");
  if (!ADDRESS_RE.test(String(collectionContract))) throw new TypeError("collectionContract must be an address");
  const orderType = orderTypeFor(kind, quantity);
  const unit = toBigInt(unitPriceWei, "unitPriceWei");
  if (unit <= 0n) throw new RangeError("the unit price must be above zero");
  if (unit % PRICE_TICK_WEI !== 0n) throw new RangeError("the unit price must sit on the 0.00001 ETH tick");
  if (!Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime) || startTime < 0 || endTime <= startTime) {
    throw new RangeError("the bid must end after it starts");
  }
  const qty = BigInt(quantity);
  const total = unit * qty;

  let nftLine;
  if (kind === "item") {
    const id = String(tokenId ?? "");
    if (!UINT_RE.test(id) || BigInt(id) > MAX_UINT256) throw new TypeError("an item bid names one token id");
    nftLine = {
      itemType: ITEM_TYPE.ERC721, token: collectionContract, identifierOrCriteria: id,
      startAmount: "1", endAmount: "1", recipient: offerer,
    };
  } else {
    // Never sign an NFT line that was not checked, even if a caller forgot to.
    const refusal = validateBuildResponse(build, { collectionContract, offerer, kind, quantity });
    if (refusal) throw Object.assign(new Error(refusal.message), { code: refusal.error, field: refusal.field });
    const from = build.consideration[0];
    nftLine = {
      itemType: ITEM_TYPE.ERC721_WITH_CRITERIA, token: from.token, identifierOrCriteria: String(BigInt(from.identifierOrCriteria)),
      startAmount: String(qty), endAmount: String(qty), recipient: offerer,
    };
  }

  let feeBpsTotal = 0;
  const fees = feeLines.map(({ recipient, bps }) => {
    if (!ADDRESS_RE.test(String(recipient))) throw new TypeError("a fee line pays an address");
    if (!Number.isSafeInteger(bps) || bps < 1 || bps > 10000) throw new RangeError("a fee is a whole number of bps");
    feeBpsTotal += bps;
    const scaled = total * BigInt(bps);
    // Exact by the tick rule; anything else would let a partial fill revert.
    if (scaled % 10000n !== 0n) throw new RangeError("a fee must be an exact share of the offer");
    const amount = scaled / 10000n;
    if (amount % qty !== 0n) throw new RangeError("a fee must divide by the quantity");
    return { itemType: ITEM_TYPE.ERC20, token: weth, identifierOrCriteria: "0", startAmount: String(amount), endAmount: String(amount), recipient };
  });
  if (feeBpsTotal >= 10000) throw new RangeError("fees cannot take the whole offer");

  const consideration = [nftLine, ...fees];
  return {
    offerer,
    zone: OPENSEA_SIGNED_ZONE,
    offer: [{ itemType: ITEM_TYPE.ERC20, token: weth, identifierOrCriteria: "0", startAmount: String(total), endAmount: String(total) }],
    consideration,
    orderType,
    startTime: String(startTime),
    endTime: String(endTime),
    zoneHash: ZERO_HASH,
    salt: saltHex(salt),
    conduitKey: OPENSEA_CONDUIT_KEY,
    totalOriginalConsiderationItems: consideration.length,
  };
}

/**
 * True for an order signed for Seaport 1.6 and restricted to OpenSea's
 * SignedZone: the orders OpenSea can cancel without gas. A Seaport 1.5 order
 * or a zone-less order (most listings) is cancelled on chain.
 */
export function isSeaport16SignedZoneOrder(params, protocolAddress) {
  return lower(protocolAddress) === lower(SEAPORT_16_ADDRESS)
    && lower(params?.zone) === lower(OPENSEA_SIGNED_ZONE);
}

/** Seaport 1.6's EIP-712 domain on this chain. */
export function seaport16Domain(chainId) {
  if (!BID_WETH_BY_CHAIN[chainId]) throw new RangeError(`no Seaport 1.6 domain for chain ${chainId}`);
  return { name: SEAPORT_16_NAME, version: SEAPORT_16_VERSION, chainId: Number(chainId), verifyingContract: SEAPORT_16_ADDRESS };
}

/**
 * What the wallet signs for these parameters: the Seaport 1.6 domain, the
 * OrderComponents types and the components (parameters + the offerer's live
 * counter). Numbers are bigints, which ethers' signTypedData and viem's
 * hashTypedData both take. Fields outside OrderComponents are left out.
 */
export function typedDataFor(parameters, counter, chainId) {
  const item = (i) => ({
    itemType: Number(i.itemType),
    token: i.token,
    identifierOrCriteria: toBigInt(String(i.identifierOrCriteria), "identifierOrCriteria"),
    startAmount: toBigInt(String(i.startAmount), "startAmount"),
    endAmount: toBigInt(String(i.endAmount), "endAmount"),
  });
  if (!BYTES32_RE.test(String(parameters.zoneHash)) || !BYTES32_RE.test(String(parameters.conduitKey))) {
    throw new TypeError("zoneHash and conduitKey are 32 bytes");
  }
  return {
    domain: seaport16Domain(chainId),
    types: {
      OrderComponents: SEAPORT_ORDER_TYPES.OrderComponents,
      OfferItem: SEAPORT_ORDER_TYPES.OfferItem,
      ConsiderationItem: SEAPORT_ORDER_TYPES.ConsiderationItem,
    },
    primaryType: "OrderComponents",
    message: {
      offerer: parameters.offerer,
      zone: parameters.zone,
      offer: parameters.offer.map(item),
      consideration: parameters.consideration.map((c) => ({ ...item(c), recipient: c.recipient })),
      orderType: Number(parameters.orderType),
      startTime: toBigInt(String(parameters.startTime), "startTime"),
      endTime: toBigInt(String(parameters.endTime), "endTime"),
      zoneHash: parameters.zoneHash,
      salt: toBigInt(String(parameters.salt), "salt"),
      conduitKey: parameters.conduitKey,
      counter: toBigInt(typeof counter === "bigint" ? counter : String(counter), "counter"),
    },
  };
}

/**
 * ONE WETH APPROVAL BUDGET FOR ALL OF A WALLET'S LIVE BIDS.
 *
 * `approve` SETS the conduit's allowance, it does not add to it. The old code
 * approved exactly the new bid's price, so a bidder with other live bids cut
 * their allowance to this one bid and every older bid silently stopped being
 * fillable. The allowance a wallet needs is the sum of its live WETH bids plus
 * this one.
 *
 * @param {object} p
 * @param {bigint} p.allowance          the conduit's allowance now
 * @param {bigint[]|null} p.liveOfferTotals  each live bid's WETH total, or null when
 *                                       the open-bid read failed
 * @param {bigint} p.bidTotal           this bid's WETH total
 * @param {bigint} p.cap                the most ever approved in one call
 * @returns {{ approve: bigint|null, needed: bigint, budgeted: boolean }}
 *   `approve` is the amount to approve, or null when the allowance already covers it.
 */
export function wethApprovalTarget({ allowance, liveOfferTotals, bidTotal, cap }) {
  const have = toBigInt(allowance, "allowance");
  const bid = toBigInt(bidTotal, "bidTotal");
  const max = toBigInt(cap, "cap");
  // When the open bids could not be read, the allowance is raised by this bid
  // and never lowered: whatever the older bids rely on stays in place.
  const budgeted = Array.isArray(liveOfferTotals);
  const needed = budgeted
    ? liveOfferTotals.reduce((sum, v) => sum + toBigInt(v, "live offer"), 0n) + bid
    : have + bid;
  const target = needed < max ? needed : max;
  return { approve: have < target ? target : null, needed, budgeted };
}
