import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { CollectionProvider } from "./contexts/CollectionContext";

// The OpenSea collection-stats call 400s intermittently in production, and
// `fetchCollectionStats` covers the gap with a stored historical total so the
// volume tile doesn't blank out. That stand-in sits beside a live floor and a
// live owner count, which is exactly what makes it dangerous: without a marker
// it reads as this minute's figure, and it is not one. The whole-object
// `fallback` flag can't carry it — setting that would mislabel the measured
// fields — so the constant travels under its own `volumeFallback` flag.

const state = { openseaStatsFails: true };

vi.mock("./lib/proxy", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    alchemyGet: vi.fn(async (endpoint) => {
      if (endpoint === "getFloorPrice") return { openSea: { floorPrice: 0.2 } };
      if (endpoint === "getOwnersForContract") return { owners: new Array(4321).fill("0x0") };
      if (endpoint === "getContractMetadata") return { totalSupply: "20000" };
      return {};
    }),
    alchemyPost: vi.fn(async () => ({})),
    openseaGet: vi.fn(async (path) => {
      if (String(path).includes("/stats")) {
        if (state.openseaStatsFails) throw new actual.ApiError("Bad Request", 400);
        return { total: { volume: 999 } };
      }
      return {};
    }),
    openseaPost: vi.fn(async () => ({})),
  };
});

vi.mock("./lib/orderbook", () => ({
  fetchNativeListings: vi.fn(async () => ({ orders: [] })),
}));

beforeEach(() => {
  state.openseaStatsFails = true;
});

describe("fetchCollectionStats marks a stand-in volume without mislabelling the rest", () => {
  it("sets volumeFallback, and leaves the whole-object fallback flag clear", async () => {
    const { fetchCollectionStats } = await import("./api");
    const { CONTRACT, FALLBACK_STATS } = await import("./constants");

    const stats = await fetchCollectionStats({ contract: CONTRACT, slug: "nakamigos", openseaSlug: "nakamigos" });
    expect(stats.volume).toBe(FALLBACK_STATS.volume);
    expect(stats.volumeFallback).toBe(true);
    // Floor and owners were measured this call — they must not be tarred.
    expect(stats.fallback).toBeFalsy();
    expect(stats.floor).toBe(0.2);
    expect(stats.owners).toBe(4321);
  });

  it("leaves volumeFallback false when the live figure arrives", async () => {
    state.openseaStatsFails = false;
    const { fetchCollectionStats } = await import("./api");
    const { CONTRACT } = await import("./constants");

    const stats = await fetchCollectionStats({ contract: CONTRACT, slug: "nakamigos", openseaSlug: "nakamigos" });
    expect(stats.volume).toBe(999);
    expect(stats.volumeFallback).toBe(false);
  });

  it("gives other collections no stand-in at all", async () => {
    const { fetchCollectionStats } = await import("./api");
    const { COLLECTIONS } = await import("./constants");
    const other = Object.values(COLLECTIONS).find(
      (c) => c.slug !== "nakamigos" && c.contract,
    );
    expect(other).toBeTruthy();

    const stats = await fetchCollectionStats({ contract: other.contract, slug: other.slug, openseaSlug: other.openseaSlug });
    expect(stats.volume).toBeNull();
    expect(stats.volumeFallback).toBe(false);
  });
});

describe("the surfaces tag the stand-in tile", () => {
  const cachedStats = { floor: 0.2, volume: 52200, owners: 4321, supply: 20000, volumeFallback: true };
  const liveStats = { floor: 0.2, volume: 999, owners: 4321, supply: 20000, volumeFallback: false };

  it("Hero tags all-time volume and nothing else", async () => {
    const { default: Hero } = await import("./components/Hero.jsx");
    render(
      <CollectionProvider slug="nakamigos">
        <Hero stats={cachedStats} tokens={[]} onPick={() => {}} />
      </CollectionProvider>,
    );
    const tags = screen.getAllByTitle(/cached estimate/i);
    expect(tags).toHaveLength(1);
    expect(tags[0].closest(".stat-label")).toHaveTextContent(/all-time vol/i);
  });

  it("Hero leaves a live volume untagged", async () => {
    const { default: Hero } = await import("./components/Hero.jsx");
    render(
      <CollectionProvider slug="nakamigos">
        <Hero stats={liveStats} tokens={[]} onPick={() => {}} />
      </CollectionProvider>,
    );
    expect(screen.queryAllByTitle(/cached estimate/i)).toHaveLength(0);
  });

  it("About tags total volume only when the number is the stand-in", async () => {
    const { default: About } = await import("./components/About.jsx");
    const { rerender } = render(
      <CollectionProvider slug="nakamigos">
        <About stats={cachedStats} onNavigateGallery={() => {}} onFilterGallery={() => {}} />
      </CollectionProvider>,
    );
    expect(screen.getAllByTitle(/cached estimate/i)).toHaveLength(1);

    rerender(
      <CollectionProvider slug="nakamigos">
        <About stats={liveStats} onNavigateGallery={() => {}} onFilterGallery={() => {}} />
      </CollectionProvider>,
    );
    expect(screen.queryAllByTitle(/cached estimate/i)).toHaveLength(0);
  });
});
