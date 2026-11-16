// The depth chart shows the book; it no longer tells the reader what to make of it.
//
// Its generated summary ("Strong buying interest near floor", "Price gap is narrow (x%),
// suggesting healthy trading") counted every bid row, funded or not, and a venue running its
// own bidder would have been writing "strong buying interest" about its own market. Removed
// 2026-11-16 (BUILD-SPEC 3.2, item 5). The chart and the floor chip stay, and the spread line
// keeps its number but no longer grades it: its "Healthy" in green came from the same highest
// bid, the house's included (review HR-2).
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import DepthChart from "./DepthChart";

afterEach(cleanup);

// A book the old summary called strong and healthy: 12 bids just under a 1.00 floor
// (spread 1%), and 6 listings within 5% of it.
const offers = Array.from({ length: 12 }, (_, i) => ({ price: 0.99 - i * 0.001 }));
const listings = Array.from({ length: 6 }, (_, i) => ({ price: 1 + i * 0.005 }));

describe("DepthChart says no verdict about the book", () => {
  it("renders none of the generated sentences, for a book they used to praise", () => {
    const { container } = render(<DepthChart listings={listings} offers={offers} floorPrice={1} />);
    const text = container.textContent;
    for (const phrase of [/buying interest/i, /healthy trading/i, /bid support/i, /bid activity/i, /price gap/i, /no active bids/i, /floor with/i, /Healthy/]) {
      expect(text, String(phrase)).not.toMatch(phrase);
    }
    expect(container.querySelector("#depth-chart-summary")).toBeNull();
    expect(container.querySelector(".depth-summary")).toBeNull();
  });

  it("still draws the chart, named for assistive tech, with no description pointing at nothing", () => {
    render(<DepthChart listings={listings} offers={offers} floorPrice={1} />);
    const chart = screen.getByRole("img", { name: "Order book depth chart" });
    expect(chart.getAttribute("aria-describedby")).toBeNull();
    expect(screen.getByText("SPREAD")).toBeTruthy();
  });

  it("the spread keeps its number, with no grade in words or colour, whatever the gap", () => {
    // A best bid 1%, 7% and 20% under a 1.00 floor: the old "Healthy", "Moderate" and "Wide".
    for (const bid of [0.99, 0.93, 0.8]) {
      const { container, unmount } = render(<DepthChart listings={listings} offers={[{ price: bid }]} floorPrice={1} />);
      const bar = container.querySelector(".depth-spread-bar");
      expect(bar.textContent).toBe(`SPREAD${(1 - bid).toFixed(4)} ETH (${((1 - bid) * 100).toFixed(1)}%)`);
      expect(bar.innerHTML, String(bid)).not.toMatch(/--green|--yellow|--red/);
      // The dashed band the chart draws between the best bid and the floor is not graded either.
      expect(container.querySelector('rect[stroke-dasharray="4 2"]').getAttribute("stroke"), String(bid)).not.toMatch(/--green|--yellow|--red/);
      unmount();
    }
  });

  it("a bid above the floor still reads as unavailable, never as a spread", () => {
    const { container } = render(<DepthChart listings={listings} offers={[{ price: 4.28 }]} floorPrice={1} />);
    expect(container.querySelector(".depth-spread-bar").textContent).toBe("SPREAD—Data unavailable");
  });

  it("an empty book still says it cannot draw, as before", () => {
    render(<DepthChart listings={[]} offers={[]} floorPrice={1} />);
    expect(screen.getByText("Not enough listing or bid data to render depth chart")).toBeTruthy();
  });
});
