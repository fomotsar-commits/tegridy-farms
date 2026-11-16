import { describe, it, expect } from "vitest";
import {
  normalizeSale,
  buildTradeClusters,
  analyzeWashTrading,
  analyzeFloorConcentration,
  analyzeOwnershipConcentration,
  computeMarketIntegrity,
} from "./marketIntegrity";

// Distinct valid addresses
const A = "0xaaaa000000000000000000000000000000000001";
const B = "0xbbbb000000000000000000000000000000000002";
const C = "0xcccc000000000000000000000000000000000003";
const D = "0xdddd000000000000000000000000000000000004";

function addr(n) {
  return `0x${n.toString(16).padStart(40, "0")}`;
}

describe("normalizeSale", () => {
  it("normalizes the activity-feed shape (fromFull/toFull/token.id)", () => {
    const s = normalizeSale({ fromFull: A, toFull: B, token: { id: 42 }, price: 1.5, time: 100, hash: "0xh" });
    expect(s).toEqual({ seller: A, buyer: B, tokenId: "42", price: 1.5, time: 100, hash: "0xh" });
  });

  it("normalizes the price-history shape (from/to/tokenId)", () => {
    const s = normalizeSale({ from: A, to: B, tokenId: 7, price: "2" });
    expect(s.seller).toBe(A);
    expect(s.buyer).toBe(B);
    expect(s.tokenId).toBe("7");
    expect(s.price).toBe(2);
  });

  it("returns null when a side is not a full comparable address (no guessing)", () => {
    expect(normalizeSale({ fromFull: A })).toBe(null);
    expect(normalizeSale({ from: "0xf46a...00aa", to: "0xf46a...00aa" })).toBe(null);
    expect(normalizeSale(null)).toBe(null);
  });

  it("nulls out a non-positive / non-finite price rather than inventing one", () => {
    expect(normalizeSale({ fromFull: A, toFull: B, price: 0 }).price).toBe(null);
    expect(normalizeSale({ fromFull: A, toFull: B, price: "abc" }).price).toBe(null);
  });
});

describe("buildTradeClusters", () => {
  const S = (from, to, tokenId, price, time) => ({ seller: from, buyer: to, tokenId, price, time });

  it("does NOT cluster a one-off A->B sale (ordinary demand)", () => {
    const { clusters } = buildTradeClusters([S(A, B, "1", 1, 1)]);
    expect(clusters.length).toBe(0);
  });

  it("clusters a reciprocal pair (A->B and B->A)", () => {
    const { clusters, clusterOf } = buildTradeClusters([S(A, B, "1", 1, 1), S(B, A, "1", 1, 2)]);
    expect(clusters.length).toBe(1);
    expect(clusters[0].wallets).toEqual([A, B]);
    expect(clusterOf.get(A)).toBe(clusterOf.get(B));
  });

  it("clusters a repeated one-way pair (A->B twice)", () => {
    const { clusters } = buildTradeClusters([S(A, B, "1", 1, 1), S(A, B, "2", 1, 2)]);
    expect(clusters.length).toBe(1);
    expect(clusters[0].wallets).toEqual([A, B]);
  });

  it("merges transitive reciprocal pairs into one cluster (A<->B, B<->C)", () => {
    const { clusters } = buildTradeClusters([
      S(A, B, "1", 1, 1), S(B, A, "1", 1, 2),
      S(B, C, "2", 1, 3), S(C, B, "2", 1, 4),
    ]);
    expect(clusters.length).toBe(1);
    expect(clusters[0].wallets).toEqual([A, B, C].sort());
  });
});

describe("analyzeWashTrading", () => {
  it("self-gates (measured:false) on empty input — never fabricates", () => {
    const r = analyzeWashTrading([]);
    expect(r.measured).toBe(false);
    expect(r.totalSales).toBe(0);
  });

  it("self-gates when sales lack comparable addresses", () => {
    const r = analyzeWashTrading([{ price: 1 }, { fromFull: "0xshort", toFull: "0xshort" }]);
    expect(r.measured).toBe(false);
    expect(r.totalSales).toBe(2);
    expect(r.comparableSales).toBe(0);
  });

  it("counts self-sales and attributes their volume as suspect", () => {
    const sales = [
      { fromFull: A, toFull: A, token: { id: 1 }, price: 5, time: 1 }, // self-sale
      { fromFull: A, toFull: B, token: { id: 2 }, price: 5, time: 2 }, // genuine
    ];
    const r = analyzeWashTrading(sales, { observedAt: 1000 });
    expect(r.measured).toBe(true);
    expect(r.selfSales.count).toBe(1);
    expect(r.selfSales.shareOfSales).toBeCloseTo(0.5, 6);
    expect(r.totalVolumeEth).toBe(10);
    expect(r.suspect.volumeEth).toBe(5);
    expect(r.suspect.shareOfVolume).toBeCloseTo(0.5, 6);
  });

  it("flags cluster-internal sales as suspect but not one-off demand", () => {
    const sales = [
      { fromFull: A, toFull: B, token: { id: 1 }, price: 1, time: 1 },
      { fromFull: B, toFull: A, token: { id: 1 }, price: 1, time: 2 }, // reciprocal -> cluster {A,B}
      { fromFull: C, toFull: D, token: { id: 9 }, price: 4, time: 3 }, // one-off -> genuine
    ];
    const r = analyzeWashTrading(sales);
    expect(r.coordinatedClusters.count).toBe(1);
    expect(r.coordinatedClusters.internalSales).toBe(2);
    expect(r.suspect.sales).toBe(2);
    // C->D volume (4) is NOT suspect
    expect(r.suspect.shareOfVolume).toBeCloseTo(2 / 6, 6);
  });

  it("detects a round-trip token (returns to a prior owner)", () => {
    const sales = [
      { fromFull: A, toFull: B, token: { id: 1 }, price: 1, time: 1 },
      { fromFull: B, toFull: A, token: { id: 1 }, price: 1, time: 2 }, // token 1 back to A
    ];
    const r = analyzeWashTrading(sales);
    expect(r.roundTripTokens).toBe(1);
  });
});

describe("analyzeFloorConcentration", () => {
  it("self-gates on no listings", () => {
    expect(analyzeFloorConcentration([]).measured).toBe(false);
  });

  it("flags a single-wallet floor as concentrated with a wall", () => {
    const listings = Array.from({ length: 5 }, (_, i) => ({ price: 1 + i * 0.01, maker: A }));
    listings.push({ price: 1, maker: A }, { price: 1, maker: A }, { price: 1, maker: A }); // wall at 1.0
    const r = analyzeFloorConcentration(listings, { depth: 100 });
    expect(r.measured).toBe(true);
    expect(r.distinctSellers).toBe(1);
    expect(r.topSellerShare).toBe(1);
    expect(r.effectiveSellers).toBeCloseTo(1, 6);
    expect(r.band).toBe("concentrated");
    expect(r.largestWall).not.toBe(null);
    expect(r.largestWall.count).toBeGreaterThanOrEqual(3);
  });

  it("reads a broad floor (10 distinct sellers) as well-distributed", () => {
    const listings = Array.from({ length: 10 }, (_, i) => ({ price: 1 + i * 0.1, maker: addr(i + 100) }));
    const r = analyzeFloorConcentration(listings);
    expect(r.distinctSellers).toBe(10);
    expect(r.effectiveSellers).toBeCloseTo(10, 6);
    expect(r.topSellerShare).toBeCloseTo(0.1, 6);
    expect(r.band).toBe("well-distributed");
  });

  it("reports listings with no maker as an unattributed coverage gap, not a seller", () => {
    const listings = [
      { price: 1, maker: A },
      { price: 1.1, maker: null },
      { price: 1.2 },
    ];
    const r = analyzeFloorConcentration(listings);
    expect(r.attributedListings).toBe(1);
    expect(r.unattributedListings).toBe(2);
    expect(r.distinctSellers).toBe(1);
  });
});

describe("analyzeOwnershipConcentration", () => {
  it("self-gates on no owners", () => {
    expect(analyzeOwnershipConcentration({ owners: [] }).measured).toBe(false);
  });

  it("delegates to the core and returns a distribution band + effective holders", () => {
    const owners = Array.from({ length: 200 }, (_, i) => ({ address: addr(i + 1), count: 1 }));
    const r = analyzeOwnershipConcentration({ owners, totalSupply: 200 });
    expect(r.measured).toBe(true);
    expect(r.analysis.metrics.includedHolders).toBe(200);
    expect(r.analysis.metrics.effectiveHolders).toBeCloseTo(200, 4);
    expect(r.analysis.band).toBe("well-distributed");
  });

  it("floors the band to concentrated when one wallet owns a supply majority", () => {
    const owners = [{ address: A, count: 60 }, { address: B, count: 20 }, { address: C, count: 20 }];
    const r = analyzeOwnershipConcentration({ owners, totalSupply: 100 });
    expect(r.analysis.metrics.top1ShareOfTotal).toBeCloseTo(0.6, 6);
    expect(r.analysis.band).toBe("concentrated");
  });

  it("overlays wash clusters so clustered-supply share is populated", () => {
    const owners = [{ address: A, count: 10 }, { address: B, count: 10 }, { address: C, count: 5 }];
    const clusterOf = new Map([[A, "wash-0"], [B, "wash-0"]]);
    const r = analyzeOwnershipConcentration({ owners, totalSupply: 25, clusterOf });
    // cluster {A,B} holds 20 of 25 total supply
    expect(r.analysis.metrics.clusteredSupplyShareOfTotal).toBeCloseTo(20 / 25, 6);
  });
});

// The venue's own bidder (lib/house/houseRegistry.json). It buys up to its quantity from
// whoever sells, so an honest seller who fills two units of one house bid traded with it
// "twice one way", the very fingerprint a coordinated pair leaves. Here the list is passed
// in; the committed registry is empty.
describe("house trades: the venue's own bidder never makes a seller look coordinated", () => {
  const HOUSE = "0x8ba1f109551bd432803012645ac136ddd64dba72";
  const HOUSE2 = "0x" + "e".repeat(40);
  const sold = (from, to, id, price, time) => ({ fromFull: from, toFull: to, token: { id }, price, time });

  it("a seller who sells 2 NFTs into a house bid is NOT clustered with the house", () => {
    const sales = [sold(A, HOUSE, 1, 0.04, 1), sold(A, HOUSE, 2, 0.04, 2)];
    const r = analyzeWashTrading(sales, { houseWallets: [HOUSE] });
    expect(r.coordinatedClusters.count).toBe(0);
    expect(r.coordinatedClusters.internalSales).toBe(0);
    expect(r.suspect.sales).toBe(0);
    expect(r.suspect.volumeEth).toBe(0);
  });

  it("lists every house trade apart, with its side, under the house's own heading", () => {
    const sales = [sold(A, HOUSE, 1, 0.04, 1), sold(HOUSE, B, 1, 0.05, 2), sold(C, D, 9, 1, 3)];
    const r = analyzeWashTrading(sales, { houseWallets: [HOUSE.toUpperCase().replace("0X", "0x")] });
    expect(r.houseTrades.count).toBe(2);
    expect(r.houseTrades.volumeEth).toBeCloseTo(0.09, 9);
    expect(r.houseTrades.trades.map((t) => [t.side, t.seller, t.buyer])).toEqual([
      ["bought", A, HOUSE],
      ["sold", HOUSE, B],
    ]);
    // The sales still count as sales: nothing is hidden from the window's totals.
    expect(r.comparableSales).toBe(3);
  });

  it("the same two sales between two outside wallets are still a coordinated pair (control)", () => {
    const r = analyzeWashTrading([sold(A, B, 1, 0.04, 1), sold(A, B, 2, 0.04, 2)], { houseWallets: [HOUSE] });
    expect(r.coordinatedClusters.count).toBe(1);
    expect(r.houseTrades.count).toBe(0);
  });

  it("two house wallets trading with each other ARE clustered: the venue trading with itself stays visible", () => {
    const r = analyzeWashTrading([sold(HOUSE, HOUSE2, 1, 0.04, 1), sold(HOUSE2, HOUSE, 1, 0.04, 2)], { houseWallets: [HOUSE, HOUSE2] });
    expect(r.coordinatedClusters.count).toBe(1);
    expect(r.coordinatedClusters.clusters[0].wallets).toEqual([HOUSE, HOUSE2].sort());
    expect(r.houseTrades.count).toBe(2);
  });

  it("a house wallet selling to itself is still a same-wallet sale", () => {
    const r = analyzeWashTrading([sold(HOUSE, HOUSE, 1, 0.04, 1)], { houseWallets: [HOUSE] });
    expect(r.selfSales.count).toBe(1);
    expect(r.suspect.sales).toBe(1);
  });

  it("a house trade does not join an outside seller to the house in a larger group either", () => {
    // A and B are a real reciprocal pair; A also sold twice into the house bid.
    const sales = [sold(A, B, 1, 1, 1), sold(B, A, 1, 1, 2), sold(A, HOUSE, 2, 0.04, 3), sold(A, HOUSE, 3, 0.04, 4)];
    const { clusters, clusterOf } = buildTradeClusters(sales.map(normalizeSale), { isHouse: (a) => a === HOUSE });
    expect(clusters.map((c) => c.wallets)).toEqual([[A, B].sort()]);
    expect(clusterOf.has(HOUSE)).toBe(false);
  });

  it("the ownership overlay never counts the house's holdings as coordinated with its sellers", () => {
    const sales = [sold(A, HOUSE, 1, 0.04, 1), sold(A, HOUSE, 2, 0.04, 2)];
    const owners = [{ address: A, count: 10 }, { address: HOUSE, count: 2 }, { address: C, count: 13 }];
    const r = computeMarketIntegrity({ sales, listings: [], owners, totalSupply: 25, houseWallets: [HOUSE] });
    expect(r.wash.coordinatedClusters.count).toBe(0);
    expect(r.ownership.analysis.metrics.clusteredSupplyShareOfTotal ?? 0).toBe(0);
  });

  it("with the committed registry (empty) every wallet is measured exactly as before", () => {
    const r = analyzeWashTrading([sold(A, HOUSE, 1, 0.04, 1), sold(A, HOUSE, 2, 0.04, 2)]);
    expect(r.coordinatedClusters.count).toBe(1);
    expect(r.houseTrades).toEqual({ count: 0, volumeEth: 0, trades: [] });
  });
});

describe("computeMarketIntegrity", () => {
  it("self-gates every section and reports low data-confidence when all feeds are empty", () => {
    const r = computeMarketIntegrity({ sales: [], listings: [], owners: [] });
    expect(r.wash.measured).toBe(false);
    expect(r.floor.measured).toBe(false);
    expect(r.ownership.measured).toBe(false);
    expect(r.dataConfidence.level).toBe("low");
    expect(r.method.version).toBe("nft-integrity/1.0.0");
    expect(typeof r.correctionPath).toBe("string");
  });

  it("propagates the wash-graph clusters into the ownership overlay", () => {
    const sales = [
      { fromFull: A, toFull: B, token: { id: 1 }, price: 1, time: 1 },
      { fromFull: B, toFull: A, token: { id: 1 }, price: 1, time: 2 },
    ];
    const owners = [{ address: A, count: 10 }, { address: B, count: 10 }, { address: C, count: 5 }];
    const r = computeMarketIntegrity({ sales, listings: [], owners, totalSupply: 25 });
    expect(r.wash.coordinatedClusters.count).toBe(1);
    expect(r.ownership.analysis.metrics.clusteredSupplyShareOfTotal).toBeCloseTo(20 / 25, 6);
  });
});
