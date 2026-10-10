import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stalledBody, watch } from "../test/quietHost";

// fetchActivity waits for the venue's own filled orders before it answers. Their 10 s
// cover the whole answer: when /api/orderbook sends a 200, its headers and half a body,
// the feed still arrives, with OpenSea's sales and without ours.
//
// Only the network boundary is faked: ./lib/proxy for OpenSea, and global `fetch` for
// /api/orderbook.

const state = vi.hoisted(() => ({ openseaGet: null }));

vi.mock("./lib/proxy", async (importOriginal) => {
  const actual = await importOriginal();
  const down = vi.fn(async () => {
    throw new Error("proxy down");
  });
  return {
    ...actual,
    alchemyGet: down,
    alchemyPost: down,
    openseaPost: down,
    openseaGet: vi.fn((...args) => state.openseaGet(...args)),
  };
});

// Imported statically so the module is loaded before any clock is faked.
import { fetchActivity } from "./api";
import { CONTRACT } from "./constants";

const SALE = {
  nft: { identifier: "7" },
  payment: { quantity: "1000000000000000000", decimals: 18 },
  seller: "0x1111111111111111111111111111111111111111",
  buyer: "0x2222222222222222222222222222222222222222",
  event_timestamp: 1_790_000_000,
  transaction: "0x" + "ab".repeat(32),
};

beforeEach(() => {
  state.openseaGet = vi.fn(async () => ({ asset_events: [SALE], next: null }));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchActivity: the venue's own sales stop part-way through their answer", () => {
  it("answers after 10 s with the sales it could read", async () => {
    const asked = [];
    vi.stubGlobal("fetch", (url, init) => {
      asked.push(String(url));
      return Promise.resolve(stalledBody(init.signal));
    });
    const ended = await watch(() => fetchActivity({ contract: CONTRACT }), 60_000);
    expect(ended, "still pending after 60 s").not.toBeNull();
    expect(ended.afterMs).toBe(10_000);
    expect(ended.value.activities.map((a) => [a.marketplace, a.token.id])).toEqual([["opensea", "7"]]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("/api/orderbook?");
  });

  it("merges our sales in when the whole answer arrives", async () => {
    const order = { token_id: "9", price_eth: 2, maker: SALE.seller, filled_by: SALE.buyer, filled_at: new Date().toISOString(), tx_hash: "0x" + "cd".repeat(32) };
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify({ orders: [order] }), { status: 200 })));
    const ended = await watch(() => fetchActivity({ contract: CONTRACT }), 60_000);
    expect(ended.afterMs).toBe(0);
    expect(ended.value.activities.map((a) => a.marketplace).sort()).toEqual(["native", "opensea"]);
  });
});
