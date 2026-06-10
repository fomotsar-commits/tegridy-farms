import { describe, it, expect } from "vitest";
import { deriveTraitOffers } from "./api-offers";
import { SEAPORT_FULFILLMENT_FUNCTIONS } from "./api";
import { NFT_LOAN_DESK_LIVE } from "./constants";
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
