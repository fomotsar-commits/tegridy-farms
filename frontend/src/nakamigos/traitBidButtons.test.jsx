// OpenSea takes no trait bids on GNSS or the Gold Cards (`trait_offers_enabled`
// false on GET /api/v2/collections/{slug}, read live 2026-11-16), yet every
// trait-bid button was shown on them, and a press built, wrapped and approved
// before OpenSea refused the post (review 2026-11-16 F5). Their trait-bid buttons
// are gone; a collection where OpenSea takes trait bids keeps every one. Only the
// network boundary and the wallet are faked.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CollectionProvider } from "./contexts/CollectionContext";
import { TradingModeProvider } from "./contexts/TradingModeContext";
import Listings from "./components/Listings.jsx";
import TraitExplorer from "./components/TraitExplorer.jsx";
import CollectionOffersPanel from "./components/CollectionOffersPanel.jsx";

const h = vi.hoisted(() => ({ traitBids: [] }));

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
  // The mixed offers feed holds the trait bids the panels list; nothing else answers.
  const openseaGet = vi.fn(async (path) => {
    if (/^offers\/collection\/[^/]+\/all$/.test(path)) return { offers: h.traitBids };
    throw new Error("offline in test");
  });
  return { ...actual, alchemyGet: down, alchemyPost: down, openseaGet, openseaPost: down };
});

vi.mock("./contexts/WalletContext", () => ({
  useWallet: () => ({ isWrongNetwork: false, address: null, isConnected: false }),
  useWalletState: () => ({ isWrongNetwork: false, address: null, isConnected: false }),
  useWalletActions: () => ({ switchChain: vi.fn(), connect: vi.fn(), disconnect: vi.fn() }),
  useWalletUI: () => ({ openConnectModal: null }),
}));

beforeEach(() => { h.traitBids = []; });
afterEach(cleanup);

function inCollection(slug, ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CollectionProvider slug={slug}>
        <TradingModeProvider>{ui}</TradingModeProvider>
      </CollectionProvider>
    </QueryClientProvider>,
  );
}

const TOKENS = [
  { id: "1", name: "#1", image: null, attributes: [{ key: "Fur", value: "Gold" }] },
  { id: "2", name: "#2", image: null, attributes: [{ key: "Fur", value: "Blue" }] },
];
// One live trait bid on Fur: Gold, the way `offers/collection/{slug}/all` lists it.
const traitBid = (slug) => ({
  order_hash: "0x" + "77".repeat(32),
  criteria: { collection: { slug }, trait: { type: "Fur", value: "Gold" } },
  price: { currency: "WETH", decimals: 18, value: "10000000000000000" },
});

for (const [slug, on] of [["junglebay", true], ["gnssart", false], ["junglebaygoldcards", false]]) {
  describe(`${slug}: OpenSea ${on ? "takes" : "takes no"} trait bids`, () => {
    it(`the Floor tab's Trait Offer button is ${on ? "shown" : "not shown"}`, () => {
      inCollection(slug, (
        <Listings
          tokens={TOKENS} stats={{ supply: 2, owners: 2, floor: null }} listings={[]} listingsLoading={false}
          listingsError={null} listingsSource="opensea" activities={[]} activitiesLoading={false} activitiesEmpty
          onPick={() => {}} wallet={null} onConnect={() => {}} addToast={() => {}} onAddToCart={() => {}} onFilter={() => {}}
        />
      ));
      expect(screen.queryByText("Trait Offer") !== null).toBe(on);
    });

    it(`the Traits tab's Offer and Bid on Trait buttons are ${on ? "shown" : "not shown"}`, () => {
      inCollection(slug, (
        <TraitExplorer tokens={TOKENS} listings={[]} stats={{ supply: 2 }} onPick={() => {}} wallet={null} onConnect={() => {}} addToast={() => {}} />
      ));
      expect(screen.queryAllByRole("button", { name: "Offer" }).length > 0).toBe(on);
      fireEvent.click(screen.getByRole("button", { name: "Browse Fur: Gold" }));
      expect(screen.queryByRole("button", { name: /Bid on Trait|Connect & Bid/ }) !== null).toBe(on);
    });

    it(`a live trait bid's row ${on ? "opens" : "does not open"} the offer form`, async () => {
      h.traitBids = [traitBid(slug)];
      inCollection(slug, <CollectionOffersPanel wallet={null} onConnect={() => {}} addToast={() => {}} />);
      fireEvent.click(await screen.findByText("Fur: Gold"));
      expect(screen.queryByRole("dialog", { name: "Make Offer" }) !== null).toBe(on);
    });
  });
}
