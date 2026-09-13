import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CollectionProvider } from "./contexts/CollectionContext";
import { TradingModeProvider } from "./contexts/TradingModeContext";
import Listings from "./components/Listings.jsx";

// ═══ A partial listings set must not be published as a whole-market count ═══
//
// `fetchListings` merges OpenSea page 1 with the native orderbook, and
// `mergeListings` (api.js:833-843) labels the result by what actually landed in
// it: "merged" when both venues contributed, "opensea" when only OpenSea did,
// and "native" when NO OpenSea listing is in the set. That last case is the
// partial one — OpenSea's page failed and was .catch()'d to an empty array, so
// the native book is the only venue read. Keeping those native listings is
// deliberate (they are real and buyable; pinned by listingsOutageHonesty.test.js,
// PR #535) and must stay.
//
// The defect is what the page then SAYS about them. Both headline claims were
// computed from `listedNfts.length` with no regard for `listingsSource`:
//   · the subtitle — "N <collection> currently listed for sale across
//     marketplaces", which names every marketplace while holding one venue;
//   · the LISTED tile — that same N over `stats.supply` as a percentage.
// On a 20,000-supply collection whose OpenSea book holds ~1000 listings, an
// OpenSea outage rendered "3 Nakamigos currently listed for sale across
// marketplaces" and "3 (0.0%)". The green "LIVE — Real active listings via
// native" banner named the source correctly and the headline contradicted it.
//
// THE INVARIANT, and why it is phrased the way it is: the copy may not claim
// coverage the set does not have, and no supply-wide percentage may be derived
// from it. It deliberately does NOT assert "OpenSea is down" — source==="native"
// means only that no OpenSea listing is in the set, which a genuinely empty
// OpenSea book also produces. Naming the scope of the count is true either way;
// naming an outage would be a fresh false claim in the other direction.
//
// Scope is decided per claim, and both directions are pinned here. FLOOR PRICE,
// OWNERS and SUPPLY read `stats`, not `listings`, so they are NOT marked — a
// blanket "some of this is partial" would be its own dishonesty. Family B (the
// "merged"/"opensea" cases) is the anti-overreach guard: it passes both before
// and after, so a future pass that silences the healthy copy goes red.

// jsdom has no 2D canvas without the optional `canvas` package; DepthChart and
// the sweep depth bars draw unconditionally. Stub it so the environment gap
// cannot masquerade as a component failure.
beforeAll(() => {
  const noop = () => {};
  HTMLCanvasElement.prototype.getContext = () => ({
    scale: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    closePath: noop, stroke: noop, fill: noop, arc: noop, fillRect: noop,
    fillText: noop, measureText: () => ({ width: 0 }), setLineDash: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    set fillStyle(_v) {}, set strokeStyle(_v) {}, set lineWidth(_v) {}, set font(_v) {},
  });
});

// Only the NETWORK BOUNDARY is faked — the real Listings/SweepCalculator run.
vi.mock("./lib/proxy", async (importOriginal) => {
  const actual = await importOriginal();
  const down = vi.fn(async () => { throw new Error("offline in test"); });
  return { ...actual, alchemyGet: down, alchemyPost: down, openseaGet: down, openseaPost: down };
});

// SweepCalculator/OrderBookPanel read the wallet only for network state; the
// real provider needs the parent wagmi tree, which is not what is under test.
vi.mock("./contexts/WalletContext", () => ({
  useWallet: () => ({ isWrongNetwork: false, address: null, isConnected: false }),
  useWalletState: () => ({ isWrongNetwork: false, address: null, isConnected: false }),
  useWalletActions: () => ({ switchChain: vi.fn(), connect: vi.fn(), disconnect: vi.fn() }),
  useWalletUI: () => ({ openConnectModal: null }),
}));

const SUPPLY = 20000;

function makeListings(n) {
  return Array.from({ length: n }, (_, i) => ({
    tokenId: String(1000 + i),
    price: 0.5 + i * 0.1,
    priceWei: String(BigInt(Math.round((0.5 + i * 0.1) * 1e18))),
    marketplace: "native",
    isNative: true,
    maker: "0x1111111111111111111111111111111111111111",
    orderHash: `0x${i}`,
  }));
}

function renderListings({ listingsSource, count = 3 }) {
  // Offer panels fetch through react-query; retries off so a failed mocked
  // fetch settles inside the test rather than backing off past it.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CollectionProvider slug="nakamigos">
        <TradingModeProvider>
          <Listings
            tokens={[]}
            stats={{ supply: SUPPLY, owners: 5000, floor: 0.5 }}
            listings={makeListings(count)}
            listingsLoading={false}
            listingsError={null}
            listingsSource={listingsSource}
            activities={[]}
            activitiesLoading={false}
            activitiesEmpty
            onPick={() => {}}
            wallet={null}
            onConnect={() => {}}
            addToast={() => {}}
            onAddToCart={() => {}}
            onFilter={() => {}}
          />
        </TradingModeProvider>
      </CollectionProvider>
    </QueryClientProvider>,
  );
}

// Each claim is addressed through its own element, so an assertion cannot be
// satisfied — or broken — by copy rendered elsewhere on the page.
const subtitle = () => document.querySelector(".listings-subtitle");
const tile = (label) => screen.getByText(label).closest(".listings-stat-card");
const SCOPED = /native book only/i;

beforeEach(() => {
  try { localStorage.clear(); } catch { /* unavailable */ }
});
afterEach(cleanup);

describe("A — a native-only listings set states its own scope", () => {
  it("the subtitle does not claim coverage across marketplaces", () => {
    renderListings({ listingsSource: "native" });
    expect(screen.queryByText(/across marketplaces/i)).toBeNull();
  });

  it("the subtitle names the native orderbook as the scope of the count", () => {
    renderListings({ listingsSource: "native" });
    expect(subtitle()).toHaveTextContent(/native orderbook/i);
  });

  it("the LISTED tile publishes no supply-wide percentage", () => {
    renderListings({ listingsSource: "native" });
    // Pre-fix this tile read "3 (0.0%)" — 3 native listings over a 20,000 supply.
    expect(within(tile("LISTED")).queryByText(/%/)).toBeNull();
    expect(tile("LISTED")).toHaveTextContent(SCOPED);
  });

  it("MEDIAN / AVG is marked as computed from the one venue it was read from", () => {
    renderListings({ listingsSource: "native" });
    expect(tile("MEDIAN / AVG")).toHaveTextContent(SCOPED);
  });

  it("the tiles read from the stats endpoint are left unmarked", () => {
    renderListings({ listingsSource: "native" });
    // FLOOR PRICE / OWNERS / SUPPLY come from `stats`, not from `listings`, so
    // the outage does not reach them. Marking them would be its own dishonesty.
    for (const label of ["FLOOR PRICE", "OWNERS", "SUPPLY"]) {
      expect(tile(label)).not.toHaveTextContent(SCOPED);
    }
    expect(tile("SUPPLY")).toHaveTextContent("20,000");
  });

  it("the native listings themselves are still shown and counted", () => {
    renderListings({ listingsSource: "native" });
    // PRESERVATION: the fix withholds a claim, never the listings.
    expect(within(tile("LISTED")).getByText("3")).toBeInTheDocument();
    expect(subtitle()).toHaveTextContent("3 Nakamigos");
    expect(screen.getByText(/Nakamigos #1000/)).toBeInTheDocument();
    expect(screen.getByText(/LIVE — Real active listings via/)).toBeInTheDocument();
  });

  it("the sweep calculator scopes the floor it says a sweep would move", () => {
    // The sweep is pro-mode only. Six listings so a 5-item sweep leaves a
    // remainder — floorImpact renders only when one exists.
    localStorage.setItem("nakamigos_trading_mode", "pro");
    renderListings({ listingsSource: "native", count: 6 });
    expect(screen.getByText("FLOOR IMPACT (NATIVE BOOK)")).toBeInTheDocument();
    expect(screen.queryByText("FLOOR IMPACT")).toBeNull();
  });
});

describe("B — a merged set keeps the whole-market copy unchanged", () => {
  it("the subtitle still says across marketplaces", () => {
    renderListings({ listingsSource: "merged" });
    expect(screen.getByText(/currently listed for sale across marketplaces/i)).toBeInTheDocument();
  });

  it("the LISTED tile still publishes the supply-wide percentage", () => {
    renderListings({ listingsSource: "merged" });
    expect(within(tile("LISTED")).getByText(/\(0\.0%\)/)).toBeInTheDocument();
  });

  it("an opensea-only set is left alone too", () => {
    renderListings({ listingsSource: "opensea" });
    expect(screen.getByText(/currently listed for sale across marketplaces/i)).toBeInTheDocument();
    expect(within(tile("LISTED")).getByText(/\(0\.0%\)/)).toBeInTheDocument();
  });

  it("no tile is marked, and the sweep keeps its unqualified floor impact", () => {
    localStorage.setItem("nakamigos_trading_mode", "pro");
    renderListings({ listingsSource: "merged", count: 6 });
    for (const label of ["LISTED", "MEDIAN / AVG", "FLOOR PRICE", "OWNERS", "SUPPLY"]) {
      expect(tile(label)).not.toHaveTextContent(SCOPED);
    }
    expect(screen.getByText("FLOOR IMPACT")).toBeInTheDocument();
  });
});
