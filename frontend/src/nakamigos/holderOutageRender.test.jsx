import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { CollectionProvider } from "./contexts/CollectionContext";

// jsdom has no 2D canvas without the optional `canvas` package, and
// CollectionHealth's Sparkline calls ctx.scale() unconditionally. Stub the
// context so the environment gap doesn't masquerade as a component failure.
beforeAll(() => {
  const noop = () => {};
  HTMLCanvasElement.prototype.getContext = () => ({
    scale: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    closePath: noop, stroke: noop, fill: noop, arc: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    set fillStyle(_v) {}, set strokeStyle(_v) {}, set lineWidth(_v) {},
  });
});

// Render-level proof for the holder-fabrication fix. Only the NETWORK BOUNDARY
// is faked — the real api.js error path and the real components run — so this
// pins what the Analytics tab actually paints during an Alchemy outage rather
// than what a mocked fetcher was told to return.
vi.mock("./lib/proxy", async (importOriginal) => {
  const actual = await importOriginal();
  const down = vi.fn(async () => {
    throw new Error("proxy down");
  });
  return { ...actual, alchemyGet: down, alchemyPost: down, openseaGet: down, openseaPost: down };
});

const NAKA_SUPPLY = 20000;

describe("holder outage renders no fabricated statistics", () => {
  it("HolderAnalytics names the outage and shows no derived numbers", async () => {
    const { default: HolderAnalytics } = await import("./components/HolderAnalytics.jsx");
    render(
      <CollectionProvider slug="nakamigos">
        <HolderAnalytics supply={NAKA_SUPPLY} />
      </CollectionProvider>,
    );

    expect(await screen.findByText(/holder data unavailable/i)).toBeInTheDocument();
    // The invariant: NONE of the derived aggregates may render. Their tile
    // labels only exist when `stats` is non-null, i.e. when holders is non-empty.
    expect(screen.queryByText(/avg held/i)).toBeNull();
    expect(screen.queryByText(/whales \(50\+\)/i)).toBeNull();
    expect(screen.queryByText(/top 10 own/i)).toBeNull();
    expect(screen.queryByText(/showing top \d+ holders/i)).toBeNull();
    // And nothing anywhere may state a holder count.
    expect(screen.queryByText(/\b\d+(\.\d+)?\s*%/)).toBeNull();
  });

  it("CollectionHealth whale concentration self-gates to its honest branch", async () => {
    const { default: CollectionHealth } = await import("./components/CollectionHealth.jsx");
    render(
      <CollectionProvider slug="nakamigos">
        <CollectionHealth
          stats={{ supply: NAKA_SUPPLY, floor: null, volume: null, owners: null }}
          activities={[]}
        />
      </CollectionProvider>,
    );

    // CollectionHealth also awaits the listings feed, which walks its own
    // fallback chain before resolving — allow for that before asserting.
    expect(await screen.findByText(/no holder data available/i, undefined, { timeout: 15000 })).toBeInTheDocument();
    // The fabricated-and-flattering pair: a green "1.7% of supply held by top 10"
    // and "Top 10 hold 338 of 20,000 total".
    expect(screen.queryByText(/of supply held by top 10/i)).toBeNull();
    expect(screen.queryByText(/top 10 hold/i)).toBeNull();
  }, 20000);
});
