// The collection registry states facts the chain can check, and nothing else.
//
// Six Jungle Bay family collections join the three the marketplace trades
// today. Every value an entry carries was READ for this change (an eth_call,
// a Solana metadata read, the collection's own OpenSea page), and this file
// compares the registry against __fixtures__/jungleBayFamily.js, which holds
// those reads. A value typed from memory that disagrees with the chain goes
// red here before any surface can print it.
//
// It also holds the registry's capability rule to one shape: a collection is
// venue-tradeable only as an Ethereum ERC-721, and the flag can never say
// otherwise.

import { describe, it, expect } from "vitest";
import { getAddress } from "ethers";
import {
  COLLECTIONS, VALID_TABS, COLLECTION_LORE, TRAIT_LORE, LOADING_MESSAGES, FUN_FACTS,
} from "./constants";
import { JBAY_GOLD_ADDRESS } from "../lib/constants";
import {
  EXPECTED_FAMILY, FAMILY_SLUGS, REGISTRY_ORDER, VENUE_CHIPS, VENUE_SLUGS,
  SEEDS_DESCRIPTION_OPENSEA_VERBATIM, SEEDS_DESCRIPTION_STORED, normalizeEmDashes,
  GOLD_DESCRIPTION_STORED, SEEDS_REJECTED_CANDIDATE, TOWELI_ONLY,
} from "./__fixtures__/jungleBayFamily";

const entry = (slug) => COLLECTIONS[slug];
// Imported through a variable so a missing helper fails only the tests that use it.
const loadVenue = () => import(/* @vite-ignore */ "./lib/venue" + "");

describe("the picker lists nine collections, in a fixed order", () => {
  it("keeps the three that trade today first, then Gold Cards, then the five view-only ones in green's order", () => {
    expect(Object.keys(COLLECTIONS)).toEqual(REGISTRY_ORDER);
  });
});

describe("every family entry equals what was read", () => {
  for (const slug of FAMILY_SLUGS) {
    describe(slug, () => {
      const want = EXPECTED_FAMILY[slug];

      it("exists", () => {
        expect(entry(slug), `${slug} is not in COLLECTIONS`).toBeTruthy();
      });

      for (const field of [
        "name", "contract", "slug", "openseaSlug", "chain", "standard", "venueTrade", "symbol",
        "supply", "mintBlock", "deploy", "image", "description", "descriptionSource", "tags",
        "market", "explorer", "blurSlug",
      ]) {
        it(`${field} equals the read`, () => {
          expect(entry(slug)?.[field]).toEqual(want[field]);
        });
      }

      for (const field of ["editions", "magicEdenSymbol", "solana", "tokenIds", "burnedIds", "chip"]) {
        if (!(field in want)) continue;
        it(`${field} equals the read`, () => {
          expect(entry(slug)?.[field]).toEqual(want[field]);
        });
      }

      it("names the read behind its supply", () => {
        const note = entry(slug)?.supplyNote ?? "";
        expect(note.length, `${slug} has no supplyNote`).toBeGreaterThan(0);
        for (const fact of want.supplyNoteMentions) expect(note).toContain(fact);
      });

      it("claims nothing about its supply that no read produced", () => {
        const note = entry(slug)?.supplyNote ?? "";
        for (const claim of want.supplyNoteNever ?? []) expect(note).not.toMatch(claim);
      });

      it("never borrows a Nakamigos default for its images", () => {
        // null, not undefined: an undefined metadataBase lets the METADATA_BASE
        // default parameter in api.js apply, which is Nakamigos' IPFS CID.
        expect(entry(slug)?.metadataBase).toBeNull();
        expect(entry(slug)?.deterministicImage).toBe(false);
        expect(entry(slug)?.pixelated).toBe(false);
        expect(entry(slug)?.highlights).toEqual([]);
      });
    });
  }

  it("contracts are EIP-55 checksummed, as the chain spells them", () => {
    for (const slug of FAMILY_SLUGS) {
      const c = entry(slug)?.contract;
      if (c === null) continue;
      expect(c, `${slug} contract`).toBe(getAddress(String(c).toLowerCase()));
    }
  });

  it("Gold Cards is the address the rest of the venue already names", () => {
    expect(entry("junglebaygoldcards")?.contract).toBe(JBAY_GOLD_ADDRESS);
  });

  it("Seeds is the ERC-721 clone, never the delegated EOA that appears on its page", () => {
    expect(String(entry("memeticseeds")?.contract).toLowerCase()).not.toBe(SEEDS_REJECTED_CANDIDATE);
  });

  it("Junglets has no EVM contract, and says so with null rather than leaving it out", () => {
    // undefined would fall through to the Nakamigos CONTRACT default parameter
    // of every api.js reader; null cannot.
    expect(entry("junglets")).toHaveProperty("contract", null);
  });
});

describe("the capability rule has one shape", () => {
  it("every entry names its chain, standard, home market and explorer", () => {
    for (const [slug, c] of Object.entries(COLLECTIONS)) {
      expect(["ethereum", "base", "solana"], `${slug}.chain`).toContain(c.chain);
      expect(["erc721", "erc1155", "spl"], `${slug}.standard`).toContain(c.standard);
      expect(typeof c.venueTrade, `${slug}.venueTrade`).toBe("boolean");
      expect(typeof c.market?.name, `${slug}.market.name`).toBe("string");
      expect(c.market?.collectionUrl, `${slug}.market.collectionUrl`).toMatch(/^https:\/\//);
      expect(c.explorer?.addressUrl, `${slug}.explorer.addressUrl`).toMatch(/^https:\/\//);
    }
  });

  it("venueTrade is true exactly for the Ethereum ERC-721 entries", () => {
    for (const [slug, c] of Object.entries(COLLECTIONS)) {
      expect(c.venueTrade, slug).toBe(c.chain === "ethereum" && c.standard === "erc721");
    }
  });

  it("the venue entries are exactly the three that trade today plus Gold Cards", () => {
    const venue = Object.entries(COLLECTIONS).filter(([, c]) => c.venueTrade).map(([k]) => k);
    expect(venue).toEqual([...VENUE_SLUGS]);
  });

  it("every venue entry has slug === openseaSlug, so a slug read by either name hits the same OpenSea route", () => {
    for (const slug of VENUE_SLUGS) {
      expect(entry(slug)?.slug, slug).toBe(entry(slug)?.openseaSlug);
    }
  });

  it("the three that trade today keep their Blur link and gain OpenSea and Etherscan as data", () => {
    for (const slug of ["nakamigos", "gnssart", "junglebay"]) {
      const c = entry(slug);
      expect(c.chain).toBe("ethereum");
      expect(c.standard).toBe("erc721");
      expect(c.venueTrade).toBe(true);
      expect(c.blurSlug).toBe(c.slug);
      expect(c.market).toEqual({
        name: "OpenSea",
        collectionUrl: `https://opensea.io/collection/${c.openseaSlug}`,
        itemUrlTemplate: `https://opensea.io/item/ethereum/${c.contract.toLowerCase()}/{id}`,
      });
      expect(c.explorer).toEqual({ name: "Etherscan", addressUrl: `https://etherscan.io/address/${c.contract}` });
    }
  });

  it("each venue collection wears a P2P chip that names only itself", () => {
    const names = Object.values(COLLECTIONS).map((c) => c.name.toUpperCase());
    for (const [slug, chip] of Object.entries(VENUE_CHIPS)) {
      expect(entry(slug)?.chip, `${slug}.chip`).toBe(chip);
      const others = names.filter((n) => n !== entry(slug)?.name.toUpperCase());
      for (const other of others) {
        expect(other.includes(chip), `chip ${chip} reads as ${other}`).toBe(false);
      }
    }
    expect(new Set(Object.values(VENUE_CHIPS)).size).toBe(Object.keys(VENUE_CHIPS).length);
  });
});

describe("no key can be mistaken for a route", () => {
  it("no collection key is a tab, the nft deep-link segment, or the landing", () => {
    for (const key of Object.keys(COLLECTIONS)) {
      expect(VALID_TABS, key).not.toContain(key);
      expect(key).not.toBe("nft");
      expect(key).not.toBe("landing");
      expect(key.length).toBeLessThanOrEqual(64);
    }
  });
});

describe("nothing is invented for the new collections", () => {
  it("the six carry no lore, trait lore, loading lines or fun facts", () => {
    for (const slug of FAMILY_SLUGS) {
      expect(COLLECTION_LORE, slug).not.toHaveProperty(slug);
      expect(TRAIT_LORE, slug).not.toHaveProperty(slug);
      expect(LOADING_MESSAGES, slug).not.toHaveProperty(slug);
      expect(FUN_FACTS, slug).not.toHaveProperty(slug);
    }
  });

  it("Seeds keeps its own words, with only the em dashes set as spaced hyphens", () => {
    expect(entry("memeticseeds")?.description).toBe(normalizeEmDashes(SEEDS_DESCRIPTION_OPENSEA_VERBATIM));
    expect(SEEDS_DESCRIPTION_STORED).toContain("~40 artists - each contributing");
    expect(SEEDS_DESCRIPTION_STORED).toContain("grow.” - Sartoshi");
    expect(SEEDS_DESCRIPTION_STORED).toContain("together - unified");
  });

  it("Gold Cards stores its provenance paragraph only, never the benefit list", () => {
    const d = entry("junglebaygoldcards")?.description ?? "";
    expect(d).toBe(GOLD_DESCRIPTION_STORED);
    expect(d).not.toMatch(/multiplier/i);
    expect(d).not.toMatch(/airdrop/i);
    expect(d).not.toMatch(/1\.5x/);
  });

  it("no string a new entry carries has an em dash, the protocol's name, or TOWELI protocol copy", () => {
    const strings = [];
    const walk = (v) => {
      if (typeof v === "string") strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    for (const slug of FAMILY_SLUGS) walk(entry(slug));
    expect(strings.length).toBeGreaterThan(20);
    for (const s of strings) {
      expect(s, s.slice(0, 80)).not.toMatch(/\u2014/);
      expect(s, s.slice(0, 80)).not.toMatch(/tegridy/i);
      expect(TOWELI_ONLY.test(s), s.slice(0, 80)).toBe(false);
    }
  });
});

describe("market links go where the collection really trades", () => {
  it("builds the per-item page from the registry template, and only for a numeric id", async () => {
    const { marketItemUrl } = await loadVenue();
    expect(marketItemUrl(entry("bojungles"), "0")).toBe("https://opensea.io/item/base/0x36afee4fadc3b77ff5f1f9a040e264150afb979a/0");
    expect(marketItemUrl(entry("memeticseeds"), "87")).toBe("https://opensea.io/item/base/0xb34bb1d81a4e5f9dca7360c3043ad50db2ea87f3/87");
    expect(marketItemUrl(entry("junglebaymemes"), "1")).toBe("https://opensea.io/item/ethereum/0x9edaba801123866f25993914e389924744a07e89/1");
    expect(marketItemUrl(entry("raretowelie"), "61")).toBe("https://opensea.io/item/ethereum/0x2bcaad3cd618d0c0f87e153b3928e02bab757705/61");
    expect(marketItemUrl(entry("junglebaygoldcards"), "123")).toBe("https://opensea.io/item/ethereum/0x6aa03f42c5366e2664c887eb2e90844ca00b92f3/123");
  });

  it("gives no per-item page where none was verified, or for an id that is not digits", async () => {
    const { marketItemUrl } = await loadVenue();
    expect(marketItemUrl(entry("junglets"), "64")).toBeNull();
    expect(marketItemUrl(entry("bojungles"), "abc")).toBeNull();
    expect(marketItemUrl(entry("bojungles"), "1/../../x")).toBeNull();
    expect(marketItemUrl(entry("bojungles"), "")).toBeNull();
  });

  it("gives no buy page for a token held by the burn address", async () => {
    const { marketItemUrl } = await loadVenue();
    expect(marketItemUrl(entry("memeticseeds"), "88")).toBeNull();
  });
});
