// A price a buyer is asked to pay is never shown below what the wallet asks for.
//
// fetchListings used to cut an OpenSea price to four decimals, rounding DOWN:
// a listing of 18990000000000000 wei (0.01899 ETH, Bojungle #181 as OpenSea
// listed it on 2026-11-07) came out as `price: 0.0189`, and every surface then
// showed 0.0189 while the buy cost 0.01899. formatPrice also rounds to four
// decimals, so 0.018949 reads 0.0189 even from an exact number.
//
// So: the listing's `price` is exact, and a price shown to a buyer is read from
// its wei (formatListingPrice). Both OpenSea's `price.current.value` and the
// order book's `price_wei` are the buyer's total.

import { describe, it, expect, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

const state = vi.hoisted(() => ({ listings: [] }));

vi.mock("./lib/proxy", async (importOriginal) => {
  const actual = await importOriginal();
  const down = vi.fn(async () => { throw new Error("proxy down"); });
  return {
    ...actual,
    alchemyGet: down,
    alchemyPost: down,
    openseaPost: down,
    openseaGet: vi.fn(async () => ({ listings: state.listings, next: null })),
  };
});

import { fetchListings } from "./api";
import { exactEth, formatListingPrice, listingsTotalWei } from "./lib/formatPrice";
import Card from "./components/Card";
import { CollectionProvider } from "./contexts/CollectionContext";

const SEAPORT = "0x0000000000000068F116a894984e2DB1123eB395";

function osListing(tokenId, wei) {
  return {
    order_hash: `0x${"a".repeat(63)}${tokenId}`,
    protocol_address: SEAPORT,
    price: { current: { currency: "ETH", decimals: 18, value: wei } },
    protocol_data: { parameters: { offerer: "0x" + "1".repeat(40), offer: [{ identifierOrCriteria: String(tokenId) }] } },
  };
}

describe("fetchListings keeps a listing's price exact", () => {
  it("18990000000000000 wei is 0.01899, never the 0.0189 a four-decimal cut gives", async () => {
    state.listings = [osListing(181, "18990000000000000")];
    const { listings } = await fetchListings("nakamigos", {});
    expect(listings).toHaveLength(1);
    expect(listings[0].priceWei).toBe("18990000000000000");
    expect(listings[0].price).toBe(0.01899);
  });

  it("sorts by the exact price: 0.01899 is dearer than 0.0189", async () => {
    state.listings = [osListing(1, "18990000000000000"), osListing(2, "18900000000000000")];
    const { listings } = await fetchListings("nakamigos", {});
    expect(listings.map((l) => l.tokenId)).toEqual(["2", "1"]);
  });
});

describe("formatListingPrice shows what the buyer pays, from wei", () => {
  it("is exact, even where four decimals would read lower", () => {
    expect(formatListingPrice({ priceWei: "18990000000000000", price: 0.0189 })).toBe("0.01899");
    expect(formatListingPrice({ priceWei: "18949000000000000", price: 0.018949 })).toBe("0.018949");
    expect(formatListingPrice({ priceWei: "1500000000000000000" })).toBe("1.5");
    expect(formatListingPrice({ priceWei: "2000000000000000000" })).toBe("2");
  });

  it("falls back to the shown figure only when there is no wei", () => {
    expect(formatListingPrice({ price: 0.5 })).toBe("0.5000");
    expect(formatListingPrice({ priceWei: "0x10", price: 0.5 })).toBe("0.5000");
    expect(formatListingPrice(null)).toBe("—");
  });

  it("exactEth refuses anything that is not a plain wei string", () => {
    for (const bad of [undefined, null, "", "1.5", "-1", "0x10", 10, "1".repeat(41)]) expect(exactEth(bad)).toBeNull();
    expect(exactEth("0")).toBe("0");
    expect(exactEth("1")).toBe("0.000000000000000001");
  });

  it("totals exactly from wei, or not at all when one listing has none", () => {
    expect(listingsTotalWei([{ priceWei: "18990000000000000" }, { priceWei: "100000000000000000" }])).toBe(118990000000000000n);
    expect(listingsTotalWei([{ priceWei: "18990000000000000" }, { price: 0.1 }])).toBeNull();
    expect(listingsTotalWei([])).toBe(0n);
  });
});

describe("a listed card shows the exact price", () => {
  it("a card whose listing is 18990000000000000 wei reads 0.01899, not 0.0189 or 0.0190", () => {
    const { container } = render(
      <CollectionProvider slug="nakamigos">
        <Card nft={{ id: "181", name: "Nakamigo #181", price: 0.0189, priceWei: "18990000000000000" }} idx={0} onPick={() => {}} view="listings" skipReveal />
      </CollectionProvider>,
    );
    const card = container.querySelector('[data-token-id="181"]');
    expect(card).not.toBeNull();
    expect(card.getAttribute("aria-label")).toMatch(/0\.01899 ETH/);
    expect(card.textContent).toMatch(/0\.01899/);
    expect(card.textContent).not.toMatch(/0\.0189(?!9)|0\.0190/);
    cleanup();
  });
});
