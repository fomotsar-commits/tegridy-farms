import { describe, it, expect, vi } from "vitest";

// Isolate from the heavy ../api module — bundleAuthItemsString + the flag-off guard
// don't need a real provider, and getProvider() is only reached when the flag is ON.
vi.mock("../api", () => ({ getProvider: () => null }));

import { bundleAuthItemsString, createNativeBundleListing, MAX_BUNDLE_ITEMS } from "./orderbook";

// Mirror of the SERVER-side reconstruction in api/orderbook.js `create-bundle`. Kept
// here to PROVE the client digest (embedded in the signed auth message) and the server
// digest (rebuilt from params.offer to recover the signer) are byte-identical for the
// same NFT set. If they ever diverge, every bundle create would 403 — this test fails
// loudly first.
function serverItemsString(offer) {
  return offer
    .map((o) => `${(o.token || "").toLowerCase()}:${o.identifierOrCriteria}`)
    .sort()
    .join(",");
}

describe("bundleAuthItemsString", () => {
  it("lowercases the contract, formats contract:tokenId, comma-joins", () => {
    expect(
      bundleAuthItemsString([
        { contract: "0xAbC", tokenId: "1" },
        { contract: "0xAbC", tokenId: "2" },
      ]),
    ).toBe("0xabc:1,0xabc:2");
  });

  it("is order-independent (sorted), so item ordering cannot change the signature", () => {
    const a = bundleAuthItemsString([
      { contract: "0xdef", tokenId: "5" },
      { contract: "0xabc", tokenId: "9" },
    ]);
    const b = bundleAuthItemsString([
      { contract: "0xabc", tokenId: "9" },
      { contract: "0xdef", tokenId: "5" },
    ]);
    expect(a).toBe(b);
  });

  it("coerces numeric tokenIds to strings", () => {
    expect(
      bundleAuthItemsString([
        { contract: "0xA", tokenId: 3 },
        { contract: "0xA", tokenId: 4 },
      ]),
    ).toBe("0xa:3,0xa:4");
  });

  it("matches the server-side reconstruction from a Seaport offer array (lockstep)", () => {
    const items = [
      { contract: "0xD774557b647330C91Bf44cfEAB205095f7E6c367", tokenId: "42" },
      { contract: "0xa1de9f93c56c290c48849b1393b09eb616d55dbb", tokenId: "7" },
    ];
    const offer = items.map((it) => ({
      itemType: 2,
      token: it.contract,
      identifierOrCriteria: String(it.tokenId),
      startAmount: "1",
      endAmount: "1",
    }));
    expect(bundleAuthItemsString(items)).toBe(serverItemsString(offer));
  });
});

describe("MAX_BUNDLE_ITEMS", () => {
  it("is 50, aligned with the server cap so the client fails fast", () => {
    expect(MAX_BUNDLE_ITEMS).toBe(50);
  });
});

describe("createNativeBundleListing (flag OFF — current state)", () => {
  it("refuses with error=disabled while BUNDLE_LISTING_ENABLED is false, before any wallet call", async () => {
    const res = await createNativeBundleListing({
      items: [
        { contract: "0xA", tokenId: "1" },
        { contract: "0xA", tokenId: "2" },
      ],
      priceEth: 1,
    });
    expect(res.error).toBe("disabled");
    expect(typeof res.message).toBe("string");
  });
});
