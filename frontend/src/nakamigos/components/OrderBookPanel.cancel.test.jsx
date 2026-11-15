import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// The order book's Cancel goes through the one shared listing cancel
// (lib/orderbook.js cancelNativeListing): on the order's own chain, only from
// the wallet that listed it, and "Listing cancelled!" only once the chain says
// so. This panel used to carry its own copy, which skipped the on-chain cancel
// for a row with no order parameters, still marked the row cancelled in the
// book, and told the seller "Listing cancelled!" while the signed order could
// still be bought.

const WALLET = "0x" + "b".repeat(40);

vi.mock("../lib/orderbook", () => ({
  fetchNativeListings: vi.fn(),
  fetchNativeBundles: vi.fn(async () => ({ orders: [] })),
  fulfillNativeOrder: vi.fn(),
  cancelNativeListing: vi.fn(),
}));
vi.mock("../lib/transactions", () => ({ recordTransaction: vi.fn() }));
vi.mock("../contexts/CollectionContext", () => ({
  useActiveCollection: () => ({ name: "Nakamigos", slug: "nakamigos", contract: "0xd774557b647330c91bf44cfeab205095f7e6c367" }),
}));
vi.mock("../contexts/WalletContext", () => ({
  useWalletState: () => ({ isWrongNetwork: false }),
  useWalletActions: () => ({ switchChain: vi.fn() }),
}));
// The old copy signed through the injected wallet. Given one here, it would
// have run to the end; the shared cancel never reaches it.
vi.mock("../api", () => ({
  getProvider: () => ({
    request: async ({ method }) => {
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [WALLET];
      if (method === "personal_sign") return "0x" + "1".repeat(130);
      return null;
    },
  }),
}));

import OrderBookPanel from "./OrderBookPanel.jsx";
import { fetchNativeListings, cancelNativeListing } from "../lib/orderbook";

vi.setConfig({ testTimeout: 30000 });

// A row of the seller's own, stored without its order parameters.
const ROW = {
  order_hash: "0x" + "a".repeat(64),
  maker: WALLET,
  price_eth: 0.1,
  token_id: "7",
  status: "active",
  created_at: new Date().toISOString(),
  end_time: new Date(Date.now() + 86_400_000).toISOString(),
  contract_address: "0xd774557b647330c91bf44cfeab205095f7e6c367",
};

let fetchSpy;
beforeEach(() => {
  vi.clearAllMocks();
  fetchNativeListings.mockResolvedValue({ orders: [ROW] });
  fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
  vi.stubGlobal("fetch", fetchSpy);
  window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the order book's Cancel", () => {
  it("never calls a listing cancelled that the chain did not cancel", async () => {
    cancelNativeListing.mockResolvedValue({ error: "invalid-order", message: "Order missing parameters" });
    const addToast = vi.fn();
    render(<OrderBookPanel wallet={WALLET} addToast={addToast} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancelNativeListing).toHaveBeenCalledTimes(1));
    expect(cancelNativeListing.mock.calls[0][0].order_hash).toBe(ROW.order_hash);
    await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.any(String), "error"));
    expect(addToast).not.toHaveBeenCalledWith("Listing cancelled!", "success");
    // The panel itself never tells the book the listing is gone.
    expect(fetchSpy.mock.calls.filter(([url, init]) => String(url).includes("/api/orderbook") && init?.method === "POST")).toEqual([]);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("takes the row off the book once the chain has cancelled it", async () => {
    cancelNativeListing.mockResolvedValue({ success: true, hash: "0xcancel" });
    const addToast = vi.fn();
    render(<OrderBookPanel wallet={WALLET} addToast={addToast} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith("Listing cancelled!", "success"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull());
  });
});
