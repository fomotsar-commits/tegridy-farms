import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import EmptyState from "./EmptyState";

// MyListings.jsx:611 is the ONLY consumer of this config. That page fetches
// /api/orderbook?action=query&maker=… (MyListings.jsx:268-292) and stamps every
// row source:"native" (:323); the server handler reads only the Supabase
// `orders` table (api/orderbook.js:480-519) and never calls OpenSea. So an
// OpenSea listing cannot reach this page — telling the seller to list there is
// an instruction that can only end in "No active listings" a second time.

let mounted = [];
function render(el) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(el));
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

describe("myListings empty state", () => {
  it("does not send the seller to a venue this page never reads", () => {
    const c = render(<EmptyState type="myListings" />);
    const text = c.querySelector(".empty-state-text")?.textContent || "";
    expect(text).toBeTruthy();

    // THE INVARIANT: no instruction to go list somewhere this page cannot see.
    expect(text).not.toMatch(/opensea to see them here/i);
    expect(text).not.toMatch(/list .*on opensea/i);

    // ...and it names the source it actually queries.
    expect(text).toMatch(/tegridy order book/i);
  });
});
