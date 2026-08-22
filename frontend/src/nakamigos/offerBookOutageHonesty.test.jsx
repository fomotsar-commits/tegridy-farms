import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { CollectionProvider } from "./contexts/CollectionContext";

// The detail modal's two market panels read feeds that fail routinely: the
// OpenSea proxy rate-limits under normal browsing, and the activity feed answers
// a total outage with a sample fixture rather than an error. Both panels used to
// paint that as a measured zero ("No Offers Yet", "No comparable sales in the
// last 90 days") — the one thing a bidder must not be told when it isn't known.
// Only the NETWORK BOUNDARY is faked here, so the real components and the real
// api/api-offers degradation paths run.

const proxyState = { openseaFails: false };

vi.mock("./lib/proxy", async (importOriginal) => {
  const actual = await importOriginal();
  const fail = () => {
    // retryAfter collapses both retry ladders (api.js and api-offers.js honour
    // it) to ~1ms so the test exercises the real backoff code without paying
    // ten seconds of real exponential delay.
    throw new actual.ApiError("Too Many Requests", 429, 0.001);
  };
  return {
    ...actual,
    openseaGet: vi.fn(async () => {
      if (proxyState.openseaFails) fail();
      // Reachable but empty: no orders, and no `price` key means no best offer.
      return { orders: [] };
    }),
    openseaPost: vi.fn(async () => ({})),
    alchemyGet: vi.fn(async () => { throw new Error("alchemy down"); }),
    alchemyPost: vi.fn(async () => { throw new Error("alchemy down"); }),
  };
});

// The native orderbook leg of fetchActivity talks to a relative /api URL that
// has no server here; keep it deterministic rather than jsdom-dependent.
beforeEach(() => {
  proxyState.openseaFails = false;
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("no server"); }));
});

const COL = "nakamigos";

describe("OfferPanel separates an unreachable offer book from an empty one", () => {
  it("names the outage instead of claiming zero offers when the feed 429s", async () => {
    proxyState.openseaFails = true;
    const { default: OfferPanel } = await import("./components/OfferPanel.jsx");

    render(
      <CollectionProvider slug={COL}>
        <OfferPanel tokenId="11007" wallet={null} addToast={() => {}} onMakeOffer={() => {}} />
      </CollectionProvider>,
    );

    expect(await screen.findByText(/offers unavailable/i, undefined, { timeout: 15000 })).toBeInTheDocument();
    // The forbidden claim: a count of zero the app never measured.
    expect(screen.queryByText(/no offers yet/i)).toBeNull();
    expect(screen.queryByText(/be the first to make an offer/i)).toBeNull();
  }, 20000);

  it("holds its poll while the tab is backgrounded", async () => {
    const proxy = await import("./lib/proxy");
    const { default: OfferPanel } = await import("./components/OfferPanel.jsx");
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });

    // Installed before the render so the panel's interval is a fake one.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(
        <CollectionProvider slug={COL}>
          <OfferPanel tokenId="11007" wallet={null} addToast={() => {}} onMakeOffer={() => {}} />
        </CollectionProvider>,
      );
      await screen.findByText(/no offers yet/i, undefined, { timeout: 15000 });
      proxy.openseaGet.mockClear();

      hidden = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000 * 3); });
      expect(proxy.openseaGet).not.toHaveBeenCalled();

      hidden = false;
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(proxy.openseaGet).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  }, 30000);

  it("still says 'No Offers Yet' when the book answered and is genuinely empty", async () => {
    const { default: OfferPanel } = await import("./components/OfferPanel.jsx");

    render(
      <CollectionProvider slug={COL}>
        <OfferPanel tokenId="11007" wallet={null} addToast={() => {}} onMakeOffer={() => {}} />
      </CollectionProvider>,
    );

    expect(await screen.findByText(/no offers yet/i, undefined, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.queryByText(/offers unavailable/i)).toBeNull();
  }, 20000);
});

describe("fetchTokenOfferBook reports reachability alongside the data", () => {
  it("flags unavailable when a leg rejects, and not when both answer", async () => {
    const { fetchTokenOfferBook } = await import("./api-offers");

    const ok = await fetchTokenOfferBook("11007", { contract: "0x1", slug: COL });
    expect(ok.unavailable).toBe(false);
    expect(ok.offers).toEqual([]);
    expect(ok.bestOffer).toBeNull();

    proxyState.openseaFails = true;
    const down = await fetchTokenOfferBook("11007", { contract: "0x1", slug: COL });
    expect(down.unavailable).toBe(true);
    expect(down.offers).toEqual([]);
    expect(down.bestOffer).toBeNull();
  }, 20000);

  it("keeps the swallowing wrappers non-throwing for their existing callers", async () => {
    const { fetchTokenOffers, fetchBestOffer } = await import("./api-offers");
    proxyState.openseaFails = true;
    await expect(fetchTokenOffers("11007", "0x1")).resolves.toEqual([]);
    await expect(fetchBestOffer("11007", COL)).resolves.toBeNull();
  }, 20000);
});

describe("ComparableSales refuses the activity fallback fixture", () => {
  it("is exercised against the real fixture-bearing outage response", async () => {
    // Pins the premise of the next test: under a full outage fetchActivity
    // RESOLVES with sample rows (it does not reject), so the component's
    // `fallback` check — not its catch block — is what must do the refusing.
    proxyState.openseaFails = true;
    const { fetchActivity } = await import("./api");
    const { CONTRACT, FALLBACK_ACTIVITY } = await import("./constants");
    const data = await fetchActivity({ contract: CONTRACT, limit: 50, daysBack: 90 });
    expect(data.fallback).toBe(true);
    expect(data.activities).toEqual(FALLBACK_ACTIVITY);
  }, 20000);

  it("reports the outage rather than 'no comparable sales', and comps nothing", async () => {
    // Every activity source is down (opensea 429 + alchemy throw), so
    // fetchActivity degrades to { activities: FALLBACK_ACTIVITY, fallback: true }.
    proxyState.openseaFails = true;
    const { default: ComparableSales } = await import("./components/ComparableSales.jsx");
    const { FALLBACK_ACTIVITY } = await import("./constants");

    // Give the subject two traits shared with tokens whose ids are exactly the
    // fixture's, so an unguarded component WOULD comp against invented sales.
    const traits = [{ key: "Hat", value: "Cap" }, { key: "Eyes", value: "Blue" }];
    const nft = { id: "9999", name: "#9999", attributes: traits };
    const allTokens = [
      nft,
      ...FALLBACK_ACTIVITY.map((a, i) => ({ id: a.token.id, name: a.token.name, rank: i + 1, attributes: traits })),
    ];

    render(
      <CollectionProvider slug={COL}>
        <ComparableSales nft={nft} allTokens={allTokens} />
      </CollectionProvider>,
    );

    expect(
      await screen.findByText(/sales history unavailable/i, undefined, { timeout: 15000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no comparable sales/i)).toBeNull();
    // No fixture price may reach the DOM, and no average may be derived from one.
    expect(screen.queryByText(/avg:/i)).toBeNull();
    for (const a of FALLBACK_ACTIVITY) {
      expect(screen.queryByText(a.price.toFixed(4))).toBeNull();
    }
  }, 20000);
});
