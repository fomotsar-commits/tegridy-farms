import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the Alchemy proxy so calculatePnL is driven by deterministic sale data.
const alchemyGet = vi.fn();
vi.mock("./proxy", () => ({ alchemyGet: (...args) => alchemyGet(...args) }));

import { calculatePnL } from "./portfolio";

const WALLET = "0x1111111111111111111111111111111111111111";
const CONTRACT = "0xc0ffee0000000000000000000000000000000000";
const ETH = 1000000000000000000n; // 1e18 wei

// Build a getNFTSales-shaped sale row. Price is split across seller fee only.
function saleRow({ tokenId, buyer, seller, ethPrice, block, hash }) {
  return {
    tokenId: String(tokenId),
    buyerAddress: buyer || null,
    sellerAddress: seller || null,
    blockNumber: block,
    transactionHash: hash,
    sellerFee: { amount: String(BigInt(Math.round(ethPrice * 1e6)) * ETH / 1000000n) },
  };
}

// Route the three calculatePnL queries (buys, sells) to the right fixtures.
function wireSales({ buys = [], sells = [] }) {
  alchemyGet.mockImplementation(async (_endpoint, params) => {
    if (params.buyerAddress) return { nftSales: buys };
    if (params.sellerAddress) return { nftSales: sells };
    return { nftSales: [] };
  });
}

describe("calculatePnL", () => {
  beforeEach(() => {
    alchemyGet.mockReset();
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  const collection = { contract: CONTRACT, name: "Test", floorPrice: 1 };

  it("F722: only charges gas for tokens with a real purchase (not mints/airdrops)", async () => {
    // Token 1 was bought; token 2 has no buy record (mint/airdrop).
    wireSales({
      buys: [saleRow({ tokenId: 1, buyer: WALLET, ethPrice: 0.5, block: 100, hash: "0xbuy1" })],
    });
    const held = [{ id: "1", name: "#1" }, { id: "2", name: "#2" }];
    const res = await calculatePnL(WALLET, collection, held);
    // 0.003 ETH for the one purchased token only — not 0.006 for both.
    expect(res.totalGasSpent).toBeCloseTo(0.003, 6);
    const minted = res.tokenDetails.find(t => t.tokenId === "2");
    expect(minted.isMint).toBe(true);
  });

  it("F723: realized P&L ignores a buy that happened AFTER the sale (sell-then-rebuy)", async () => {
    // Sold token 1 at block 200 for 2 ETH; the only buy is a rebuy at block 300.
    // The later rebuy must NOT be used as cost basis → unmatched sell.
    wireSales({
      buys: [saleRow({ tokenId: 1, buyer: WALLET, ethPrice: 1.0, block: 300, hash: "0xrebuy" })],
      sells: [saleRow({ tokenId: 1, seller: WALLET, ethPrice: 2.0, block: 200, hash: "0xsell" })],
    });
    const res = await calculatePnL(WALLET, collection, []);
    // No prior buy → excluded from realized P&L, surfaced as an unmatched sell.
    expect(res.realizedPnL).toBe(0);
    expect(res.realizedUnmatchedSells).toBe(1);
  });

  it("F723: matches an earlier buy and computes realized P&L from it", async () => {
    wireSales({
      buys: [saleRow({ tokenId: 1, buyer: WALLET, ethPrice: 1.0, block: 100, hash: "0xbuy" })],
      sells: [saleRow({ tokenId: 1, seller: WALLET, ethPrice: 1.5, block: 200, hash: "0xsell" })],
    });
    const res = await calculatePnL(WALLET, collection, []);
    expect(res.realizedPnL).toBeCloseTo(0.5, 6);
    expect(res.realizedUnmatchedSells).toBe(0);
  });

  it("F732: forceRefresh bypasses the localStorage cache", async () => {
    wireSales({ buys: [], sells: [] });
    const held = [{ id: "1", name: "#1" }];
    await calculatePnL(WALLET, collection, held); // populates cache
    const callsAfterFirst = alchemyGet.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Cached path: no new alchemy calls.
    await calculatePnL(WALLET, collection, held);
    expect(alchemyGet.mock.calls.length).toBe(callsAfterFirst);

    // forceRefresh: cache invalidated → fresh fetches fire again.
    await calculatePnL(WALLET, collection, held, true);
    expect(alchemyGet.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});
