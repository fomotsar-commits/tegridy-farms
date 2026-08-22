import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import BidManager from "./BidManager";
import { CollectionProvider } from "../contexts/CollectionContext";

// The public collection bid wall needs no wallet — useCollectionOffers keys on
// the collection slug, not an address (hooks/useOffers.js:7-18). Commit a8b985d0
// added it to the `if (!wallet)` early return only, so CONNECTING a wallet
// stripped public read-only data off the page. The comment at BidManager.jsx
// :517-522 describes the intent ("show the bid wall to everyone"), not what
// shipped. These tests pin the intent.

vi.mock("../hooks/useOffers", () => ({
  useCollectionOffers: () => ({ data: [], isLoading: false, refetch: () => {} }),
  useTraitOffers: () => ({ data: {}, isLoading: false, refetch: () => {} }),
}));
vi.mock("../api", () => ({
  getProvider: () => null,
  fetchWalletNfts: () => Promise.resolve({ tokens: [] }),
  shortenAddress: (a) => a,
}));
vi.mock("../api-offers", () => ({
  fetchTokenOffers: () => Promise.resolve([]),
  acceptOffer: () => Promise.resolve({}),
}));
vi.mock("../lib/proxy", () => ({
  openseaGet: () => Promise.resolve({ orders: [] }),
}));
vi.mock("../contexts/WalletContext", () => ({
  useWalletState: () => ({ isWrongNetwork: false }),
  useWalletActions: () => ({ switchChain: () => {} }),
}));

const PANEL_HEADER = "OFFERS & BIDS"; // CollectionOffersPanel.jsx:53

let mounted = [];
function renderBidManager(wallet) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <CollectionProvider slug="nakamigos">
        <BidManager
          wallet={wallet}
          onConnect={() => {}}
          addToast={() => {}}
          onPick={() => {}}
          tokens={[]}
        />
      </CollectionProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

afterEach(() => {
  mounted.forEach(({ root, container }) => {
    act(() => root.unmount());
    container.remove();
  });
  mounted = [];
});

describe("BidManager public bid wall", () => {
  // Control case: passes pre-fix. Proves the selector can find the panel at
  // all, so a green connected case cannot be a false green from a bad query.
  it("shows the public bid wall to a disconnected visitor", () => {
    const c = renderBidManager(null);
    expect(c.textContent).toContain(PANEL_HEADER);
  });

  it("still shows it once a wallet is connected", () => {
    const c = renderBidManager("0x9999999999999999999999999999999999999999");
    // Proves we rendered the CONNECTED branch, not the connect gate.
    expect(c.textContent).toContain("Bid Manager");
    expect(c.textContent).toContain(PANEL_HEADER);
  });
});
