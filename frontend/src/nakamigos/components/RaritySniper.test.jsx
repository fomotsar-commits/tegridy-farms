import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import RaritySniper from "./RaritySniper";
import { CollectionProvider } from "../contexts/CollectionContext";

// The sniper joins the ~1,000-row `listings` prop against the tokens the gallery
// has paged in so far (~40 of 20,000 for Nakamigos). It used to DROP every
// listing that failed that join and then report the loss as "no listings exist
// yet". These tests pin the invariant: while listings exist, the panel must not
// claim it is waiting for listings.

// Tokens the gallery has loaded: ranked, and flagged approximate (partial load).
const TOKENS = [
  { id: "1", name: "#1", rank: 1, rankApproximate: true },
  { id: "2", name: "#2", rank: 2, rankApproximate: true },
  { id: "3", name: "#3", rank: 3, rankApproximate: true },
];

// Listings deliberately DISJOINT from the loaded tokens — production shape.
const LISTINGS = [
  { tokenId: "9001", price: 0.1 },
  { tokenId: "9002", price: 0.2 },
  { tokenId: "9003", price: 0.3 },
  { tokenId: "9004", price: 0.4 },
];

let mounted = [];
function renderSniper(props = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <CollectionProvider slug="nakamigos">
        <RaritySniper tokens={TOKENS} listings={LISTINGS} {...props} />
      </CollectionProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

// Drive a controlled React input the way App.jsx does.
function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  ).set;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network"))));
});

afterEach(() => {
  mounted.forEach(({ root, container }) => {
    act(() => root.unmount());
    container.remove();
  });
  mounted = [];
  vi.unstubAllGlobals();
});

describe("RaritySniper honesty", () => {
  it("renders listings it cannot rank instead of claiming there are none", () => {
    const c = renderSniper();

    // THE INVARIANT: the "no listings / waiting for listings" empty state must
    // not appear while listings.length > 0, whatever its exact wording.
    expect(c.textContent).not.toMatch(/Waiting for/);
    expect(c.textContent).not.toContain("No Nakamigos listings available");

    // Every unjoined listing is still shown.
    expect(c.textContent).toContain("#9001");
    expect(c.textContent).toContain("#9004");
    expect(c.textContent).toMatch(/4 sniping opportunities/);

    // ...and the coverage is stated rather than implied.
    expect(c.textContent).toMatch(/ranks known for 0 of 4/i);

    // Every row scored without a rank carries its own basis label, so a
    // price-only score is never read as a rarity snipe score.
    const rows = c.querySelectorAll("tbody tr");
    expect(rows.length).toBe(4);
    expect(Array.from(rows).every((r) => /price only/.test(r.textContent))).toBe(true);

    // No per-card metadata storm: unranked rows carry image:null and must not
    // each fire their own /api/alchemy fetch (prod incident 2026-06-11).
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the waiting copy for the one case where it is true", () => {
    const c = renderSniper({ listings: [] });
    expect(c.textContent).toMatch(/Waiting for Nakamigos listings to appear/);
  });

  it("gives filter misses their own message", () => {
    const c = renderSniper();
    const priceInput = c.querySelectorAll('input[type="number"]')[0];
    expect(priceInput).toBeTruthy();
    setInputValue(priceInput, "0.01");

    expect(c.textContent).toMatch(/No matches for current filters/);
    expect(c.textContent).not.toMatch(/Waiting for/);
  });

  // A price-only score can reach ~10.1 while a genuine rarity snipe score for a
  // rank-1 token tops out just below 10 — so a naive `b.score - a.score` sort
  // floats unranked rows above ranked ones under a "Snipe Score" header.
  it("never floats a price-only row above a rarity-ranked one", () => {
    const c = renderSniper({
      listings: [
        { tokenId: "9001", price: 0.1 }, // unranked, cheapest -> price score 10.1
        { tokenId: "1", price: 0.4 },    // rank #1 of 20,000 -> snipe score ~10.0
      ],
    });

    const rows = Array.from(c.querySelectorAll("tbody tr"));
    expect(rows.length).toBe(2);
    // The ranked token leads, despite the lower raw number.
    expect(rows[0].textContent).toContain("#1");
    expect(rows[0].textContent).not.toMatch(/price only/);
    expect(rows[1].textContent).toContain("#9001");
    expect(rows[1].textContent).toMatch(/price only/);

    // The score bar is scaled against the largest score in the list, not
    // against whatever happens to sit in row 0, so exactly one bar is full.
    const fullBars = Array.from(c.querySelectorAll("tbody tr div"))
      .filter((d) => d.style.width === "100%");
    expect(fullBars.length).toBe(1);
  });

  it("states the basis of approximate ranks instead of a phantom load", () => {
    const c = renderSniper();
    expect(c.textContent).not.toMatch(/loading more/);
    expect(c.textContent).toMatch(
      /computed from the 3 Nakamigos tokens loaded so far/,
    );
  });
});
