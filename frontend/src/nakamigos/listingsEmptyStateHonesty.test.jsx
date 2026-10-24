import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CollectionProvider } from "./contexts/CollectionContext";
import { TradingModeProvider } from "./contexts/TradingModeContext";
import Listings from "./components/Listings.jsx";

// The Floor tab says "No Listings Available" only after a listings read that
// answered. When the read failed, fetchListings returns
// { listings: [], source: null, error }, and the page said both "Listing data
// for Jungle Bay Gold Cards temporarily unavailable." and "There are currently
// no active listings for Jungle Bay Gold Cards." The second is a count of zero
// the read never produced. Only the network boundary is faked.

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

vi.mock("./lib/proxy", async (importOriginal) => {
  const actual = await importOriginal();
  const down = vi.fn(async () => { throw new Error("offline in test"); });
  return { ...actual, alchemyGet: down, alchemyPost: down, openseaGet: down, openseaPost: down };
});

vi.mock("./contexts/WalletContext", () => ({
  useWallet: () => ({ isWrongNetwork: false, address: null, isConnected: false }),
  useWalletState: () => ({ isWrongNetwork: false, address: null, isConnected: false }),
  useWalletActions: () => ({ switchChain: vi.fn(), connect: vi.fn(), disconnect: vi.fn() }),
  useWalletUI: () => ({ openConnectModal: null }),
}));

afterEach(cleanup);

const UNREAD = "Listing data temporarily unavailable. Please try again shortly.";

function renderFloor({ listingsSource, listingsError, activitiesEmpty = false }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CollectionProvider slug="junglebaygoldcards">
        <TradingModeProvider>
          <Listings
            tokens={[]}
            stats={{ supply: 123, owners: 97, floor: null }}
            listings={[]}
            listingsLoading={false}
            listingsError={listingsError}
            listingsSource={listingsSource}
            activities={[]}
            activitiesLoading={false}
            activitiesEmpty={activitiesEmpty}
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

const page = () => (document.body.textContent || "").replace(/\s+/g, " ");

describe("the Floor tab after a listings read that failed", () => {
  it("says the listing data is unavailable, and never that there are no listings", () => {
    renderFloor({ listingsSource: null, listingsError: UNREAD });
    expect(page()).toMatch(/Listing data for Jungle Bay Gold Cards temporarily unavailable\./);
    expect(screen.queryByText("No Listings Available")).toBeNull();
    expect(page()).not.toMatch(/no active listings/i);
  });

  it("still links to the collection on OpenSea", () => {
    renderFloor({ listingsSource: null, listingsError: UNREAD });
    const links = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toContain("https://opensea.io/collection/junglebaygoldcards");
  });
});

describe("the Floor tab after a listings read that answered empty", () => {
  it("says No Listings Available", () => {
    renderFloor({ listingsSource: "opensea", listingsError: null });
    expect(screen.getByText("No Listings Available")).toBeInTheDocument();
    expect(page()).toMatch(/There are currently no active listings for Jungle Bay Gold Cards\./);
  });
});
