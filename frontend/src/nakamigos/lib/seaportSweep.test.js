// lib/seaportSweep.js packs checked single fills into ONE
// fulfillAvailableAdvancedOrders call, then reads the call back and holds every
// order in it to the listing it came from. The live fixture is a real OpenSea
// answer (2026-10-25); a three-listing version of this pack, with OpenSea's real
// zone signatures, bought all three on a mainnet fork on 2026-11-15.
import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import {
  buildSweepCall, advancedOrderOf, generateFulfillments, filledOrderHashes,
  FULFILL_AVAILABLE_ADVANCED_ORDERS, ORDER_FULFILLED_EVENT,
} from "./seaportSweep";
import { decodeSeaportTrade, shownPriceCeilingWei } from "./seaportTrade";
import { LIVE_BUY, LIVE_BUYER, LIVE_LISTING } from "../__fixtures__/seaportLive";
import { buyFulfillment, SEAPORT_15 } from "../__fixtures__/seaportFulfillment";

const NAKA = "0xd774557b647330c91bf44cfeab205095f7e6c367";
const OS_FEE = "0x0000a26b00c1f0df003000390027140000faa719";

// The same encoding as api.js buildSeaportFulfillCall.
function encodeFill(tx) {
  const toPositional = (val) => {
    if (val === null || val === undefined) return val;
    if (["string", "bigint", "number", "boolean"].includes(typeof val)) return val;
    if (Array.isArray(val)) return val.map(toPositional);
    return Object.values(val).map(toPositional);
  };
  const fnName = String(tx.function).split("(")[0].trim();
  const iface = new ethers.Interface([`function ${tx.function}`]);
  const frag = iface.getFunction(fnName);
  const inputs = frag.inputs.every((p) => p.name && p.name in tx.input_data)
    ? frag.inputs.map((p) => toPositional(tx.input_data[p.name]))
    : Object.values(tx.input_data).map(toPositional);
  return { iface, fnName, data: iface.encodeFunctionData(fnName, inputs) };
}

function fillOf(tx, listing) {
  const { data } = encodeFill(tx);
  return { listing, to: tx.to, value: BigInt(tx.value), data, fn: tx.function };
}

const liveListing = {
  tokenId: "4168", contract: NAKA, priceWei: LIVE_LISTING.price.current.value, orderHash: LIVE_LISTING.order_hash,
};
const liveFill = () => fillOf(LIVE_BUY, liveListing);
const basicListing = (id) => ({ tokenId: id, contract: NAKA, priceWei: "100000000000000000", orderHash: "0x" + id.padStart(64, "0") });
const basicFill = (id, { tx } = {}) => fillOf(tx ?? buyFulfillment(NAKA, { tokenId: id }).fulfillment_data.transaction, basicListing(id));
const ceilings = (fills) => fills.map((f) => shownPriceCeilingWei(f.listing));

const sweepIface = new ethers.Interface([FULFILL_AVAILABLE_ADVANCED_ORDERS]);
const decode = (data) => decodeSeaportTrade(sweepIface, "fulfillAvailableAdvancedOrders", data);

describe("buildSweepCall", () => {
  it("packs a live advanced fill and a basic fill into one call that delivers both to the buyer", () => {
    const fills = [liveFill(), basicFill("7")];
    const call = buildSweepCall(ethers, fills, LIVE_BUYER, ceilings(fills));
    expect(call.error).toBeUndefined();
    expect(call.data.slice(0, 10)).toBe("0x87201b41");
    expect(call.value).toBe(BigInt(LIVE_BUY.value) + 100000000000000000n);
    const trade = decode(call.data);
    expect(trade.recipient).toBe(LIVE_BUYER);
    expect(trade.orders.map((o) => o.offer[0].identifier)).toEqual(["4168", "7"]);
    const args = sweepIface.decodeFunctionData("fulfillAvailableAdvancedOrders", call.data);
    // OpenSea's zone signature rides along untouched; the basic order needs none.
    expect(args[0][0][4]).toBe(LIVE_BUY.input_data.advancedOrder.extraData);
    expect(args[0][1][4]).toBe("0x");
    expect(args[4]).toBe("0x" + "0".repeat(64)); // no buyer conduit: ETH only
    expect(args[6]).toBe(2n); // maximumFulfilled
  });

  it("refuses an order that asks more than its own listing's shown price", () => {
    const fills = [liveFill(), basicFill("7")];
    const low = ceilings(fills);
    low[1] = 50000000000000000n;
    expect(buildSweepCall(ethers, fills, LIVE_BUYER, low).error).toBe("over-price");
  });

  it("refuses a fill for a different collection than the card", () => {
    const fills = [liveFill(), basicFill("7")];
    fills[1].listing = { ...fills[1].listing, contract: "0x" + "9".repeat(40) };
    expect(buildSweepCall(ethers, fills, LIVE_BUYER, ceilings(fills)).error).toBe("nft-mismatch");
  });

  it("refuses the same NFT twice", () => {
    const fills = [basicFill("7"), basicFill("7")];
    expect(buildSweepCall(ethers, fills, LIVE_BUYER, ceilings(fills)).error).toBe("nft-mismatch");
  });

  it("refuses a fill that adds a payment the seller never signed for", () => {
    const tx = buyFulfillment(NAKA, { tokenId: "7" }).fulfillment_data.transaction;
    tx.input_data.parameters.additionalRecipients = [{ amount: "1000", recipient: "0x" + "d".repeat(40) }];
    const fills = [liveFill(), basicFill("7", { tx })];
    expect(buildSweepCall(ethers, fills, LIVE_BUYER, ceilings(fills)).error).toBe("added-payments");
  });

  it("never mixes two Seaport contracts in one call", () => {
    const tx = buyFulfillment(NAKA, { tokenId: "7", to: SEAPORT_15 }).fulfillment_data.transaction;
    const fills = [liveFill(), basicFill("7", { tx })];
    expect(buildSweepCall(ethers, fills, LIVE_BUYER, ceilings(fills)).error).toBe("mixed-seaport");
  });
});

describe("advancedOrderOf", () => {
  it("turns a basic ETH-for-NFT order back into the full order it was signed as", () => {
    const tx = buyFulfillment(NAKA, { tokenId: "7" }).fulfillment_data.transaction;
    tx.input_data.parameters.totalOriginalAdditionalRecipients = "1";
    tx.input_data.parameters.additionalRecipients = [{ amount: "2500000000000000", recipient: OS_FEE }];
    const { iface, fnName, data } = encodeFill(tx);
    const [p, num, den, sig, extra] = advancedOrderOf(iface, fnName, data);
    expect([num, den, sig, extra]).toEqual([1n, 1n, "0x", "0x"]);
    expect(p[0].toLowerCase()).toBe("0x" + "c".repeat(40));
    expect(p[2].map((i) => [Number(i[0]), i[1].toLowerCase(), i[2], i[3], i[4]])).toEqual([[2, NAKA, 7n, 1n, 1n]]);
    expect(p[3].map((c) => [c[3], c[5].toLowerCase()])).toEqual([
      [100000000000000000n, "0x" + "c".repeat(40)],
      [2500000000000000n, OS_FEE],
    ]);
    expect(Number(p[4])).toBe(0); // FULL_OPEN
    expect(p[10]).toBe(2n); // the main payment plus one original recipient
  });

  it("keeps a basic order that sells an NFT for WETH out of a buy", () => {
    const tx = buyFulfillment(NAKA, { tokenId: "7" }).fulfillment_data.transaction;
    tx.input_data.parameters.basicOrderType = 16;
    const { iface, fnName, data } = encodeFill(tx);
    expect(advancedOrderOf(iface, fnName, data)).toBeNull();
  });
});

describe("generateFulfillments", () => {
  it("pays a fee recipient once for every item, and never groups two ERC-721s", () => {
    const order = (offerer, id) => [[offerer, "0x" + "0".repeat(40), [[2, NAKA, BigInt(id), 1n, 1n]],
      [[0, "0x" + "0".repeat(40), 0n, 99n, 99n, offerer], [0, "0x" + "0".repeat(40), 0n, 1n, 1n, OS_FEE]],
      0, 0n, 0n, "0x" + "0".repeat(64), 0n, "0x" + "0".repeat(64), 2n], 1n, 1n, "0x", "0x"];
    const { offerFulfillments, considerationFulfillments } = generateFulfillments([order("0x" + "a".repeat(40), "1"), order("0x" + "b".repeat(40), "2")]);
    expect(offerFulfillments).toEqual([[[0, 0]], [[1, 0]]]);
    expect(considerationFulfillments).toEqual([[[0, 0]], [[0, 1], [1, 1]], [[1, 0]]]);
  });
});

describe("filledOrderHashes", () => {
  it("reads Seaport's own OrderFulfilled events and nobody else's", () => {
    const ev = new ethers.Interface([ORDER_FULFILLED_EVENT]);
    const log = (address, hash) => ({ address, ...ev.encodeEventLog("OrderFulfilled", [hash, "0x" + "c".repeat(40), "0x" + "0".repeat(40), LIVE_BUYER, [], []]) });
    const seaport = LIVE_BUY.to;
    const receipt = { logs: [log(seaport, "0x" + "1".repeat(64)), log("0x" + "e".repeat(40), "0x" + "2".repeat(64))] };
    expect([...filledOrderHashes(ethers, receipt, seaport)]).toEqual(["0x" + "1".repeat(64)]);
  });
});
