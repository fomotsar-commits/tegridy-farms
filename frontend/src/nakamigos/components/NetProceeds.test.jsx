import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import NetProceeds from "./NetProceeds";

// What a seller is told they receive before accepting a bid. It used to deduct a
// FIXED 1.5% (OpenSea 1% + the venue's 0.5%) from every bid, while no bid carries
// the venue's line (BID_VENUE_FEE_ENABLED is off) and some carry a royalty. Now it
// deducts the bid's own fee lines (feeBps, offerNormalize.feeBpsOf), and only when
// those are unknown shows the collection's required OpenSea fee, marked estimated.

const JBAC = "0xd37264c71e9af940e49795F0d3a8336afAaFDdA9";
const BOJUNGLES = "0x36aFeE4FaDC3b77Ff5f1f9a040E264150aFb979A";

afterEach(cleanup);

describe("NetProceeds", () => {
  it("deducts the bid's own fees: OpenSea's 1% nets 0.0495 of 0.05", () => {
    render(<NetProceeds price={0.05} feeBps={100} contract={JBAC} />);
    expect(screen.getByText("FEES (1%)")).toBeTruthy();
    expect(screen.getByText(/0\.0495/)).toBeTruthy();
    expect(screen.queryByText(/1\.5%/)).toBeNull();
    expect(screen.queryByText(/Estimated/)).toBeNull();
  });

  it("a bid carrying a 7% royalty beside OpenSea's 1% shows 8% and nets 0.046", () => {
    render(<NetProceeds price={0.05} feeBps={800} contract={JBAC} />);
    expect(screen.getByText("FEES (8%)")).toBeTruthy();
    expect(screen.getByText(/0\.0460/)).toBeTruthy();
  });

  it("the venue's 0.5% shows only when the bid carries it", () => {
    render(<NetProceeds price={1} feeBps={150} contract={JBAC} />);
    expect(screen.getByText("FEES (1.5%)")).toBeTruthy();
    expect(screen.getByText(/0\.9850/)).toBeTruthy();
  });

  it("lines unknown: the collection's required OpenSea fee, said to be estimated", () => {
    render(<NetProceeds price={0.05} contract={JBAC} />);
    expect(screen.getByText("OPENSEA FEE (1%)")).toBeTruthy();
    expect(screen.getByText(/^Estimated\./)).toBeTruthy();
    expect(screen.getByText(/0\.0495/)).toBeTruthy();
    expect(screen.queryByText(/1\.5%/)).toBeNull();
  });

  it("the estimate is the collection's own required fee, on Base too, and OpenSea's 1% for an unknown contract", () => {
    render(<NetProceeds price={1} contract={BOJUNGLES} />);
    expect(screen.getByText("OPENSEA FEE (1%)")).toBeTruthy();
    cleanup();
    render(<NetProceeds price={1} />);
    expect(screen.getByText("OPENSEA FEE (1%)")).toBeTruthy();
  });

  it("renders nothing for a price that is not a positive number", () => {
    const { container } = render(<NetProceeds price={0} feeBps={100} />);
    expect(container.innerHTML).toBe("");
  });
});
