// A token's sales history that could not be read is not a token with no sales.
//
// The detail Modal's price history reads Alchemy getNFTSales for one token.
// fetchTokenSalesHistory answered a failed read with [], the same value as a
// token that has never sold, and the Modal printed "No sales history for this
// token" for both. On Gold Cards the preview log showed getNFTSales answering
// 502 again and again while every Gold modal said the token had no sales.
// These cases pin the two apart: at the reader, and on the Modal.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CollectionProvider } from "./contexts/CollectionContext";
import { TradingModeProvider } from "./contexts/TradingModeContext";
import { COLLECTIONS } from "./constants";

const h = vi.hoisted(() => ({ alchemyGet: null, salesHistory: null }));

vi.mock("./lib/proxy", async (importOriginal) => ({
  ...(await importOriginal()),
  alchemyGet: (...a) => h.alchemyGet(...a),
  alchemyPost: vi.fn(async () => { throw new Error("alchemy down"); }),
  openseaGet: vi.fn(async () => ({ orders: [] })),
}));
vi.mock("./contexts/WalletContext", () => {
  const state = { address: null, isConnected: false, walletName: null, isWrongNetwork: false };
  const actions = { connectWallet: () => {}, disconnect: () => {}, switchChain: () => {} };
  const ui = { isPending: false, connectError: null, availableConnectors: [], isSwitching: false };
  return {
    WalletProvider: ({ children }) => children,
    useWalletState: () => state,
    useWalletActions: () => actions,
    useWalletUI: () => ui,
    useWallet: () => ({ ...state, ...actions, ...ui }),
    config: null,
    HAS_WC_PROJECT_ID: false,
  };
});
vi.mock("./hooks/useEns", () => ({ default: () => ({ ensName: null }) }));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchTokenSalesHistory: (...a) => h.salesHistory(...a),
  fulfillSeaportOrder: vi.fn(),
}));
vi.mock("./api-offers", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchTokenOfferBook: vi.fn(async () => ({ best: null, offers: [], fallback: false })),
}));

// Rendering the real Modal costs a first import of several seconds.
vi.setConfig({ testTimeout: 30000 });

beforeEach(() => {
  h.alchemyGet = vi.fn(async () => { throw new Error("alchemy down"); });
  h.salesHistory = vi.fn(async () => []);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => "{}", json: async () => ({}) })));
  window.matchMedia = (q) => ({
    matches: /prefers-reduced-motion/.test(q), media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
  window.scrollTo = () => {};
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchTokenSalesHistory", () => {
  it("a read that failed is an error, not an empty history", async () => {
    const { fetchTokenSalesHistory } = await vi.importActual("./api");
    await expect(fetchTokenSalesHistory("6", COLLECTIONS.junglebaygoldcards.contract)).rejects.toThrow();
  });

  it("a read that answered with no sales is an empty history", async () => {
    h.alchemyGet = vi.fn(async () => ({ nftSales: [] }));
    const { fetchTokenSalesHistory } = await vi.importActual("./api");
    await expect(fetchTokenSalesHistory("6", COLLECTIONS.junglebaygoldcards.contract)).resolves.toEqual([]);
  });
});

async function renderGoldModal() {
  const { default: Modal } = await import("./components/Modal.jsx");
  const nft = {
    id: "6", name: "JungleBay Gold Card #6", image: null, attributes: [], owner: null,
    contract: COLLECTIONS.junglebaygoldcards.contract.toLowerCase(), price: null, lastSale: null, rank: null,
  };
  render(
    <MemoryRouter>
      <TradingModeProvider>
        <CollectionProvider slug="junglebaygoldcards">
          <Modal
            nft={nft}
            onClose={() => {}}
            isFavorite={false}
            onToggleFavorite={() => {}}
            wallet={null}
            onConnect={() => {}}
            addToast={() => {}}
            onTheater={() => {}}
            onShare={() => {}}
            onViewProfile={() => {}}
            floorPrice={null}
            statsSupply={123}
            allTokens={[]}
            onList={() => {}}
          />
        </CollectionProvider>
      </TradingModeProvider>
    </MemoryRouter>,
  );
  await screen.findByRole("dialog");
}

describe("the detail Modal's price history", () => {
  it("says the history could not be read when the read failed, never that there are no sales", async () => {
    h.salesHistory = vi.fn(async () => { throw new Error("getNFTSales 502"); });
    await renderGoldModal();
    await waitFor(() => expect(screen.getByText(/Sales history for this token is unavailable right now/)).toBeInTheDocument());
    expect(screen.queryByText(/No sales history for this token/)).toBeNull();
  });

  it("control: a token that has never sold still says so", async () => {
    h.salesHistory = vi.fn(async () => []);
    await renderGoldModal();
    await waitFor(() => expect(screen.getByText(/No sales history for this token/)).toBeInTheDocument());
    expect(screen.queryByText(/unavailable right now/)).toBeNull();
  });
});
