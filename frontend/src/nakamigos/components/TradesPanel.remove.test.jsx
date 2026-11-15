import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// Taking a trade out of the other side's inbox (or off the board) is free and
// does not touch the signed order: it can still be accepted until it expires,
// and only "Revoke on-chain" ends it. The button said "Cancel" and the toast
// said "Trade cancelled", so a maker could believe a live offer was dead.

const WALLET = "0x" + "b".repeat(40);
const TRADE = {
  id: "t1",
  status: "active",
  offerer: WALLET,
  target_owner: "0x" + "d".repeat(40),
  offered: [],
  requested: [],
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
};

const h = vi.hoisted(() => ({ updateTradeStatus: null }));

vi.mock("../lib/trades", () => ({
  fetchTrades: vi.fn(async ({ role }) => ({ trades: role === "outgoing" ? [TRADE] : [] })),
  acceptTrade: vi.fn(),
  acceptOpenTrade: vi.fn(),
  updateTradeStatus: (...a) => h.updateTradeStatus(...a),
  cancelTradeOnChain: vi.fn(),
  fillableHoldings: () => [],
}));
vi.mock("./TradeWindow", () => ({ default: () => null }));
vi.mock("./DirectMessages", () => ({ default: () => null }));
vi.mock("./NftImage", () => ({ default: () => null }));
vi.mock("./TradeChips", () => ({
  ItemChips: () => null,
  TradeSummary: () => null,
  fmtEthWei: () => "0",
  liveTopups: () => ({}),
}));
vi.mock("../lib/notifications", () => ({
  getNotificationStatus: () => "unsupported",
  subscribeToPush: vi.fn(),
  unsubscribeFromPush: vi.fn(),
  isSubscribed: async () => false,
}));
vi.mock("../api", () => ({ fetchWalletNfts: async () => ({ tokens: [] }) }));

import TradesPanel from "./TradesPanel";

vi.setConfig({ testTimeout: 30000 });

beforeEach(() => { h.updateTradeStatus = vi.fn(async () => ({ success: true })); });
afterEach(cleanup);

describe("removing a trade you sent", () => {
  it("is called Remove, and says the signed trade can still be accepted", async () => {
    const addToast = vi.fn();
    render(<TradesPanel wallet={WALLET} addToast={addToast} onConnect={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /outgoing/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(h.updateTradeStatus).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }), "trade-cancel"));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/can still be accepted until it expires/), "success"));
    expect(addToast).not.toHaveBeenCalledWith("Trade cancelled", "success");
    expect(screen.getByRole("button", { name: "Revoke on-chain" })).toBeInTheDocument();
  });
});
