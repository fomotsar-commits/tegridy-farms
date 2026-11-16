import { describe, it, expect } from "vitest";
import {
  COLLECTIONS, OPENSEA_REQUIRED_BID_FEES, OPENSEA_FEE_RECIPIENT, OPENSEA_FEE_BPS, BID_VENUE_FEE_ENABLED,
  PLATFORM_FEE_BPS, openseaRequiredBidFees,
} from "./constants";
import { bookCollectionByContract } from "./lib/venue";

describe("the fees OpenSea requires on a bid", () => {
  // Read live 2026-11-16, GET /api/v2/collections/{slug}: each requires OpenSea's
  // 1% and nothing else (every creator fee is optional).
  const BID_ON = Object.values(COLLECTIONS).filter((c) => bookCollectionByContract(c.contract));

  it("are pinned for every collection the site bids on, Base included", () => {
    expect(BID_ON.map((c) => c.slug).sort()).toEqual(["bojungles", "gnssart", "junglebay", "junglebaygoldcards", "memeticseeds", "nakamigos"]);
    for (const c of BID_ON) {
      expect(openseaRequiredBidFees(c), c.slug).toEqual([{ recipient: "0x0000a26b00c1F0DF003000390027140000fAa719", bps: 100 }]);
    }
    expect(OPENSEA_FEE_RECIPIENT).toBe("0x0000a26b00c1F0DF003000390027140000fAa719");
    expect(OPENSEA_FEE_BPS).toBe(100);
  });

  it("are unknown (null) for anything else, so no bid is built on a guess", () => {
    expect(openseaRequiredBidFees(null)).toBeNull();
    expect(openseaRequiredBidFees(COLLECTIONS.junglets)).toBeNull();
    expect(openseaRequiredBidFees({ slug: "boredapeyachtclub" })).toBeNull();
    expect(openseaRequiredBidFees({ slug: "toString" })).toBeNull();
    expect(Object.isFrozen(OPENSEA_REQUIRED_BID_FEES)).toBe(true);
  });
});

describe("the venue's line on a bid", () => {
  it("is off until a test bid proves OpenSea takes it AND a simulated fill pays it", () => {
    expect(BID_VENUE_FEE_ENABLED).toBe(false);
  });

  it("is 0.5%, not 1% (docs/FEE_LEAK_LEDGER.md L-2)", () => {
    expect(PLATFORM_FEE_BPS).toBe(50);
  });
});

describe("registry values read on chain (2026-11-16)", () => {
  it("GNSS: totalSupply 9,697 (one at 0x...dEaD); created at block 14,403,802", () => {
    expect(COLLECTIONS.gnssart.supply).toBe(9697);
    expect(COLLECTIONS.gnssart.mintBlock).toBe(14403802);
  });

  it("JBAC: totalSupply 5,555 (38 at 0x...dEaD); created at block 13,949,933", () => {
    expect(COLLECTIONS.junglebay.supply).toBe(5555);
    expect(COLLECTIONS.junglebay.mintBlock).toBe(13949933);
  });
});
