import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CollectionProvider } from "./contexts/CollectionContext";
import { CONTRACT } from "./constants";

// Render-level read-honesty for the two panels that consume fetchListings.
//
// listingsOutageHonesty.test.js pins what fetchListings RETURNS during an
// outage: { listings: [], source: null, error }. This file pins what the two
// consumers PAINT from it. Both read only `.listings` before this fix, so an
// unread feed and an empty market were the same [] to them, and the outage
// rendered as a set of confident claims: "0.0%" listed, "0 of 20,000", a green
// "OK Listings" chip, +20 on the composite health score, and a floor panel
// stating "No active listings to measure."
//
// Only the NETWORK BOUNDARY is faked — ./lib/proxy for OpenSea and global
// `fetch` for /api/orderbook. The real api.js, the real fetchNativeListings and
// the real components run, so this pins what the Analytics tab actually paints.
//
// Every leg here is chosen to be SLEEP-FREE so the tests need no fake timers:
// the mocked openseaGet rejects with a plain Error (api.js retries only
// ApiError.isRetryable / TypeError), and the orderbook's `empty` and `degraded`
// answers are both single-shot. The retrying network-failure path already has
// api-level coverage in listingsOutageHonesty.test.js.

// jsdom has no 2D canvas without the optional `canvas` package, and
// CollectionHealth's Sparkline calls ctx.scale() unconditionally.
beforeAll(() => {
  const noop = () => {};
  HTMLCanvasElement.prototype.getContext = () => ({
    scale: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    closePath: noop, stroke: noop, fill: noop, arc: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    set fillStyle(_v) {}, set strokeStyle(_v) {}, set lineWidth(_v) {},
  });
});

const state = vi.hoisted(() => ({ openseaGet: null }));

vi.mock("./lib/proxy", async (importOriginal) => {
  const actual = await importOriginal();
  const down = vi.fn(async () => {
    throw new Error("proxy down");
  });
  return {
    ...actual,
    alchemyGet: down,
    alchemyPost: down,
    openseaPost: down,
    openseaGet: vi.fn((...args) => state.openseaGet(...args)),
  };
});

import CollectionHealth from "./components/CollectionHealth.jsx";
import MarketIntegrity from "./components/MarketIntegrity.jsx";

const SUPPLY = 20000;

const json = (body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const OS = {
  // A plain Error, so api.js's withRetry classifies it as non-retryable and
  // nothing sleeps. The listings page was still never read.
  down: async () => {
    throw new Error("OpenSea unavailable");
  },
  empty: async () => ({ listings: [], next: null }),
};

const BOOK = {
  // api/orderbook.js answers an unreachable database with a 200, an EMPTY list
  // and `degraded: true` rather than an error status.
  degraded: () => vi.fn(async () => json({ orders: [], count: 0, degraded: true })),
  empty: () => vi.fn(async () => json({ orders: [], count: 0 })),
};

function setup({ os, book }) {
  state.openseaGet = OS[os];
  vi.stubGlobal("fetch", BOOK[book]());
}

// The two worlds under test. They differ ONLY in whether the sources were read.
const OUTAGE = { os: "down", book: "empty" }; // OpenSea unread beside an empty book
const BOTH_DOWN = { os: "down", book: "degraded" }; // neither source read
const REAL_EMPTY = { os: "empty", book: "empty" }; // both read, nothing listed

const health = () => (
  <CollectionProvider slug="nakamigos">
    <CollectionHealth
      stats={{ supply: SUPPLY, floor: 1, volume: null, owners: null }}
      activities={[]}
    />
  </CollectionProvider>
);

const integrity = () => (
  <CollectionProvider slug="nakamigos">
    <MarketIntegrity stats={{ supply: SUPPLY }} />
  </CollectionProvider>
);

// The composite score lives in the HealthCircle's first <text>.
function readScore(container) {
  const node = container.querySelector("svg text");
  expect(node, "health score text node").not.toBeNull();
  return Number(node.textContent);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  state.openseaGet = null;
});

describe("CollectionHealth does not publish listing numbers it never read", () => {
  it("an unread listings feed renders the unknown state, not 0.0% of supply", async () => {
    setup(OUTAGE);
    render(health());

    // Out of the loading skeleton.
    expect(await screen.findByText(/LISTED %/i)).toBeInTheDocument();

    // The claims that used to be published from an empty array.
    expect(screen.queryByText(/^0\.0%$/)).toBeNull();
    expect(screen.queryByText(/0 of 20,000/)).toBeNull();

    // What replaces them.
    expect(screen.getAllByText(/listing data unavailable/i).length).toBeGreaterThan(0);
  });

  it("the Listings chip goes neutral instead of green", async () => {
    setup(OUTAGE);
    render(health());
    expect(await screen.findByText(/LISTED %/i)).toBeInTheDocument();

    // The chip renders as "<mark> Listings". Pre-fix it was the green check.
    const chip = screen.getByText(/Listings$/);
    expect(chip.textContent).not.toContain("✓");
    expect(chip.textContent).toContain("—");
  });

  it("ACTIVE LISTINGS shows an em dash, not a count of zero", async () => {
    setup(OUTAGE);
    render(health());
    expect(await screen.findByText(/ACTIVE LISTINGS/i)).toBeInTheDocument();

    const tile = screen.getByText(/ACTIVE LISTINGS/i).parentElement;
    expect(tile.textContent).toContain("—");
    expect(tile.textContent).not.toMatch(/\b0\b/);
  });

  it("Floor Depth names the outage rather than reusing the empty-market copy", async () => {
    setup(OUTAGE);
    render(health());
    // The panel heading renders in both worlds, so the assertion that follows
    // fails on a VALUE rather than timing out waiting for copy that is absent.
    expect(await screen.findByRole("heading", { name: /Floor Depth/i })).toBeInTheDocument();
    expect(screen.getByText(/floor depth not measured/i)).toBeInTheDocument();
  });

  it("the composite score drops the listing rate instead of scoring it as zero", async () => {
    // Same component, same props, same everything except whether the listings
    // sources answered. Pre-fix both scored the full +20 "under 5% listed"
    // bonus, so an outage RAISED the health score.
    setup(REAL_EMPTY);
    const readEmpty = render(health());
    expect(await screen.findByText(/LISTED %/i)).toBeInTheDocument();
    const emptyScore = readScore(readEmpty.container);
    cleanup();
    vi.unstubAllGlobals();

    setup(OUTAGE);
    const outage = render(health());
    expect(await screen.findByText(/LISTED %/i)).toBeInTheDocument();
    const outageScore = readScore(outage.container);

    expect(outageScore).toBeLessThan(emptyScore);
    expect(screen.getByText(/Listing rate is excluded from this score/i)).toBeInTheDocument();
  });

  it("both sources unread reads the same way as one", async () => {
    setup(BOTH_DOWN);
    render(health());
    expect(await screen.findByText(/LISTED %/i)).toBeInTheDocument();
    expect(screen.queryByText(/^0\.0%$/)).toBeNull();
    expect(screen.getAllByText(/listing data unavailable/i).length).toBeGreaterThan(0);
  });

  // ── The counter-test: a market that really is empty must still say so ──
  it("a read-empty market still renders 0.0% and a green chip", async () => {
    setup(REAL_EMPTY);
    render(health());
    expect(await screen.findByText(/LISTED %/i)).toBeInTheDocument();

    // Both sources answered and nothing is listed: that zero was READ, and
    // suppressing it would be its own dishonesty.
    expect(screen.getByText(/^0\.0%$/)).toBeInTheDocument();
    expect(screen.getByText(/0 of 20,000/)).toBeInTheDocument();
    expect(screen.getByText(/Listings$/).textContent).toContain("✓");
    expect(screen.queryByText(/listing data unavailable/i)).toBeNull();
    expect(screen.queryByText(/floor depth not measured/i)).toBeNull();
    expect(screen.queryByText(/Listing rate is excluded from this score/i)).toBeNull();
  });
});

describe("MarketIntegrity does not measure a book it never read", () => {
  it("an unread listings feed is named, not reported as no active listings", async () => {
    setup(OUTAGE);
    render(integrity());

    expect(await screen.findByRole("heading", { name: /^Floor concentration$/i })).toBeInTheDocument();
    // The panel-level banner, beside the sales and owners flags it now joins.
    expect(screen.getByText(/floor concentration is not measured/i)).toBeInTheDocument();
    // The section's own reason, which used to read "No active listings".
    expect(screen.getByText("Listing data unavailable — floor concentration not measured.")).toBeInTheDocument();
    expect(screen.queryByText(/No active listings to measure/i)).toBeNull();
  });

  it("the coverage-gap roll-up calls it an outage, not an empty book", async () => {
    setup(OUTAGE);
    render(integrity());
    expect(await screen.findByText(/Coverage gaps:/i)).toBeInTheDocument();
    expect(screen.getByText(/Coverage gaps:/i).textContent).toContain("listing data unavailable");
  });

  // ── The counter-test ──
  it("a read-empty book still reports No active listings to measure", async () => {
    setup(REAL_EMPTY);
    render(integrity());

    expect(await screen.findByRole("heading", { name: /^Floor concentration$/i })).toBeInTheDocument();
    expect(screen.getByText("No active listings to measure.")).toBeInTheDocument();
    expect(screen.queryByText(/floor concentration is not measured/i)).toBeNull();
    expect(screen.queryByText(/Listing data unavailable/i)).toBeNull();
  });
});

// Guards the assumption every leg above rests on: the orderbook really was
// asked, through the real fetchNativeListings, at the URL production uses.
describe("the orderbook boundary these tests fake", () => {
  it("is queried for the active collection's contract", async () => {
    setup(REAL_EMPTY);
    render(health());
    expect(await screen.findByText(/LISTED %/i)).toBeInTheDocument();

    expect(fetch).toHaveBeenCalled();
    for (const [url] of fetch.mock.calls) {
      expect(String(url)).toMatch(/^\/api\/orderbook\?/);
      expect(String(url)).toContain(`contract=${CONTRACT}`);
    }
  });
});
