import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { deriveTraitOffers } from "./api-offers";
import { SEAPORT_FULFILLMENT_FUNCTIONS } from "./api";
import { NFT_LOAN_DESK_LIVE, SEAPORT_ORDER_TYPES } from "./constants";
import { buildOrderComponents } from "./lib/seaportCancel";
import { TEGRIDY_NFT_LENDING_ADDRESS, isDeployed } from "../lib/constants";

// Normalized shape produced by fetchCollectionOffers: price is ETH (number),
// criteria is passed through verbatim from OpenSea's /offers/collection/{slug}/all.
const traitOffer = (type, value, priceEth) => ({
  price: priceEth,
  currency: "WETH",
  maker: "0xabc",
  orderHash: `0x${type}${value}${priceEth}`,
  quantity: "1",
  criteria: { collection: { slug: "nakamigos" }, trait: { type, value } },
});

const collectionWideOffer = (priceEth) => ({
  price: priceEth,
  currency: "WETH",
  maker: "0xdef",
  orderHash: `0xcoll${priceEth}`,
  quantity: "1",
  criteria: { collection: { slug: "nakamigos" }, trait: null },
});

describe("deriveTraitOffers", () => {
  it("groups trait offers by type/value with best price and count", () => {
    const offers = [
      traitOffer("Hair", "Mohawk", 0.5),
      traitOffer("Hair", "Mohawk", 0.8),
      traitOffer("Hair", "Buzzcut", 0.3),
      traitOffer("Type", "Robot", 1.2),
    ];
    const map = deriveTraitOffers(offers);
    expect(map.Hair.Mohawk).toEqual({ priceEth: 0.8, count: 2 });
    expect(map.Hair.Buzzcut).toEqual({ priceEth: 0.3, count: 1 });
    expect(map.Type.Robot).toEqual({ priceEth: 1.2, count: 1 });
  });

  it("ignores collection-wide offers and malformed entries", () => {
    const offers = [
      collectionWideOffer(2.0),
      { price: 0.4, criteria: null },
      { price: 0.4, criteria: { trait: { type: "Hair" } } }, // no value
      { price: null, criteria: { trait: { type: "Hair", value: "Cap" } } }, // no price
      { price: 0, criteria: { trait: { type: "Hair", value: "Cap" } } }, // zero price
      traitOffer("Hair", "Cap", 0.25),
    ];
    const map = deriveTraitOffers(offers);
    expect(map).toEqual({ Hair: { Cap: { priceEth: 0.25, count: 1 } } });
  });

  it("returns an empty map for empty or missing input", () => {
    expect(deriveTraitOffers([])).toEqual({});
    expect(deriveTraitOffers()).toEqual({});
  });
});

describe("SEAPORT_FULFILLMENT_FUNCTIONS allowlist", () => {
  it("accepts the canonical fulfillment/match entrypoints", () => {
    for (const fn of [
      "fulfillBasicOrder",
      "fulfillBasicOrder_efficient_6GL6yc",
      "fulfillOrder",
      "fulfillAdvancedOrder",
      "fulfillAvailableOrders",
      "fulfillAvailableAdvancedOrders",
      "matchOrders",
      "matchAdvancedOrders",
    ]) {
      expect(SEAPORT_FULFILLMENT_FUNCTIONS.has(fn)).toBe(true);
    }
  });

  it("rejects state-changing non-fulfillment Seaport functions", () => {
    for (const fn of ["cancel", "incrementCounter", "validate", "", "transferFrom"]) {
      expect(SEAPORT_FULFILLMENT_FUNCTIONS.has(fn)).toBe(false);
    }
  });
});

describe("NFT_LOAN_DESK_LIVE credibility gate", () => {
  it("tracks isDeployed(TEGRIDY_NFT_LENDING_ADDRESS) so loan CTAs light up on deploy", () => {
    // Also a smoke test that nakamigos/constants.js can import ../lib/constants
    // at runtime (the gate executes at module load inside the nakamigos chunk).
    expect(NFT_LOAN_DESK_LIVE).toBe(isDeployed(TEGRIDY_NFT_LENDING_ADDRESS));
  });
});

// ═══ F630 regression: Seaport cancel() OrderComponents hash ═══
// The bug (4 cloned copies): the cancel ABI ended the tuple in
// `totalOriginalConsiderationItems`, so ethers shoved that field (2 or 3) into
// the COUNTER slot. Seaport then hashed a phantom order — the tx mined, but the
// real listing/bid stayed fillable. The fix (buildOrderComponents) substitutes
// the offerer's LIVE counter into the trailing slot. These tests pin the
// canonical Seaport order hash (struct-hash of OrderComponents, no \x19\x01
// prefix — same value createNativeListing stores as seaportOrderHash and Seaport
// emits in OrderFulfilled) so the cancel can only invalidate the REAL order.
//
// Golden hashes were derived independently of buildOrderComponents, from the raw
// signed parameters via ethers.TypedDataEncoder.from(SEAPORT_ORDER_TYPES)
// .hash({ ...params, counter }) — the same path the wallet signs. The fixtures'
// counter != totalOriginalConsiderationItems, so the pre-fix code would hash to
// a different value and fail these assertions.
describe("F630 — buildOrderComponents derives the signed Seaport order hash", () => {
  const ZERO = "0x0000000000000000000000000000000000000000";
  const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";
  const CONDUIT_KEY = "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000";
  const NAKA = "0xd774557b647330c91bf44cfeab205095f7e6c367";

  const hashComponents = (components) =>
    ethers.TypedDataEncoder.from(SEAPORT_ORDER_TYPES).hash(components).toLowerCase();

  // Native-orderbook listing (createNativeListing shape): native ETH
  // consideration, two items, signed at counter 0.
  const NATIVE_ORDER = {
    counter: 0,
    seaportOrderHash: "0xc6d7e79e5caf298c14cf3436243f3e738ff9e8e90fc6e6a29e182effa2b98ebe",
    parameters: {
      offerer: "0x1489000000000000000000000000000000000456",
      zone: ZERO,
      offer: [{ itemType: 2, token: NAKA, identifierOrCriteria: "1234", startAmount: "1", endAmount: "1" }],
      consideration: [
        { itemType: 0, token: ZERO, identifierOrCriteria: "0", startAmount: "990000000000000000", endAmount: "990000000000000000", recipient: "0x1489000000000000000000000000000000000456" },
        { itemType: 0, token: ZERO, identifierOrCriteria: "0", startAmount: "10000000000000000", endAmount: "10000000000000000", recipient: "0x7d2620243edad69ec81a53c4a063b07995a4bd7d" },
      ],
      orderType: 0,
      startTime: "1700000000",
      endTime: "1700604800",
      zoneHash: ZERO_HASH,
      salt: "12345678901234567890",
      conduitKey: CONDUIT_KEY,
      totalOriginalConsiderationItems: 2,
    },
  };

  // OpenSea listing (protocol_data.parameters shape): three consideration items
  // (seller + OS fee + creator fee), signed at a non-zero counter (5) that is
  // deliberately != totalOriginalConsiderationItems (3) so the old bug diverges.
  const OPENSEA_ORDER = {
    counter: 5,
    seaportOrderHash: "0x89c7716333aae209b78dcf016df86808373a2593f0d9482aec9393344bf271c4",
    parameters: {
      offerer: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
      zone: ZERO,
      offer: [{ itemType: 2, token: NAKA, identifierOrCriteria: "888", startAmount: "1", endAmount: "1" }],
      consideration: [
        { itemType: 0, token: ZERO, identifierOrCriteria: "0", startAmount: "950000000000000000", endAmount: "950000000000000000", recipient: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca" },
        { itemType: 0, token: ZERO, identifierOrCriteria: "0", startAmount: "25000000000000000", endAmount: "25000000000000000", recipient: "0x0000a26b00c1f0df003000390027140000faa719" },
        { itemType: 0, token: ZERO, identifierOrCriteria: "0", startAmount: "25000000000000000", endAmount: "25000000000000000", recipient: "0x1111111111111111111111111111111111111111" },
      ],
      orderType: 0,
      startTime: "1699000000",
      endTime: "1699604800",
      zoneHash: ZERO_HASH,
      salt: "51951570786726798460324122337533974012547561141004870461226495066725827593241",
      conduitKey: CONDUIT_KEY,
      totalOriginalConsiderationItems: 3,
    },
  };

  it("rebuilt components hash to the stored hash for a native order", () => {
    const components = buildOrderComponents(NATIVE_ORDER.parameters, NATIVE_ORDER.counter);
    expect(hashComponents(components)).toBe(NATIVE_ORDER.seaportOrderHash);
  });

  it("rebuilt components hash to the stored hash for an OpenSea order", () => {
    const components = buildOrderComponents(OPENSEA_ORDER.parameters, OPENSEA_ORDER.counter);
    expect(hashComponents(components)).toBe(OPENSEA_ORDER.seaportOrderHash);
  });

  it("would NOT match if totalOriginalConsiderationItems leaked into the counter slot (the bug)", () => {
    // Reproduce the pre-fix behavior: counter := totalOriginalConsiderationItems.
    for (const order of [NATIVE_ORDER, OPENSEA_ORDER]) {
      const buggy = buildOrderComponents(order.parameters, order.parameters.totalOriginalConsiderationItems);
      expect(hashComponents(buggy)).not.toBe(order.seaportOrderHash);
    }
  });

  it("places the live counter in the counter slot and never carries totalOriginalConsiderationItems", () => {
    const components = buildOrderComponents(OPENSEA_ORDER.parameters, OPENSEA_ORDER.counter);
    expect(components.counter).toBe(5n);
    expect("totalOriginalConsiderationItems" in components).toBe(false);
  });
});
