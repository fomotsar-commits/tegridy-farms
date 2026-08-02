// cancelOrder must cancel on the Seaport the order was SIGNED against.
//
// `cancelSeaportOrder` pins its target at the sink and fails closed on anything
// outside the allowlist — and its own comment says "every caller passes a
// server-supplied protocol_address". `api-offers.cancelOrder` did not: it handed over
// the hardcoded SEAPORT_ADDRESS constant. The pin cannot catch that, because the
// default IS an allowlisted address.
//
// Consequence: an order created on a different Seaport version has its cancel sent to
// this one, where that order hash does not exist. Seaport's `cancel()` marks an
// unknown hash without reverting, so the tx succeeds, cancelOrder returns
// `{ success: true }`, and the real order stays fillable — the user is told their
// listing is cancelled while it can still be bought.

import { describe, it, expect, vi, beforeEach } from "vitest";

const cancelSeaportOrder = vi.hoisted(() => vi.fn(async () => ({ wait: async () => {} , hash: "0xtx" })));
vi.mock("./seaportCancel", () => ({ cancelSeaportOrder }));

// api-offers reaches for a wallet, then reads the wallet's chain through its OWN
// local assertOnExpectedChain, so the ethers mock has to answer getNetwork too.
vi.mock("../api", () => ({
  getProvider: () => ({}),
  SEAPORT_FULFILLMENT_FUNCTIONS: new Set(),
}));
class FakeBrowserProvider {
  async getSigner() { return {}; }
  async getNetwork() { return { chainId: 1 }; }
}
vi.mock("ethers", () => ({
  ethers: { BrowserProvider: FakeBrowserProvider },
  BrowserProvider: FakeBrowserProvider,
}));

const SEAPORT_15 = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC";
const SEAPORT_16 = "0x0000000000000068F116a894984e2DB1123eB395";

const PARAMS = { offerer: "0x1111111111111111111111111111111111111111", offer: [], consideration: [] };

/** The order shapes this codepath actually receives. */
const wrapped = (protocolAddress) => ({
  rawOrder: { protocol_address: protocolAddress, protocol_data: { parameters: PARAMS } },
});
const raw = (protocolAddress) => ({ protocol_address: protocolAddress, protocol_data: { parameters: PARAMS } });

let cancelOrder;
beforeEach(async () => {
  vi.clearAllMocks();
  ({ cancelOrder } = await import("../api-offers"));
});

const targetOf = () => cancelSeaportOrder.mock.calls[0][0].seaportAddress;

describe("cancelOrder — targets the order's own Seaport, not a constant", () => {
  it("passes the protocol address from a wrapped order", async () => {
    await cancelOrder(wrapped(SEAPORT_16));
    expect(targetOf()).toBe(SEAPORT_16);
  });

  it("passes the protocol address from a raw order", async () => {
    await cancelOrder(raw(SEAPORT_16));
    expect(targetOf()).toBe(SEAPORT_16);
  });

  it("does not rewrite a 1.6 order's target to 1.5", async () => {
    // Stated as the invariant that actually matters: whatever the order says, the
    // cancel goes THERE. Pinning the specific constant would rot the day the default
    // moves; this will not.
    await cancelOrder(wrapped(SEAPORT_16));
    expect(targetOf()).not.toBe(SEAPORT_15);
  });

  it("leaves the sink's default in place when the order carries no protocol address", async () => {
    // `resolveSeaportTarget(null)` is documented to fall back to the default, and an
    // address outside the allowlist still fails closed there. Passing null preserves
    // both behaviours rather than duplicating that decision here.
    await cancelOrder({ protocol_data: { parameters: PARAMS } });
    expect(targetOf()).toBeNull();
  });
});
