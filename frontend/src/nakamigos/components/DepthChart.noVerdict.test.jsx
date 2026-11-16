// The depth chart shows the book; it no longer tells the reader what to make of it.
//
// Its generated summary ("Strong buying interest near floor", "Price gap is narrow (x%),
// suggesting healthy trading") counted every bid row, funded or not, and a venue running its
// own bidder would have been writing "strong buying interest" about its own market. Removed
// 2026-11-16 (BUILD-SPEC 3.2, item 5). The chart, the spread line and the floor chip stay.
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
    for (const phrase of [/buying interest/i, /healthy trading/i, /bid support/i, /bid activity/i, /price gap/i, /no active bids/i, /floor with/i]) {
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

  it("an empty book still says it cannot draw, as before", () => {
    render(<DepthChart listings={[]} offers={[]} floorPrice={1} />);
    expect(screen.getByText("Not enough listing or bid data to render depth chart")).toBeTruthy();
  });
});
