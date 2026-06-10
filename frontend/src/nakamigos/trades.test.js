import { describe, it, expect } from "vitest";
import { buildTradeOrderParameters, MAX_ITEMS_PER_SIDE } from "./lib/trades";
import { WETH, CONDUIT_KEY } from "./constants";

const MAKER = "0x1111111111111111111111111111111111111111";
const NAKA = "0xd774557b647330C91Bf44cfEAB205095f7E6c367";
const JBAC = "0xd37264c71e9AF940E49795f0D3A8336aFAaFdda9";
const SALT = "0x" + "ab".repeat(32);
const T0 = 1_780_000_000;
const T1 = T0 + 72 * 3600;

const base = (overrides = {}) => buildTradeOrderParameters({
  maker: MAKER,
  give: [{ contract: NAKA, tokenId: "1315" }],
  get: [{ contract: JBAC, tokenId: "420" }],
  startTime: T0,
  endTime: T1,
  salt: SALT,
  ...overrides,
});

describe("buildTradeOrderParameters", () => {
  it("builds an NFT-for-NFT order: maker offers ERC721s, requested NFTs route to maker", () => {
    const p = base();
    expect(p.offerer).toBe(MAKER);
    expect(p.offer).toEqual([{
      itemType: 2, token: NAKA, identifierOrCriteria: "1315", startAmount: "1", endAmount: "1",
    }]);
    expect(p.consideration).toEqual([{
      itemType: 2, token: JBAC, identifierOrCriteria: "420", startAmount: "1", endAmount: "1",
      recipient: MAKER,
    }]);
    expect(p.totalOriginalConsiderationItems).toBe(1);
    expect(p.conduitKey).toBe(CONDUIT_KEY);
    expect(p.startTime).toBe(String(T0));
    expect(p.endTime).toBe(String(T1));
  });

  it("uses FULL_OPEN (0), never FULL_RESTRICTED (2) which is unfulfillable with a zero zone", () => {
    const p = base();
    expect(p.orderType).toBe(0);
    expect(p.zone).toBe("0x0000000000000000000000000000000000000000");
  });

  it("appends a maker WETH sweetener as an ERC20 offer item (Seaport cannot pull native ETH from a maker)", () => {
    const p = base({ wethTopupWei: "50000000000000000" });
    expect(p.offer).toHaveLength(2);
    const weth = p.offer[1];
    expect(weth.itemType).toBe(1);
    expect(weth.token).toBe(WETH);
    expect(weth.startAmount).toBe("50000000000000000");
  });

  it("appends taker native-ETH topup as itemType 0 consideration paid to the maker", () => {
    const p = base({ ethTopupWei: "20000000000000000" });
    expect(p.consideration).toHaveLength(2);
    const eth = p.consideration[1];
    expect(eth.itemType).toBe(0);
    expect(eth.token).toBe("0x0000000000000000000000000000000000000000");
    expect(eth.recipient).toBe(MAKER);
    expect(p.totalOriginalConsiderationItems).toBe(2);
  });

  it("zero topups add no extra items", () => {
    const p = base({ wethTopupWei: "0", ethTopupWei: "0" });
    expect(p.offer).toHaveLength(1);
    expect(p.consideration).toHaveLength(1);
  });

  it("supports multi-NFT sides up to the cap and rejects beyond it", () => {
    const many = (contract, n) => Array.from({ length: n }, (_, i) => ({ contract, tokenId: String(i) }));
    const ok = base({ give: many(NAKA, MAX_ITEMS_PER_SIDE), get: many(JBAC, MAX_ITEMS_PER_SIDE) });
    expect(ok.offer).toHaveLength(MAX_ITEMS_PER_SIDE);
    expect(ok.consideration).toHaveLength(MAX_ITEMS_PER_SIDE);
    expect(ok.consideration.every(c => c.recipient === MAKER)).toBe(true);

    expect(() => base({ give: many(NAKA, MAX_ITEMS_PER_SIDE + 1) })).toThrow(/Max/);
    expect(() => base({ get: many(JBAC, MAX_ITEMS_PER_SIDE + 1) })).toThrow(/Max/);
    expect(() => base({ give: [] })).toThrow(/at least one/);
    expect(() => base({ get: [] })).toThrow(/at least one/);
  });

  it("stringifies numeric token ids", () => {
    const p = base({ give: [{ contract: NAKA, tokenId: 7 }] });
    expect(p.offer[0].identifierOrCriteria).toBe("7");
  });
});
