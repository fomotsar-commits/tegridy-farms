import { describe, it, expect, vi, beforeEach } from "vitest";

// Alchemy caps getNFTsForOwner at 100 per page. fetchWalletNfts used to fetch
// exactly one page and hand it back next to `totalCount` — the wallet's REAL
// holding count — so a 340-NFT wallet rendered 100 tokens under a "340 owned"
// header and every derived figure (portfolio value, CSV export, trade pickers)
// silently covered a third of the wallet while presenting itself as all of it.

const state = { pages: [], calls: [], failAfter: null };

vi.mock("./lib/proxy", () => {
  class ApiError extends Error {
    constructor(message, status) { super(message); this.name = "ApiError"; this.status = status; }
    get isRetryable() { return false; }
  }
  return {
    ApiError,
    alchemyGet: vi.fn(async (endpoint, params) => {
      if (endpoint !== "getNFTsForOwner") return {};
      state.calls.push(params);
      const idx = params.pageKey ? Number(params.pageKey) : 0;
      if (state.failAfter != null && idx >= state.failAfter) {
        throw new ApiError("Alchemy proxy 500", 500);
      }
      return state.pages[idx];
    }),
    alchemyPost: vi.fn(async () => ({})),
    openseaGet: vi.fn(async () => ({})),
    openseaPost: vi.fn(async () => ({})),
  };
});

const { fetchWalletNfts } = await import("./api");

const CONTRACT = "0xd774557b647330c91bf44cfeab205095f7e6c367";

// `pageKey` is just the index of the next page in `state.pages`.
function buildPages(counts, totalCount) {
  state.pages = counts.map((n, i) => ({
    ownedNfts: Array.from({ length: n }, (_, j) => ({
      tokenId: String(i * 100 + j),
      contract: { address: CONTRACT },
      name: `#${i * 100 + j}`,
    })),
    totalCount,
    pageKey: i < counts.length - 1 ? String(i + 1) : null,
  }));
}

beforeEach(() => {
  state.pages = [];
  state.calls = [];
  state.failAfter = null;
});

describe("fetchWalletNfts walks every page", () => {
  it("returns all 340 tokens of a 340-NFT wallet, not the first 100", async () => {
    buildPages([100, 100, 100, 40], 340);
    const res = await fetchWalletNfts("0xowner", CONTRACT, null);
    expect(res.tokens).toHaveLength(340);
    expect(res.totalCount).toBe(340);
    expect(res.complete).toBe(true);
    expect(res.truncated).toBe(false);
    expect(state.calls).toHaveLength(4);
  });

  it("forwards the pageKey and asks for full pages", async () => {
    buildPages([100, 20], 120);
    await fetchWalletNfts("0xowner", CONTRACT, null);
    expect(state.calls[0].pageKey).toBeUndefined();
    expect(state.calls[0].pageSize).toBe("100");
    expect(state.calls[1].pageKey).toBe("1");
  });

  it("stops after one round trip for a single-page wallet", async () => {
    buildPages([7], 7);
    const res = await fetchWalletNfts("0xowner", CONTRACT, null);
    expect(state.calls).toHaveLength(1);
    expect(res.tokens).toHaveLength(7);
    expect(res.complete).toBe(true);
  });

  it("emits each page as it lands, declaring completeness only on the last", async () => {
    buildPages([100, 100, 10], 210);
    const seen = [];
    await fetchWalletNfts("0xowner", CONTRACT, null, {
      onPage: (p) => seen.push({ n: p.tokens.length, complete: p.complete, total: p.totalCount }),
    });
    expect(seen).toEqual([
      { n: 100, complete: false, total: 210 },
      { n: 200, complete: false, total: 210 },
      { n: 210, complete: true, total: 210 },
    ]);
  });
});

describe("an incomplete walk never reads as a complete wallet", () => {
  it("marks a cap-limited walk truncated and keeps the honest denominator", async () => {
    buildPages([100, 100, 100, 100], 400);
    const res = await fetchWalletNfts("0xowner", CONTRACT, null, { maxPages: 2 });
    expect(res.tokens).toHaveLength(200);
    expect(res.totalCount).toBe(400); // what the wallet actually holds
    expect(res.complete).toBe(false);
    expect(res.truncated).toBe(true);
  });

  it("keeps the pages that landed when a later page fails, and flags the failure", async () => {
    buildPages([100, 100, 100], 300);
    state.failAfter = 2;
    const res = await fetchWalletNfts("0xowner", CONTRACT, null);
    expect(res.tokens).toHaveLength(200);
    expect(res.complete).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it("reports a total outage as an error with nothing loaded, not as an empty wallet", async () => {
    buildPages([100], 100);
    state.failAfter = 0;
    const res = await fetchWalletNfts("0xowner", CONTRACT, null);
    expect(res.tokens).toHaveLength(0);
    expect(res.complete).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it("a genuinely empty wallet is complete and carries no error", async () => {
    state.pages = [{ ownedNfts: [], totalCount: 0, pageKey: null }];
    const res = await fetchWalletNfts("0xowner", CONTRACT, null);
    expect(res.tokens).toHaveLength(0);
    expect(res.totalCount).toBe(0);
    expect(res.complete).toBe(true);
    expect(res.error).toBeUndefined();
  });
});
