import { describe, it, expect } from "vitest";
import { Interface } from "ethers";
import { acceptTradeRefusal, buyTradeRefusal, decodeSeaportTrade, shownPriceCeilingWei } from "./seaportTrade";
import { isEthListing } from "../api";
import { LIVE_ACCEPT, LIVE_BUY, LIVE_BUYER, LIVE_LISTING, LIVE_SELLER, LIVE_TOKEN_SOLD } from "../__fixtures__/seaportLive";
import { acceptFulfillment, buyFulfillment } from "../__fixtures__/seaportFulfillment";

// SECURITY REGRESSION — what a Seaport fill commits the user to.
//
// OpenSea builds the calldata a buyer or seller signs. Before these checks the
// only things pinned were the target (Seaport), the function name, and which NFT
// CONTRACT moves. A tampered answer could still, with a valid-looking call:
//   - deliver the bought NFT to another wallet,
//   - make the buyer pay in an ERC-20 they approved to OpenSea, or more than shown,
//   - make the seller hand over every token they approved, or pay a third party,
//   - append "tips" the order's signer never asked for, paid by whoever fills it.
//
// Each case below starts from a REAL fill captured from OpenSea and changes one
// field, so a pass on the live shape and a refusal on the tampered one are both
// pinned. The live shapes passing is half the point: a guard that refuses real
// fills breaks the marketplace.

const NAKAMIGOS = "0xd774557b647330c91bf44cfeab205095f7e6c367";
const ATTACKER = "0x00000000000000000000000000000000deadbeef";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

// The same encoding api.js and api-offers.js perform on an OpenSea answer.
function toPositional(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === "string" || typeof val === "bigint" || typeof val === "number" || typeof val === "boolean") return val;
  if (Array.isArray(val)) return val.map(toPositional);
  if (typeof val === "object") return Object.values(val).map(toPositional);
  return val;
}
function decode(tx) {
  const fnName = String(tx.function).split("(")[0];
  const iface = new Interface([`function ${tx.function}`]);
  const frag = iface.getFunction(fnName);
  const values = frag.inputs.every((p) => p.name && p.name in tx.input_data)
    ? frag.inputs.map((p) => toPositional(tx.input_data[p.name]))
    : Object.values(tx.input_data).map(toPositional);
  return decodeSeaportTrade(iface, fnName, iface.encodeFunctionData(fnName, values));
}
const clone = (o) => JSON.parse(JSON.stringify(o));

const PRICE = BigInt(LIVE_LISTING.price.current.value);
const LISTED_TOKEN = LIVE_LISTING.protocol_data.parameters.offer[0].identifierOrCriteria;
const buyArgs = (over = {}) => ({ buyer: LIVE_BUYER, tokenId: LISTED_TOKEN, txValue: BigInt(LIVE_BUY.value), maxValue: PRICE, ...over });
const acceptArgs = (over = {}) => ({ seller: LIVE_SELLER, nftContract: NAKAMIGOS, tokenId: LIVE_TOKEN_SOLD, txValue: 0n, ...over });

describe("the live fills pass", () => {
  it("a real listing buy (fulfillAdvancedOrder) passes", () => {
    expect(buyTradeRefusal(decode(LIVE_BUY), buyArgs())).toBeNull();
  });

  it("a real listing buy passes against the rounded price a card shows", () => {
    // 0.0910999… ETH is shown as 0.091; the ceiling must still cover the exact price.
    const shown = Number(PRICE * 10_000n / 10n ** 18n) / 10_000;
    expect(buyTradeRefusal(decode(LIVE_BUY), buyArgs({ maxValue: shownPriceCeilingWei({ price: shown }) }))).toBeNull();
  });

  it("a real collection-offer accept (matchAdvancedOrders) passes", () => {
    expect(acceptTradeRefusal(decode(LIVE_ACCEPT), acceptArgs())).toBeNull();
  });

  it("the basic-order shapes pass too", () => {
    const buy = buyFulfillment(NAKAMIGOS, { tokenId: "7" }).fulfillment_data.transaction;
    expect(buyTradeRefusal(decode(buy), { buyer: LIVE_BUYER, tokenId: "7", txValue: BigInt(buy.value), maxValue: BigInt(buy.value) })).toBeNull();
    const acc = acceptFulfillment(NAKAMIGOS, { tokenId: "7" }).fulfillment_data.transaction;
    expect(acceptTradeRefusal(decode(acc), acceptArgs({ tokenId: "7" }))).toBeNull();
    // An exact-token bid names its own token, so it still fills when the card did not say.
    expect(acceptTradeRefusal(decode(acc), acceptArgs({ tokenId: null }))).toBeNull();
  });
});

describe("a tampered buy is refused", () => {
  const order = (tx) => tx.input_data.advancedOrder.parameters;

  it("delivering the NFT to another wallet", () => {
    const tx = clone(LIVE_BUY);
    tx.input_data.recipient = ATTACKER;
    expect(buyTradeRefusal(decode(tx), buyArgs())?.error).toBe("wrong-recipient");
  });

  it("charging an ERC-20 the buyer approved to OpenSea", () => {
    const tx = clone(LIVE_BUY);
    Object.assign(order(tx).consideration[1], { itemType: 1, token: USDC });
    expect(buyTradeRefusal(decode(tx), buyArgs())?.error).toBe("not-eth");
  });

  it("an ERC-20-priced basic listing (route ERC20_TO_ERC721)", () => {
    const tx = buyFulfillment(NAKAMIGOS, { tokenId: "7" }).fulfillment_data.transaction;
    Object.assign(tx.input_data.parameters, { basicOrderType: 8, considerationToken: USDC });
    expect(buyTradeRefusal(decode(tx), { buyer: LIVE_BUYER, tokenId: "7", txValue: 0n, maxValue: 1n })?.error).toBe("not-eth");
  });

  it("a tip the seller never asked for", () => {
    const tx = clone(LIVE_BUY);
    order(tx).consideration.push({ ...order(tx).consideration[1], recipient: ATTACKER });
    expect(buyTradeRefusal(decode(tx), buyArgs())?.error).toBe("added-payments");
  });

  it("a different token than the one listed", () => {
    const tx = clone(LIVE_BUY);
    order(tx).offer[0].identifierOrCriteria = String(BigInt(LISTED_TOKEN) + 1n);
    expect(buyTradeRefusal(decode(tx), buyArgs())?.error).toBe("nft-mismatch");
  });

  it("more ETH than the price shown", () => {
    expect(buyTradeRefusal(decode(LIVE_BUY), buyArgs({ txValue: PRICE + 1n }))?.error).toBe("over-price");
  });

  it("no shown price to hold it to", () => {
    expect(buyTradeRefusal(decode(LIVE_BUY), buyArgs({ maxValue: null }))?.error).toBe("no-price");
  });

  it("an order from the buyer's own wallet, which needs no signature", () => {
    const tx = clone(LIVE_BUY);
    order(tx).offerer = LIVE_BUYER;
    expect(buyTradeRefusal(decode(tx), buyArgs())?.error).toBe("own-order");
  });

  it("a criteria pick on a listing", () => {
    const tx = clone(LIVE_BUY);
    tx.input_data.criteriaResolvers = [{ orderIndex: "0", side: 0, index: "0", identifier: LISTED_TOKEN, criteriaProof: [] }];
    expect(buyTradeRefusal(decode(tx), buyArgs())?.error).toBe("unexpected-criteria");
  });

  it("calldata that cannot be read back", () => {
    expect(buyTradeRefusal(null, buyArgs())?.error).toBe("unreadable-fill");
  });
});

describe("a tampered accept is refused", () => {
  const bidder = (tx) => tx.input_data.orders[0].parameters;
  const mine = (tx) => tx.input_data.orders[1].parameters;

  it("asking the seller to send ETH", () => {
    expect(acceptTradeRefusal(decode(LIVE_ACCEPT), acceptArgs({ txValue: 1n }))?.error).toBe("sends-eth");
  });

  it("the seller's counter-order handing over a second token", () => {
    const tx = clone(LIVE_ACCEPT);
    mine(tx).offer.push({ ...mine(tx).offer[0], identifierOrCriteria: "2" });
    expect(acceptTradeRefusal(decode(tx), acceptArgs())?.error).toBe("hands-over-more");
  });

  it("the seller's counter-order handing over approved WETH", () => {
    const tx = clone(LIVE_ACCEPT);
    mine(tx).offer.push({ itemType: 1, token: bidder(tx).offer[0].token, identifierOrCriteria: "0", startAmount: "1000", endAmount: "1000" });
    expect(acceptTradeRefusal(decode(tx), acceptArgs())?.error).toBe("hands-over-more");
  });

  it("the seller's counter-order handing over a different token", () => {
    const tx = clone(LIVE_ACCEPT);
    mine(tx).offer[0].identifierOrCriteria = "2";
    expect(acceptTradeRefusal(decode(tx), acceptArgs())?.error).toBe("hands-over-more");
  });

  it("the seller's proceeds paid to someone else", () => {
    const tx = clone(LIVE_ACCEPT);
    mine(tx).consideration[0].recipient = ATTACKER;
    expect(acceptTradeRefusal(decode(tx), acceptArgs())?.error).toBe("pays-others");
  });

  it("a criteria pick of a different token", () => {
    const tx = clone(LIVE_ACCEPT);
    tx.input_data.criteriaResolvers[0].identifier = "2";
    expect(acceptTradeRefusal(decode(tx), acceptArgs())?.error).toBe("nft-mismatch");
  });

  it("leftovers delivered to another wallet", () => {
    const tx = clone(LIVE_ACCEPT);
    tx.input_data.recipient = ATTACKER;
    expect(acceptTradeRefusal(decode(tx), acceptArgs())?.error).toBe("wrong-recipient");
  });

  it("a tip on the bidder's order, which the seller would pay", () => {
    const tx = clone(LIVE_ACCEPT);
    bidder(tx).consideration.push({ ...bidder(tx).consideration[1], recipient: ATTACKER });
    expect(acceptTradeRefusal(decode(tx), acceptArgs())?.error).toBe("added-payments");
  });

  it("fees larger than the bid itself", () => {
    const tx = clone(LIVE_ACCEPT);
    const fee = bidder(tx).consideration[1];
    fee.startAmount = fee.endAmount = String(BigInt(bidder(tx).offer[0].startAmount) + 1n);
    expect(acceptTradeRefusal(decode(tx), acceptArgs())?.error).toBe("fees-exceed-offer");
  });

  it("an exact-token bid for a different token than the one being sold", () => {
    const acc = acceptFulfillment(NAKAMIGOS, { tokenId: "7" }).fulfillment_data.transaction;
    expect(acceptTradeRefusal(decode(acc), acceptArgs({ tokenId: "8" }))?.error).toBe("nft-mismatch");
  });

  it("a counter-order when the card never said which token is sold", () => {
    expect(acceptTradeRefusal(decode(LIVE_ACCEPT), acceptArgs({ tokenId: null }))?.error).toBe("no-token");
  });
});

describe("only ETH listings are shown", () => {
  it("keeps the live ETH listing", () => {
    expect(isEthListing(LIVE_LISTING)).toBe(true);
  });

  it("drops a USDC listing, which would read as about 0 ETH", () => {
    const usdc = clone(LIVE_LISTING);
    usdc.price.current = { currency: "USDC", decimals: 6, value: "5000000000" };
    expect(isEthListing(usdc)).toBe(false);
  });

  it("drops a listing whose signed order asks for an ERC-20, whatever its label says", () => {
    const sneaky = clone(LIVE_LISTING);
    Object.assign(sneaky.protocol_data.parameters.consideration[0], { itemType: 1, token: USDC });
    expect(isEthListing(sneaky)).toBe(false);
  });
});
