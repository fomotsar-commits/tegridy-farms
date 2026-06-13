import { describe, it, expect, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { CollectionProvider } from "./CollectionContext";
import { CartProvider, useCart } from "./CartContext";

// Regression guard for F633: the Rarity Sniper "+ Cart" passes a raw listing
// that carries `tokenId` but not `id`. Before the fix, addToCart deduped on
// String(n.id) — so two keyless adds collided on "undefined" and a single
// removeFromCart(undefined) wiped every keyless item at once. The cart key is
// now `id ?? tokenId`, so token-shaped and listing-shaped payloads behave.

function renderCart() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let api;
  function Probe() {
    api = useCart();
    return null;
  }
  act(() => {
    root.render(
      <CollectionProvider slug="nakamigos">
        <CartProvider>
          <Probe />
        </CartProvider>
      </CollectionProvider>,
    );
  });
  return {
    get api() { return api; },
    cleanup() { act(() => root.unmount()); container.remove(); },
  };
}

describe("CartContext key normalization (F633)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("dedupes a tokenId-only payload (no id) instead of colliding on undefined", () => {
    const h = renderCart();
    act(() => h.api.addToCart({ tokenId: "1170", price: 0.1 }));
    act(() => h.api.addToCart({ tokenId: "1170", price: 0.1 }));
    expect(h.api.cartCount).toBe(1);
    h.cleanup();
  });

  it("keeps two distinct tokenId-only payloads (no collision on undefined)", () => {
    const h = renderCart();
    act(() => h.api.addToCart({ tokenId: "1170" }));
    act(() => h.api.addToCart({ tokenId: "2346" }));
    expect(h.api.cartCount).toBe(2);
    h.cleanup();
  });

  it("removeFromCart(tokenId) removes only that item, not every keyless item", () => {
    const h = renderCart();
    act(() => h.api.addToCart({ tokenId: "1170" }));
    act(() => h.api.addToCart({ tokenId: "2346" }));
    act(() => h.api.removeFromCart("1170"));
    expect(h.api.cartCount).toBe(1);
    expect(h.api.cart[0].tokenId).toBe("2346");
    h.cleanup();
  });

  it("dedupes across an id-keyed and a tokenId-keyed payload for the same token", () => {
    const h = renderCart();
    act(() => h.api.addToCart({ id: "1170", name: "#1170" }));
    act(() => h.api.addToCart({ tokenId: "1170", price: 0.1 }));
    expect(h.api.cartCount).toBe(1);
    h.cleanup();
  });
});
