import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { CollectionProvider } from "../contexts/CollectionContext";

// My Bids' Cancel goes through the shared cancel (api-offers.js cancelOrder): on
// the bid's own chain, and only from the account the site is connected as. It
// used to carry its own copy without either check, so a wallet sitting on Base,
// or switched to another account, could "cancel" an Ethereum bid that stayed live.

const WALLET = "0x" + "b".repeat(40);
const BID = {
  order_hash: "0x" + "c".repeat(64),
  protocol_address: "0x0000000000000068f116a894984e2db1123eb395",
  created_date: new Date().toISOString(),
  protocol_data: {
    parameters: {
      offerer: WALLET,
      offer: [{ itemType: 1, token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", identifierOrCriteria: "0", startAmount: "50000000000000000", endAmount: "50000000000000000" }],
      consideration: [{ itemType: 2, token: "0xd774557b647330c91bf44cfeab205095f7e6c367", identifierOrCriteria: "7", startAmount: "1", endAmount: "1", recipient: WALLET }],
      endTime: String(Math.floor(Date.now() / 1000) + 86400),
    },
  },
};

const h = vi.hoisted(() => ({ cancelOrder: null }));

vi.mock("../hooks/useOffers", () => ({
  useCollectionOffers: () => ({ data: [], isLoading: false, refetch: () => {} }),
  useTraitOffers: () => ({ data: {}, isLoading: false, refetch: () => {} }),
}));
// The old copy signed through the injected wallet; it is given none here.
vi.mock("../api", () => ({
  getProvider: () => null,
  fetchWalletNfts: () => Promise.resolve({ tokens: [] }),
  shortenAddress: (a) => a,
}));
vi.mock("../api-offers", () => ({
  fetchTokenOffers: () => Promise.resolve([]),
  acceptOffer: () => Promise.resolve({}),
  cancelOrder: (...a) => h.cancelOrder(...a),
}));
vi.mock("../lib/proxy", () => ({
  openseaGet: (path) => Promise.resolve(path.includes("/all") ? { offers: [BID] } : { orders: [] }),
}));
vi.mock("../contexts/WalletContext", () => ({
  useWalletState: () => ({ isWrongNetwork: false }),
  useWalletActions: () => ({ switchChain: () => {} }),
}));

import BidManager from "./BidManager";

vi.setConfig({ testTimeout: 30000 });

function renderBids(addToast) {
  render(
    <CollectionProvider slug="nakamigos">
      <BidManager wallet={WALLET} onConnect={() => {}} addToast={addToast} onPick={() => {}} tokens={[]} />
    </CollectionProvider>,
  );
}

beforeEach(() => { h.cancelOrder = vi.fn(); });
afterEach(cleanup);

describe("My Bids' Cancel", () => {
  it("goes through the shared, checked cancel and says why it was refused", async () => {
    h.cancelOrder.mockResolvedValue({ error: "wallet-mismatch", message: "Wrong wallet: connected as 0xbbbb but 0xeeee would sign and pay. Switch back or reconnect." });
    const addToast = vi.fn();
    renderBids(addToast);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(h.cancelOrder).toHaveBeenCalledTimes(1));
    expect(h.cancelOrder.mock.calls[0][0].orderHash).toBe(BID.order_hash);
    await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/^Wrong wallet/), "error"));
    expect(addToast).not.toHaveBeenCalledWith("Bid cancelled successfully!", "success");
  });

  it("a confirmed cancel says so", async () => {
    h.cancelOrder.mockResolvedValue({ success: true, hash: "0xcancel" });
    const addToast = vi.fn();
    renderBids(addToast);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith("Bid cancelled successfully!", "success"));
  });
});
