import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// The cart buys every OpenSea listing in ONE transaction on any wallet (api.js
// fulfillSeaportOrdersBatch). After it, the cart holds only what is still worth
// buying: a bought item leaves, an item that sold to someone else first leaves
// (and the visitor is told they were not charged), and an item that could not be
// prepared stays so they can try again. Nothing is bought one by one.

vi.mock("../api", () => ({
  fulfillSeaportOrder: vi.fn(async () => ({ success: true, hash: "0xsingle" })),
  fulfillSeaportOrdersBatch: vi.fn(),
  getProvider: vi.fn(() => null), // no wallet RPC: the pre-check runs its free layer only
}));
vi.mock("../lib/orderbook", () => ({ fulfillNativeOrder: vi.fn(async () => ({ success: true, hash: "0xnative" })) }));
vi.mock("../lib/transactions", () => ({ recordTransaction: vi.fn() }));
vi.mock("../contexts/CollectionContext", () => ({
  useActiveCollection: () => ({ name: "Nakamigos", slug: "nakamigos", contract: "0xnaka" }),
}));
vi.mock("../contexts/WalletContext", () => ({ useWallet: () => ({ isWrongNetwork: false }) }));

import ShoppingCart from "./ShoppingCart.jsx";
import { fulfillSeaportOrder, fulfillSeaportOrdersBatch } from "../api";
import { recordTransaction } from "../lib/transactions";

vi.setConfig({ testTimeout: 30000 });

const nowSec = () => Math.floor(Date.now() / 1000);
const item = (id, price) => ({
  id, name: `#${id}`, price, orderHash: `0x${id}`, attributes: [],
  orderData: { parameters: { startTime: String(nowSec() - 3600), endTime: String(nowSec() + 86400) } },
});
const A = item("1", 0.1);
const B = item("2", 0.11);
const C = item("3", 0.12);

function renderCart(cart) {
  const onRemove = vi.fn();
  const addToast = vi.fn();
  render(
    <ShoppingCart cart={cart} listings={cart.map((i) => ({ tokenId: i.id, price: i.price }))} isOpen wallet="0xbuyer"
      onRemove={onRemove} onClear={vi.fn()} onClose={vi.fn()} onConnect={vi.fn()} addToast={addToast} onRefreshCart={vi.fn()} />,
  );
  return { onRemove, addToast };
}

async function checkout() {
  fireEvent.click(screen.getByRole("button", { name: "SWEEP ALL" }));
  fireEvent.click(await screen.findByRole("button", { name: "CONFIRM" }));
}

beforeEach(() => vi.clearAllMocks());

describe("the cart's one-transaction checkout", () => {
  it("hands every OpenSea item to one purchase and never buys one by one", async () => {
    fulfillSeaportOrdersBatch.mockImplementation(async (list) => ({ success: true, hash: "0xone", bought: list, missed: [] }));
    const { onRemove, addToast } = renderCart([A, B, C]);
    await checkout();
    await waitFor(() => expect(addToast).toHaveBeenCalledWith("Bought 3 items in one transaction", "success"));
    expect(fulfillSeaportOrdersBatch).toHaveBeenCalledTimes(1);
    expect(fulfillSeaportOrdersBatch.mock.calls[0][0].map((i) => i.id)).toEqual(["1", "2", "3"]);
    expect(fulfillSeaportOrder).not.toHaveBeenCalled();
    expect(onRemove.mock.calls.map(([id]) => id)).toEqual(["1", "2", "3"]);
    expect(recordTransaction.mock.calls.map(([t]) => [t.nft.id, t.hash])).toEqual([["1", "0xone"], ["2", "0xone"], ["3", "0xone"]]);
  });

  it("drops what sold elsewhere, keeps what could not be prepared, and says which is which", async () => {
    fulfillSeaportOrdersBatch.mockImplementation(async () => ({
      success: true, hash: "0xone", bought: [A],
      missed: [{ listing: B, reason: "Sold to someone else", gone: true }, { listing: C, reason: "Could not get fulfillment data from OpenSea", gone: false }],
    }));
    const { onRemove, addToast } = renderCart([A, B, C]);
    await checkout();
    await waitFor(() => expect(addToast).toHaveBeenCalledWith("Bought 1 item in one transaction", "success"));
    expect(onRemove.mock.calls.map(([id]) => id)).toEqual(["1", "2"]);
    expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/1 item was no longer for sale .* not charged/), "warning");
    expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/1 item could not be bought and stayed in your cart/), "error");
    expect(recordTransaction).toHaveBeenCalledTimes(1);
  });

  it("a cancel in the wallet removes nothing", async () => {
    fulfillSeaportOrdersBatch.mockImplementation(async () => ({ error: "rejected", message: "Purchase cancelled", bought: [], missed: [] }));
    const { onRemove, addToast } = renderCart([A, B]);
    await checkout();
    await waitFor(() => expect(addToast).toHaveBeenCalledWith("Purchase cancelled", "info"));
    expect(onRemove).not.toHaveBeenCalled();
    expect(fulfillSeaportOrder).not.toHaveBeenCalled();
  });
});
