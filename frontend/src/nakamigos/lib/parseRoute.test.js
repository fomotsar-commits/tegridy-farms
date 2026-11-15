import { describe, it, expect } from "vitest";
import { parseRoute, landingTabFor } from "./parseRoute";
import { COLLECTIONS, VALID_TABS } from "../constants";
import { canTradeOnVenue } from "./venue";

// A collection's bare address is how a visitor arrives: a card on the
// marketplace landing, its search, the Jungle Bay showcase, a shared link. The
// owner (2026-11-15): "user should always land on floor not gallery". A
// collection that trades here opens on Floor; a view-only one has no Floor, so
// it opens on Gallery. A tab named in the address is always that tab.

describe("a bare collection address", () => {
  it("opens a collection that trades here on Floor", () => {
    expect(parseRoute("/nakamigos/nakamigos")).toEqual({ collectionSlug: "nakamigos", tab: "listings", tokenId: null });
    expect(parseRoute("/nakamigos/nakamigos/").tab).toBe("listings");
    expect(parseRoute("/nakamigos/junglebaygoldcards").tab).toBe("listings");
  });

  it("opens a view-only collection on Gallery, the only list it has", () => {
    expect(parseRoute("/nakamigos/raretowelie").tab).toBe("gallery");
    expect(parseRoute("/nakamigos/bojungles").tab).toBe("gallery");
  });

  it("every collection lands on a tab that exists, Floor exactly when it trades here", () => {
    for (const slug of Object.keys(COLLECTIONS)) {
      const tab = landingTabFor(slug);
      expect(VALID_TABS, slug).toContain(tab);
      expect(tab, slug).toBe(canTradeOnVenue(COLLECTIONS[slug]) ? "listings" : "gallery");
    }
  });
});

describe("an address that names its tab is that tab", () => {
  it("Gallery is Gallery", () => {
    expect(parseRoute("/nakamigos/nakamigos/gallery").tab).toBe("gallery");
  });

  it("a token link opens the token over Gallery", () => {
    expect(parseRoute("/nakamigos/nakamigos/nft/42")).toEqual({ collectionSlug: "nakamigos", tab: "gallery", tokenId: "42" });
  });

  it("the landing is the landing, and an unknown tab is not found", () => {
    expect(parseRoute("/nakamigos").tab).toBe("landing");
    expect(parseRoute("/nakamigos/nakamigos/nope").tab).toBe("404");
  });
});
