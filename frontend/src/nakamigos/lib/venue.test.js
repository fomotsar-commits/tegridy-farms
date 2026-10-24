// One helper decides which collections trade on this venue.
//
// The marketplace's money path is Seaport on Ethereum with ERC-721 ownerOf
// pre-flights, the OpenSea fee and the venue's own 1%. A Base collection, an
// ERC-1155 or a Solana pNFT cannot complete that path, and green's ruling is
// that the venue never offers an action that cannot complete. So the rule
// lives in ONE function, every sink asks it, and every surface reads it; this
// file pins the function against fixtures of every shape the registry holds.

import { describe, it, expect } from "vitest";
import { COLLECTIONS } from "../constants";
import { ADDR } from "../__fixtures__/jungleBayFamily";

// Imported through a variable so each test reports its own failure while the
// module does not exist yet, instead of the whole file failing to transform.
const venue = () => import(/* @vite-ignore */ "./venue" + "");

const ETH_721 = { name: "Fixture 721", chain: "ethereum", standard: "erc721", venueTrade: true, contract: "0x" + "1".repeat(40), market: { name: "OpenSea" } };

describe("canTradeOnVenue", () => {
  it("is true for each collection that trades here today", async () => {
    const { canTradeOnVenue } = await venue();
    for (const slug of ["nakamigos", "gnssart", "junglebay"]) {
      expect(canTradeOnVenue(COLLECTIONS[slug]), slug).toBe(true);
    }
  });

  it("is true for a flagged Ethereum ERC-721 with a real address", async () => {
    const { canTradeOnVenue } = await venue();
    expect(canTradeOnVenue(ETH_721)).toBe(true);
  });

  it.each([
    ["a Base ERC-721", { ...ETH_721, chain: "base", venueTrade: false }],
    ["an Ethereum ERC-1155", { ...ETH_721, standard: "erc1155", venueTrade: false }],
    ["a Solana collection with a null contract", { ...ETH_721, chain: "solana", standard: "spl", contract: null, venueTrade: false }],
    ["a flag that disagrees with its chain", { ...ETH_721, chain: "base" }],
    ["a flag that disagrees with its standard", { ...ETH_721, standard: "erc1155" }],
    ["an unflagged Ethereum ERC-721", { ...ETH_721, venueTrade: false }],
    ["a missing contract", { ...ETH_721, contract: undefined }],
    ["a malformed contract", { ...ETH_721, contract: "0x1234" }],
    ["null", null],
    ["undefined", undefined],
  ])("is false for %s", async (_label, fixture) => {
    const { canTradeOnVenue } = await venue();
    expect(canTradeOnVenue(fixture)).toBe(false);
  });
});

describe("the venue list", () => {
  it("holds exactly the registry entries the rule admits, in registry order", async () => {
    const { VENUE_COLLECTIONS, canTradeOnVenue } = await venue();
    expect(VENUE_COLLECTIONS.map((c) => c.slug)).toEqual(
      Object.values(COLLECTIONS).filter(canTradeOnVenue).map((c) => c.slug),
    );
    expect(Object.isFrozen(VENUE_COLLECTIONS)).toBe(true);
  });

  it("is the three that trade today plus Gold Cards", async () => {
    const { VENUE_COLLECTIONS } = await venue();
    expect(VENUE_COLLECTIONS.map((c) => c.slug)).toEqual(["nakamigos", "gnssart", "junglebay", "junglebaygoldcards"]);
  });
});

describe("lookups", () => {
  it("finds a venue collection by contract, ignoring case", async () => {
    const { venueCollectionByContract } = await venue();
    expect(venueCollectionByContract(ADDR.gnssart.toLowerCase())?.slug).toBe("gnssart");
    expect(venueCollectionByContract(ADDR.gnssart.toUpperCase().replace("0X", "0x"))?.slug).toBe("gnssart");
    expect(venueCollectionByContract(ADDR.junglebaygoldcards)?.slug).toBe("junglebaygoldcards");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["a Base contract", ADDR.bojungles],
    ["an ERC-1155 contract", ADDR.junglebaymemes],
    ["a random address", "0x" + "e".repeat(40)],
  ])("returns null for %s, without throwing", async (_l, address) => {
    const { venueCollectionByContract } = await venue();
    expect(venueCollectionByContract(address)).toBeNull();
  });

  it("finds a venue collection by slug or OpenSea slug, and never a view-only one", async () => {
    const { venueCollectionBySlug } = await venue();
    expect(venueCollectionBySlug("gnssart")?.slug).toBe("gnssart");
    expect(venueCollectionBySlug("junglebaygoldcards")?.slug).toBe("junglebaygoldcards");
    expect(venueCollectionBySlug("bojungless")).toBeNull();
    expect(venueCollectionBySlug("bojungles")).toBeNull();
    expect(venueCollectionBySlug(undefined)).toBeNull();
  });

  it("names any registry collection by contract, on any chain, for refusal copy", async () => {
    const { collectionByContractAnyChain } = await venue();
    expect(collectionByContractAnyChain(ADDR.bojungles.toLowerCase())?.slug).toBe("bojungles");
    expect(collectionByContractAnyChain(null)).toBeNull();
    expect(collectionByContractAnyChain("0x" + "e".repeat(40))).toBeNull();
  });
});

describe("venueRefusal", () => {
  it("returns null for a venue contract", async () => {
    const { venueRefusal } = await venue();
    expect(venueRefusal(ADDR.nakamigos)).toBeNull();
    expect(venueRefusal(ADDR.junglebaygoldcards.toLowerCase())).toBeNull();
  });

  it("names the collection and its home market when it knows the contract", async () => {
    const { venueRefusal } = await venue();
    expect(venueRefusal(ADDR.bojungles)).toEqual({
      error: "not-venue-tradeable",
      message: "Bojungles trades on OpenSea, not on this venue.",
    });
    expect(venueRefusal(ADDR.raretowelie)?.message).toBe("RARE TOWELIE CARDS trades on OpenSea, not on this venue.");
  });

  it("refuses an unknown or missing contract with the generic sentence", async () => {
    const { venueRefusal } = await venue();
    for (const a of ["0x" + "e".repeat(40), null, undefined, ""]) {
      expect(venueRefusal(a)).toEqual({
        error: "not-venue-tradeable",
        message: "This collection does not trade on this venue.",
      });
    }
  });
});

describe("labels a surface prints", () => {
  it("chainLabel and standardLabel read the registry", async () => {
    const { chainLabel, standardLabel } = await venue();
    expect(chainLabel(COLLECTIONS.nakamigos)).toBe("Ethereum");
    expect(chainLabel(COLLECTIONS.bojungles)).toBe("Base");
    expect(chainLabel(COLLECTIONS.junglets)).toBe("Solana");
    expect(standardLabel(COLLECTIONS.junglebaygoldcards)).toBe("ERC-721");
    expect(standardLabel(COLLECTIONS.raretowelie)).toBe("ERC-1155");
    expect(standardLabel(COLLECTIONS.junglets)).toBe("Metaplex pNFT");
  });

  it("supplyLabel says items for a 721 and designs plus editions for a 1155, never a bare guess", async () => {
    const { supplyLabel } = await venue();
    expect(supplyLabel(COLLECTIONS.junglebaygoldcards)).toBe("123 items");
    expect(supplyLabel(COLLECTIONS.memeticseeds)).toBe("369 items");
    expect(supplyLabel(COLLECTIONS.junglets)).toBe("208 items");
    expect(supplyLabel(COLLECTIONS.junglebaymemes)).toBe("22 designs, 975 editions");
    expect(supplyLabel(COLLECTIONS.raretowelie)).toBe("61 designs, 3,529 editions");
    expect(supplyLabel({ supply: null })).toBeNull();
  });

  it("marketCollectionUrl and explorerAddressUrl read the registry", async () => {
    const { marketCollectionUrl, explorerAddressUrl } = await venue();
    expect(marketCollectionUrl(COLLECTIONS.bojungles)).toBe("https://opensea.io/collection/bojungless");
    // OpenSea has no Junglets page, so there is no market link at all.
    expect(marketCollectionUrl(COLLECTIONS.junglets)).toBeNull();
    expect(explorerAddressUrl(COLLECTIONS.junglets)).toBe("https://explorer.solana.com/address/5csQYUGtJzUveFCKGRrnVCNZrPpkSAEZCZEsu9nBHuuK");
    expect(explorerAddressUrl(COLLECTIONS.memeticseeds)).toBe("https://basescan.org/address/0xb34bB1d81A4e5F9DcA7360C3043ad50db2ea87F3");
  });
});

describe("constants.js stays data only", () => {
  it("does not import venue.js, so the two can never form an import cycle", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src", "nakamigos", "constants.js"), "utf8");
    expect(src).not.toMatch(/from\s+["']\.\/lib\/venue["']/);
  });
});
