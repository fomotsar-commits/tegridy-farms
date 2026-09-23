import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, within, cleanup } from "@testing-library/react";

// The cart offers only what can be bought.
//
// Every Gold Cards gallery card offered "Add to cart" (always visible on a
// touch screen), while no Gold Card is listed: OpenSea's floor is null. The
// cart it produced said "NO ORDER, 1 ITEM (1 NOT PURCHASABLE)", a total of
// 0.0000 ETH and a Connect Wallet button, an action that cannot complete.
// The gallery merges each token's live listing onto it (Gallery.jsx), so a
// card with no price has no order to buy. Only the virtualizer and the
// wallet are faked; the real grid and cart render.

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 352, size: 352 })),
    getTotalSize: () => count * 352,
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}));

vi.mock("./contexts/WalletContext", () => ({
  useWallet: () => ({ isWrongNetwork: false, address: null, isConnected: false }),
  useWalletState: () => ({ isWrongNetwork: false, address: null, isConnected: false }),
  useWalletActions: () => ({ switchChain: vi.fn(), connect: vi.fn(), disconnect: vi.fn() }),
  useWalletUI: () => ({ openConnectModal: null }),
}));

// A cold import of the grid or the cart takes seconds when the whole suite
// runs in parallel; the default 5 s budget is not about what is tested here.
vi.setConfig({ testTimeout: 30000 });

let realMatchMedia;

beforeEach(() => {
  vi.resetModules();
  realMatchMedia = window.matchMedia;
  // A touch screen: no hover, so the grid shows its cart button without one.
  window.matchMedia = (q) => ({
    matches: /hover: none/.test(q), media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
  globalThis.ResizeObserver = globalThis.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
});

afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

const UNLISTED = { id: "1", name: "JungleBay Gold Card #1", price: null, attributes: [] };
const LISTED = { id: "2", name: "JungleBay Gold Card #2", price: 0.5, orderHash: "0xabc", attributes: [] };

describe("the gallery offers Add to cart only for a token with a live listing", () => {
  it("an unlisted card has no cart button; a listed one keeps it", async () => {
    // Imported after resetModules, with the providers, so they share one context.
    const { default: VirtualGalleryGrid } = await import("./components/VirtualGalleryGrid.jsx");
    const { CollectionProvider } = await import("./contexts/CollectionContext");
    const { TradingModeProvider } = await import("./contexts/TradingModeContext");
    render(
      <CollectionProvider slug="junglebaygoldcards">
        <TradingModeProvider>
          <VirtualGalleryGrid tokens={[UNLISTED, LISTED]} loading={false} onPick={() => {}} viewMode="gallery"
            favorites={[]} onToggleFavorite={() => {}} hasMore={false} onLoadMore={() => {}} cart={[]} onAddToCart={() => {}} />
        </TradingModeProvider>
      </CollectionProvider>,
    );
    const cardOf = (id) => document.querySelector(`[data-token-id="${id}"]`);
    expect(cardOf("1"), "no card for #1").toBeTruthy();
    expect(cardOf("2"), "no card for #2").toBeTruthy();
    expect(within(cardOf("1")).queryByRole("button", { name: "Add to cart" })).toBeNull();
    expect(within(cardOf("2")).getByRole("button", { name: "Add to cart" })).toBeInTheDocument();
  });
});

describe("a cart with nothing that can be bought says so", () => {
  async function renderCart(cart) {
    const { default: ShoppingCart } = await import("./components/ShoppingCart.jsx");
    const { CollectionProvider } = await import("./contexts/CollectionContext");
    return render(
      <CollectionProvider slug="junglebaygoldcards">
        <ShoppingCart cart={cart} onRemove={() => {}} onClear={() => {}} onClose={() => {}} wallet={null}
          onConnect={() => {}} addToast={() => {}} isOpen listings={[]} onRefreshCart={() => {}} />
      </CollectionProvider>,
    );
  }

  // Each case reads only its own render, so nothing another case left on the
  // page can satisfy or break it.
  it("shows no total and no buy or connect button, and says nothing here can be bought", async () => {
    const { container } = await renderCart([UNLISTED]);
    const cart = within(container);
    expect(cart.getByText(/nothing in the cart can be bought/i)).toBeInTheDocument();
    expect(cart.queryByText(/0[.]0000/)).toBeNull();
    expect(cart.queryByRole("button", { name: /sweep all|connect wallet/i })).toBeNull();
  });

  it("positive control: a cart with a listed item keeps its total and its button", async () => {
    const { container } = await renderCart([LISTED]);
    const cart = within(container);
    expect(cart.queryByText(/nothing in the cart can be bought/i)).toBeNull();
    expect(cart.getByRole("button", { name: /connect wallet/i })).toBeInTheDocument();
  });
});
