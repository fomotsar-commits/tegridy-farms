import { describe, it, expect } from "vitest";
import { preflightOrders } from "./orderValidator";

// Passing no provider runs Layer 1 only (expiry + freshness) — free, offline,
// and enough to prove the split. Sweep and Deals share this path with the cart
// so a stale listing never reaches the wallet, and so one dead item in a queue
// takes itself out instead of taking the sweep down with it.

const nowSec = () => Math.floor(Date.now() / 1000);

const order = (id, { endTime, startTime, orderHash = `0x${id}` } = {}) => ({
  id,
  name: `#${id}`,
  orderHash,
  orderData: {
    parameters: {
      startTime: String(startTime ?? nowSec() - 3600),
      endTime: String(endTime ?? nowSec() + 86400),
    },
  },
});

describe("preflightOrders", () => {
  it("passes a live order through", async () => {
    const { ok, skipped } = await preflightOrders(null, [order(1)]);
    expect(ok).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });

  it("skips an expired order and names the reason", async () => {
    const { ok, skipped } = await preflightOrders(null, [order(1, { endTime: nowSec() - 60 })]);
    expect(ok).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].order.id).toBe(1);
    expect(skipped[0].reason).toMatch(/expired/i);
  });

  it("keeps the rest of the queue when one item in the middle is dead", async () => {
    const queue = [order(1), order(2, { endTime: nowSec() - 5 }), order(3)];
    const { ok, skipped } = await preflightOrders(null, queue);
    expect(ok.map((o) => o.id)).toEqual([1, 3]);
    expect(skipped.map((s) => s.order.id)).toEqual([2]);
  });

  it("skips an order with no order data at all", async () => {
    const { ok, skipped } = await preflightOrders(null, [{ id: 9, name: "#9" }]);
    expect(ok).toHaveLength(0);
    expect(skipped[0].reason).toMatch(/missing order data/i);
  });

  it("does NOT drop an order merely because it is stale or expiring soon", async () => {
    // Yellow is a warning, not a verdict — dropping these would delete fillable
    // listings from the sweep, which is the failure mode the drop-happy version
    // of this logic had.
    const soon = order(1, { endTime: nowSec() + 60 });
    const old = order(2, { startTime: nowSec() - 30 * 86400 });
    const { ok, skipped } = await preflightOrders(null, [soon, old]);
    expect(ok.map((o) => o.id)).toEqual([1, 2]);
    expect(skipped).toHaveLength(0);
  });

  it("treats a validator fault as a warning, not as a dead order", async () => {
    const exploding = {
      id: 5,
      orderHash: "0x5",
      get orderData() { throw new Error("boom"); },
    };
    const { ok, skipped } = await preflightOrders(null, [exploding]);
    expect(ok).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });

  it("handles empty and missing input", async () => {
    await expect(preflightOrders(null, [])).resolves.toMatchObject({ ok: [], skipped: [] });
    await expect(preflightOrders(null)).resolves.toMatchObject({ ok: [], skipped: [] });
  });

  it("reports every skipped item so a caller can say what it dropped", async () => {
    const queue = [
      order(1, { endTime: nowSec() - 5 }),
      order(2, { endTime: nowSec() - 5 }),
      order(3),
    ];
    const { ok, skipped, results } = await preflightOrders(null, queue);
    expect(ok).toHaveLength(1);
    expect(skipped).toHaveLength(2);
    expect(results).toHaveLength(3);
    for (const s of skipped) expect(s.reason).toBeTruthy();
  });
});

// An order's status is read on the Seaport it lives on. OpenSea's listings are
// on 1.6; the check used to ask 1.5, which knows nothing of them and answered
// "fine" for a cancelled or sold listing.
describe("order status is read on the order's own Seaport", () => {
  const SEAPORT_16 = "0x0000000000000068f116a894984e2db1123eb395";
  const SELLER = "0x" + "c".repeat(40);

  it("drops a 1.6 listing that 1.6 says is cancelled", async () => {
    const { ethers } = await import("ethers");
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const asked = [];
    const provider = {
      call: async (tx) => {
        const selector = tx.data.slice(0, 10);
        asked.push([selector, String(tx.to).toLowerCase()]);
        if (selector === "0x46423aa7") {
          // getOrderStatus: cancelled on 1.6, unknown (all zero) anywhere else.
          const on16 = String(tx.to).toLowerCase() === SEAPORT_16;
          return coder.encode(["bool", "bool", "uint256", "uint256"], [false, on16, 0, on16 ? 1 : 0]);
        }
        if (selector === "0x6352211e") return coder.encode(["address"], [SELLER]); // ownerOf
        return coder.encode(["bool"], [true]); // isApprovedForAll
      },
    };
    const listing = {
      ...order(1, { orderHash: "0x" + "1".repeat(64) }),
      protocolAddress: SEAPORT_16,
      orderData: {
        parameters: {
          startTime: String(nowSec() - 3600), endTime: String(nowSec() + 86400), offerer: SELLER,
          offer: [{ itemType: 2, token: "0xd774557b647330c91bf44cfeab205095f7e6c367", identifierOrCriteria: "7" }],
        },
      },
    };
    const { ok, skipped } = await preflightOrders(provider, [listing]);
    expect(ok).toHaveLength(0);
    expect(skipped[0].reason).toMatch(/cancelled/i);
    expect(asked.find(([s]) => s === "0x46423aa7")[1]).toBe(SEAPORT_16);
  });
});
