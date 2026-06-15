import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import NativeListingsList from "./components/NativeListingsList";

// #8: the native order book renders a 6-col table on desktop but stacked cards
// on phones (<=640px) so it stops horizontally scrolling. The data is
// /api/orderbook-backed (no rows on the dev server), so these render tests are
// the source of truth for the responsive layout.

const WALLET = "0x9999999999999999999999999999999999999999";
const ORDERS = [
  { order_hash: "0xaaa", token_id: "1234", price_eth: "0.105", maker: "0x1111111111111111111111111111111111111111", created_at: new Date().toISOString(), status: "active" },
  { order_hash: "0xbbb", token_id: "5678", price_eth: "0.2", maker: "0x2222222222222222222222222222222222222222", created_at: new Date().toISOString(), status: "active" },
];

let mounted = [];
function renderList(extra = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <NativeListingsList
        orders={ORDERS}
        wallet={WALLET}
        buying={null}
        cancelling={null}
        onBuy={() => {}}
        onCancel={() => {}}
        {...extra}
      />
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

describe("NativeListingsList", () => {
  it("renders a scrolling TABLE on wide viewports", () => {
    const c = renderList({ isNarrow: false });
    expect(c.querySelector("table")).toBeTruthy();
    expect(c.querySelector('[data-testid="orderbook-cards"]')).toBeNull();
    expect(c.querySelectorAll("tbody tr").length).toBe(2);
    expect(c.textContent).toContain("#1234");
    expect(c.textContent).toContain("0.1050"); // price formatted to 4dp
  });

  it("renders stacked CARDS (no table) on narrow viewports", () => {
    const c = renderList({ isNarrow: true });
    expect(c.querySelector("table")).toBeNull();
    const cards = c.querySelector('[data-testid="orderbook-cards"]');
    expect(cards).toBeTruthy();
    expect(cards.children.length).toBe(2); // one card per order
    expect(c.textContent).toContain("#5678");
    expect(c.textContent).toContain("0.2000");
    // each card carries an action button labelled Buy (wallet connected, not mine)
    const buttons = c.querySelectorAll("button");
    expect(buttons.length).toBe(2);
    expect(Array.from(buttons).every((b) => /Buy/.test(b.textContent))).toBe(true);
  });

  it("shows Cancel + 'You' for the connected wallet's own listing (both layouts)", () => {
    const mineOnly = { orders: [{ ...ORDERS[0], maker: WALLET }] };
    const narrow = renderList({ isNarrow: true, ...mineOnly });
    expect(narrow.textContent).toContain("Cancel");
    expect(narrow.textContent).toContain("You");
    const wide = renderList({ isNarrow: false, ...mineOnly });
    expect(wide.querySelector("table")).toBeTruthy();
    expect(wide.textContent).toContain("Cancel");
  });
});
