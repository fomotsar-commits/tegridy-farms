import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// The sweep queue is drawn from a listings snapshot, so its cheapest — most
// contested — rows go stale first. Before the cart's pre-flight was shared with
// this path, those rows reached the wallet: the EIP-5792 batch reverted as a
// whole on one dead order, and the sequential fallback spent a confirmation per
// corpse. The queue must now shed the invalidated items, say which ones, and
// keep sweeping the rest.

vi.mock("../api", () => ({
  fulfillSeaportOrder: vi.fn(async () => ({ success: true, hash: "0xhash" })),
  // Force the sequential path so per-item behaviour is observable.
  fulfillSeaportOrdersBatch: vi.fn(async () => ({ error: "unsupported" })),
  getProvider: vi.fn(() => null), // no wallet RPC -> pre-flight runs Layer 1 only
}));
vi.mock("../lib/orderbook", () => ({ fulfillNativeOrder: vi.fn(async () => ({ success: true, hash: "0xnative" })) }));
vi.mock("../lib/transactions", () => ({ recordTransaction: vi.fn() }));
vi.mock("../contexts/CollectionContext", () => ({
  useActiveCollection: () => ({ name: "Nakamigos", slug: "nakamigos", contract: "0xnaka" }),
}));
vi.mock("../contexts/WalletContext", () => ({ useWallet: () => ({ isWrongNetwork: false }) }));

import SweepCalculator from "./SweepCalculator.jsx";
import { fulfillSeaportOrder, fulfillSeaportOrdersBatch } from "../api";

const nowSec = () => Math.floor(Date.now() / 1000);

const listing = (id, price, { endTime } = {}) => ({
  id,
  name: `#${id}`,
  price,
  orderHash: `0x${id}`,
  attributes: [],
  orderData: {
    parameters: {
      startTime: String(nowSec() - 3600),
      endTime: String(endTime ?? nowSec() + 86400),
    },
  },
});

function renderSweep(listings, addToast = vi.fn()) {
  render(
    <SweepCalculator
      stats={{ floor: 0.1 }}
      listings={listings}
      wallet="0xbuyer"
      onConnect={vi.fn()}
      addToast={addToast}
    />
  );
  return addToast;
}

beforeEach(() => vi.clearAllMocks());

describe("sweep pre-flight", () => {
  it("buys the live listings and never sends the expired one to the wallet", async () => {
    const listings = [
      listing(1, 0.10),
      listing(2, 0.11, { endTime: nowSec() - 60 }),
      listing(3, 0.12),
    ];
    const addToast = renderSweep(listings);

    fireEvent.click(screen.getByRole("button", { name: /^Sweep 3 Nakamigos/ }));

    await waitFor(() => expect(fulfillSeaportOrder).toHaveBeenCalledTimes(2));
    const bought = fulfillSeaportOrder.mock.calls.map(([nft]) => nft.id);
    expect(bought).toEqual([1, 3]);
    expect(fulfillSeaportOrdersBatch.mock.calls[0][0].map((n) => n.id)).toEqual([1, 3]);
    expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/Skipping 1 listing/i), "warning");
  });

  it("names what it skipped on screen, not only in a toast that scrolls away", async () => {
    renderSweep([listing(1, 0.10), listing(2, 0.11, { endTime: nowSec() - 60 })]);
    fireEvent.click(screen.getByRole("button", { name: /^Sweep 2 Nakamigos/ }));

    expect(await screen.findByText(/SKIPPED \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/#2 — .*expired/i)).toBeInTheDocument();
  });

  it("refuses the sweep outright when every queued listing is dead", async () => {
    const addToast = renderSweep([
      listing(1, 0.10, { endTime: nowSec() - 60 }),
      listing(2, 0.11, { endTime: nowSec() - 60 }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /^Sweep 2 Nakamigos/ }));

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/no longer fillable/i), "error")
    );
    expect(fulfillSeaportOrder).not.toHaveBeenCalled();
    expect(fulfillSeaportOrdersBatch).not.toHaveBeenCalled();
  });

  it("leaves an all-live queue completely intact", async () => {
    const addToast = renderSweep([listing(1, 0.10), listing(2, 0.11)]);
    fireEvent.click(screen.getByRole("button", { name: /^Sweep 2 Nakamigos/ }));

    await waitFor(() => expect(fulfillSeaportOrder).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/SKIPPED/)).toBeNull();
    expect(addToast).not.toHaveBeenCalledWith(expect.stringMatching(/Skipping/i), "warning");
  });
});
