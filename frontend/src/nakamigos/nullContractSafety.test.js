// Registry consumers survive an entry with no EVM contract.
//
// Junglets lives on Solana, so its registry entry carries `contract: null`.
// Four api.js lookups (hasDeterministicImage, configSupplyFor, slugFor,
// mintBlockFor) and the P2P trade modules used to walk every entry calling
// `c.contract.toLowerCase()`; one null entry makes that a TypeError, and
// configSupplyFor runs OUTSIDE fetchCollectionStats' try block, so the throw
// is uncaught. A reader asked about a contract the registry does not hold is
// exactly the call that walks past the null entry.
//
// REGRESSION GUARD: green on trunk (every entry has a contract today); it
// exists so the registry change cannot land the crash.

import { describe, it, expect, vi } from "vitest";

vi.mock("./lib/proxy", async (importOriginal) => {
  const actual = await importOriginal();
  const down = async () => { throw new actual.ApiError("down", 400); };
  return { ...actual, alchemyGet: vi.fn(down), alchemyPost: vi.fn(down), openseaGet: vi.fn(down), openseaPost: vi.fn(down) };
});

const UNKNOWN = "0x" + "e".repeat(40);

// The P2P modules pull in a large graph; under a parallel run their first
// import alone can pass the default five seconds.
vi.setConfig({ testTimeout: 30000 });

describe("api.js readers asked about a contract outside the registry", () => {
  it("fetchCollectionStats answers unavailable instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    const { fetchCollectionStats } = await import("./api");
    const s = await fetchCollectionStats({ contract: UNKNOWN, slug: "x", openseaSlug: "x" });
    expect(s.floor).toBeNull();
    vi.unstubAllGlobals();
  });

  it("fetchTokens answers an empty fallback instead of throwing", async () => {
    const { fetchTokens } = await import("./api");
    const r = await fetchTokens({ contract: UNKNOWN, metadataBase: null });
    expect(r.tokens).toEqual([]);
  });
});

describe("the P2P modules load with a null-contract entry in the registry", () => {
  it.each(["./components/TradeWindow.jsx", "./components/TradesPanel.jsx", "./components/TradeChips.jsx"])(
    "%s imports without throwing",
    async (p) => {
      await expect(import(/* @vite-ignore */ p)).resolves.toBeTruthy();
    },
  );
});
