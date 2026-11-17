// The integrity panel lists the venue's own trades under "House trades" (BUILD-SPEC 3.2,
// item 4): published apart, and the seller who filled a house bid is in no wallet group.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { WashPanel } from "./MarketIntegrity.jsx";
import { analyzeWashTrading } from "../lib/marketIntegrity.js";

afterEach(cleanup);

const HOUSE = "0x8ba1f109551bd432803012645ac136ddd64dba72";
const SELLER = "0x" + "a".repeat(40);
const BUYER = "0x" + "b".repeat(40);
const sold = (from, to, id, price, time) => ({ fromFull: from, toFull: to, token: { id }, price, time });

describe("House trades on the integrity panel", () => {
  it("lists each house trade with its side, token, counterparty and price, and groups no seller with the house", () => {
    const result = analyzeWashTrading(
      [sold(SELLER, HOUSE, 11, 0.045, 1), sold(SELLER, HOUSE, 12, 0.045, 2), sold(HOUSE, BUYER, 11, 0.05, 3)],
      { houseWallets: [HOUSE] },
    );
    render(<WashPanel result={result} capped={false} />);
    const list = screen.getByTestId("house-trades");
    expect(within(list).getByText("HOUSE TRADES (3)")).toBeTruthy();
    expect(list.textContent).toContain("House bought #11 from 0xaaaa…aaaa");
    expect(list.textContent).toContain("House bought #12 from 0xaaaa…aaaa");
    expect(list.textContent).toContain("House sold #11 to 0xbbbb…bbbb");
    expect(list.textContent).toContain("0.045");
    expect(screen.queryByText(/COORDINATED WALLET GROUPS/)).toBeNull();
  });

  it("shows nothing about the house while the registry names no wallet", () => {
    const result = analyzeWashTrading([sold(SELLER, HOUSE, 11, 0.045, 1), sold(BUYER, SELLER, 12, 0.04, 2)]);
    render(<WashPanel result={result} capped={false} />);
    expect(screen.queryByTestId("house-trades")).toBeNull();
    expect(document.body.textContent).not.toMatch(/HOUSE TRADES/);
  });
});
