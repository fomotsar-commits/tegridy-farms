// A price a buyer is shown is readable, and never less than the wallet will ask for.
//
// #1150 showed every listing's price exactly from its wei, which can run long:
// a Nakamigos listing of 84939999999999000 wei read 0.084939999999999 on the
// live Floor (2026-11-08). Now a price with more than six decimals is rounded
// UP to six (0.08494): a hair above the true price, never below it. Rounding
// to the NEAREST would read 0.084943 for 0.08494349, which is less than is paid,
// so the rule is a ceiling. Prices that fit in six decimals are shown exactly,
// and the exact figure stays in the item's tooltip.

import { describe, it, expect } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { formatListingPrice, listingPriceTitle, shownEth, exactEth } from "./lib/formatPrice";
import Card from "./components/Card";
import ExternalGallery from "./components/external/ExternalGallery";
import BuyHere from "./components/external/BuyHere";
import { CollectionProvider } from "./contexts/CollectionContext";
import { COLLECTIONS } from "./constants";

const WEI_PER_MICRO = 10n ** 12n;
// "0.08494" -> 84940000000000000n, for comparing a shown price with its wei.
const toWei = (eth) => {
  const [w, f = ""] = eth.split(".");
  return BigInt(w) * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18));
};

describe("a listing price is shown to at most six decimals, rounded UP", () => {
  it("84939999999999000 wei (0.084939999999999, Nakamigos #17503 on 2026-11-08) reads 0.08494", () => {
    expect(formatListingPrice({ priceWei: "84939999999999000", price: 0.084939999999999 })).toBe("0.08494");
  });

  it("rounds up, never to the nearest: 0.08494349 reads 0.084944, not the 0.084943 that is less than is paid", () => {
    expect(formatListingPrice({ priceWei: "84943490000000000" })).toBe("0.084944");
  });

  it("one wei over a six-decimal price rounds up a whole step", () => {
    expect(shownEth("18990000000000001")).toBe("0.018991");
    expect(shownEth("1")).toBe("0.000001");
  });

  it("a price that fits in six decimals is shown exactly, as before", () => {
    expect(formatListingPrice({ priceWei: "18990000000000000" })).toBe("0.01899");
    expect(formatListingPrice({ priceWei: "18949000000000000" })).toBe("0.018949");
    expect(formatListingPrice({ priceWei: "1500000000000000000" })).toBe("1.5");
    expect(formatListingPrice({ priceWei: "2000000000000000000" })).toBe("2");
    expect(shownEth("0")).toBe("0");
  });

  it("is never below the wei and never more than one step above, across many prices", () => {
    let seed = 7n;
    for (let i = 0; i < 2000; i++) {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
      const wei = seed % (10n ** 21n); // up to 1,000 ETH
      const shown = shownEth(wei.toString());
      const back = toWei(shown);
      expect(back >= wei, `${wei} shown as ${shown}`).toBe(true);
      expect(back - wei < WEI_PER_MICRO, `${wei} shown as ${shown}`).toBe(true);
      expect((shown.split(".")[1] || "").length).toBeLessThanOrEqual(6);
    }
  });

  it("anything that is not a plain wei string falls back as before", () => {
    expect(shownEth("0x10")).toBeNull();
    expect(formatListingPrice({ price: 0.5 })).toBe("0.5000");
  });

  it("the tooltip carries the exact figure only when the shown one is rounded", () => {
    expect(listingPriceTitle({ priceWei: "84939999999999000" })).toBe("0.084939999999999 ETH exactly");
    expect(listingPriceTitle({ priceWei: "18990000000000000" })).toBeUndefined();
    expect(listingPriceTitle({ price: 0.5 })).toBeUndefined();
    expect(exactEth("84939999999999000")).toBe("0.084939999999999");
  });
});

describe("the screens a buyer reads show the rounded-up price", () => {
  it("an Ethereum listing card reads 0.08494 for 84939999999999000 wei", () => {
    const { container } = render(
      <CollectionProvider slug="nakamigos">
        <Card nft={{ id: "17503", name: "Nakamigos #17503", price: 0.084939999999999, priceWei: "84939999999999000" }} idx={0} onPick={() => {}} view="listings" skipReveal />
      </CollectionProvider>,
    );
    const card = container.querySelector('[data-token-id="17503"]');
    expect(card.getAttribute("aria-label")).toMatch(/0\.08494 ETH/);
    expect(card.textContent).toMatch(/0\.08494(?!\d)/);
    expect(card.textContent).not.toMatch(/0\.0849399/);
    cleanup();
  });

  it("a Base gallery card and its Buy panel read 0.08494, with the exact figure in the price's tooltip", () => {
    const collection = COLLECTIONS.bojungles;
    const listing = { tokenId: "181", priceWei: "84939999999999000", price: 0.084939999999999, orderHash: "0x" + "c".repeat(64) };
    const gallery = render(
      <ExternalGallery
        collection={collection}
        items={{ status: "ready", list: [{ id: "181", name: null, image: null }], dropped: 0, source: "OpenSea" }}
        onRetry={() => {}}
        onPick={() => {}}
        listings={new Map([["181", listing]])}
      />,
    );
    expect(gallery.container.textContent).toMatch(/0\.08494 ETH/);
    expect(gallery.container.textContent).not.toMatch(/0\.0849399/);
    cleanup();

    const panel = render(<BuyHere collection={collection} item={{ id: "181" }} listing={listing} listingsStatus="ready" wallet={"0x" + "a".repeat(40)} />);
    expect(panel.container.textContent).toMatch(/Buy for 0\.08494 ETH/);
    const price = panel.container.querySelector(".ext-buy-price strong");
    expect(price.textContent).toBe("0.08494 ETH");
    expect(price.getAttribute("title")).toBe("0.084939999999999 ETH exactly");
    cleanup();
  });
});
