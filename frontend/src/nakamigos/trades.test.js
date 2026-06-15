import { describe, it, expect } from "vitest";
import { buildTradeOrderParameters, buildCriteriaResolvers, currentLegAmounts, MAX_ITEMS_PER_SIDE, fillableHoldings } from "./lib/trades";
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

  it("builds wildcard slots as itemType 4 with criteria 0 (any token from collection)", () => {
    const p = base({ get: [{ contract: JBAC, any: true }, { contract: NAKA, any: true }] });
    expect(p.consideration[0]).toEqual({
      itemType: 4, token: JBAC, identifierOrCriteria: "0",
      startAmount: "1", endAmount: "1", recipient: MAKER,
    });
    expect(p.consideration[1].itemType).toBe(4);
    expect(p.consideration[1].token).toBe(NAKA);
  });
});

describe("buildCriteriaResolvers", () => {
  const openParams = () => base({
    get: [{ contract: JBAC, any: true }, { contract: JBAC, any: true }],
    ethTopupWei: "10000000000000000", // adds an itemType-0 leg AFTER the wildcards
  });

  it("resolves each wildcard slot to the chosen token with an empty proof", () => {
    const resolvers = buildCriteriaResolvers(openParams(), { 0: "420", 1: "777" });
    expect(resolvers).toEqual([
      { orderIndex: 0, side: 1, index: 0, identifier: "420", criteriaProof: [] },
      { orderIndex: 0, side: 1, index: 1, identifier: "777", criteriaProof: [] },
    ]);
  });

  it("ignores non-criteria items (the ETH leg needs no resolver)", () => {
    const p = openParams();
    expect(p.consideration).toHaveLength(3);
    const resolvers = buildCriteriaResolvers(p, { 0: "1", 1: "2" });
    expect(resolvers).toHaveLength(2);
  });

  it("throws on a missing selection, a bad id, or the same token in two slots", () => {
    expect(() => buildCriteriaResolvers(openParams(), { 0: "420" })).toThrow(/needs a token/);
    expect(() => buildCriteriaResolvers(openParams(), { 0: "420", 1: "abc" })).toThrow(/needs a token/);
    expect(() => buildCriteriaResolvers(openParams(), { 0: "420", 1: "420" })).toThrow(/more than one slot/);
  });

  it("returns [] for a fully-specific (directed) trade", () => {
    expect(buildCriteriaResolvers(base(), {})).toEqual([]);
  });
});

describe("dutch trades — dynamic cash legs", () => {
  it("builder emits asymmetric start/end on cash legs while NFT legs stay 1/1", () => {
    const p = base({
      wethTopupWei: "1000", wethTopupEndWei: "5000",
      ethTopupWei: "9000", ethTopupEndWei: "3000",
    });
    const weth = p.offer.find(i => i.itemType === 1);
    expect(weth.startAmount).toBe("1000");
    expect(weth.endAmount).toBe("5000");
    const eth = p.consideration.find(i => i.itemType === 0);
    expect(eth.startAmount).toBe("9000");
    expect(eth.endAmount).toBe("3000");
    expect(p.offer[0].startAmount).toBe("1");
    expect(p.offer[0].endAmount).toBe("1");
  });

  it("end amounts default to start (static legs)", () => {
    const p = base({ wethTopupWei: "1000" });
    const weth = p.offer.find(i => i.itemType === 1);
    expect(weth.endAmount).toBe("1000");
  });

  it("currentLegAmounts interpolates linearly and clamps to the window", () => {
    const p = base({
      wethTopupWei: "0", wethTopupEndWei: "1000",   // rising sweetener
      ethTopupWei: "1000", ethTopupEndWei: "0",      // decaying ask
    });
    // T0..T1 is 72h; midpoint → half of each leg
    const mid = currentLegAmounts(p, T0 + (T1 - T0) / 2);
    expect(mid.wethNowWei).toBe(500n);
    expect(mid.ethNowWei).toBe(500n);
    expect(mid.wethRising).toBe(true);
    expect(mid.ethDecaying).toBe(true);

    const before = currentLegAmounts(p, T0 - 999);
    expect(before.wethNowWei).toBe(0n);
    expect(before.ethNowWei).toBe(1000n);

    const after = currentLegAmounts(p, T1 + 999);
    expect(after.wethNowWei).toBe(1000n);
    expect(after.ethNowWei).toBe(0n);
  });

  it("static legs report no dynamics and constant amounts", () => {
    const p = base({ wethTopupWei: "700", ethTopupWei: "300" });
    const now = currentLegAmounts(p, T0 + 1234);
    expect(now.wethNowWei).toBe(700n);
    expect(now.ethNowWei).toBe(300n);
    expect(now.wethRising).toBe(false);
    expect(now.ethDecaying).toBe(false);
  });
});

describe("fillableHoldings — board 'you can fill this' discovery", () => {
  const TAKER = "0x2222222222222222222222222222222222222222";
  const naka = NAKA.toLowerCase();
  const jbac = JBAC.toLowerCase();
  // An open board post requesting "any 1 NAKA".
  const openPost = (overrides = {}) => ({
    status: "active",
    offerer: MAKER,
    requested: [{ contract: NAKA, any: true }],
    ...overrides,
  });

  it("returns the holding count when the wallet can fill a single-slot post", () => {
    expect(fillableHoldings(openPost(), TAKER, { [naka]: 3 })).toBe(3);
  });

  it("returns 0 when the wallet holds none of the requested collection", () => {
    expect(fillableHoldings(openPost(), TAKER, { [naka]: 0 })).toBe(0);
    expect(fillableHoldings(openPost(), TAKER, {})).toBe(0);
  });

  it("returns 0 for the maker's own post (case-insensitive)", () => {
    expect(fillableHoldings(openPost(), MAKER.toUpperCase(), { [naka]: 5 })).toBe(0);
  });

  it("returns 0 for a non-active post", () => {
    expect(fillableHoldings(openPost({ status: "accepted" }), TAKER, { [naka]: 5 })).toBe(0);
  });

  it("requires >= the slot count when a post asks for multiple of one collection", () => {
    const twoNaka = openPost({ requested: [{ contract: NAKA, any: true }, { contract: NAKA, any: true }] });
    expect(fillableHoldings(twoNaka, TAKER, { [naka]: 1 })).toBe(0);
    expect(fillableHoldings(twoNaka, TAKER, { [naka]: 2 })).toBe(2);
  });

  it("requires holdings in EVERY requested collection (min across constraints)", () => {
    const mixed = openPost({ requested: [{ contract: NAKA, any: true }, { contract: JBAC, any: true }] });
    expect(fillableHoldings(mixed, TAKER, { [naka]: 4, [jbac]: 0 })).toBe(0);
    expect(fillableHoldings(mixed, TAKER, { [naka]: 4, [jbac]: 2 })).toBe(2);
  });

  it("returns 0 if any requested slot is a specific token (not a wildcard)", () => {
    const specific = openPost({ requested: [{ contract: NAKA, tokenId: "7", any: false }] });
    expect(fillableHoldings(specific, TAKER, { [naka]: 9 })).toBe(0);
  });

  it("returns 0 with no wallet, no trade, or empty requested", () => {
    expect(fillableHoldings(openPost(), null, { [naka]: 3 })).toBe(0);
    expect(fillableHoldings(null, TAKER, { [naka]: 3 })).toBe(0);
    expect(fillableHoldings(openPost({ requested: [] }), TAKER, { [naka]: 3 })).toBe(0);
  });
});
