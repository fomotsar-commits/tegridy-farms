import { describe, it, expect } from "vitest";
import { hashStruct, hashTypedData, hashDomain } from "viem";
import {
  SEAPORT_16_ADDRESS, OPENSEA_SIGNED_ZONE, OPENSEA_CONDUIT_KEY, ZERO_HASH, BID_WETH_BY_CHAIN, SEAPORT_ORDER_TYPES,
  PRICE_TICK_WEI, ORDER_TYPE, roundUnitPriceDown, isOnPriceTick, orderTypeFor, validateBuildResponse,
  buildBidParameters, typedDataFor, seaport16Domain, wethApprovalTarget,
} from "./seaportOffer";
import * as constants from "../constants";

// The bidder in every fixture: the address of keccak256("house-bidder test key 1"),
// a fresh key with no code on mainnet or Base (eth_getCode "0x", read 2026-11-16).
const BIDDER = "0xBd00483Ccb69C4fCc2F9f28E87FC29eeb308EFFA";
const JBAC = "0xd37264c71e9af940e49795F0d3a8336afAaFDdA9";
const GNSS = "0xa1De9f93c56C290C48849B1393b09eB616D55dbb";
const BOJUNGLES = "0x36aFeE4FaDC3b77Ff5f1f9a040E264150aFb979A";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const BASE_WETH = "0x4200000000000000000000000000000000000006";
const OPENSEA_FEE = "0x0000a26b00c1F0DF003000390027140000fAa719";
const VENUE_SAFE = "0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d";
const OS_1PCT = [{ recipient: OPENSEA_FEE, bps: 100 }];
const SALT = "0xbec43592d2dbea11d8fc3e3681600bd71076026dd0cde45c6e36453565b1a686"; // keccak256("p0a fixture salt")
const T0 = 1763251200;
const T1 = 1763253000;

// OpenSea's live `offers/build` answers (POST with protocol_address = Seaport 1.6 and
// offer_protection_enabled, offerer BIDDER), 2026-11-16, word for word: lowercase
// addresses, one NFT line, the SignedZone, a zero zoneHash, no fee lines.
const liveBuild = (token, quantity, criteria = "0") => ({
  consideration: [{
    itemType: 4, token, identifierOrCriteria: criteria,
    startAmount: String(quantity), endAmount: String(quantity), recipient: BIDDER.toLowerCase(),
  }],
  zone: "0x000056f7000000ece9003ca63978907a00ffd100",
  zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
});
const JBAC_LC = JBAC.toLowerCase();
const GNSS_LC = GNSS.toLowerCase();
// The JBAC "Background: Green" trait build: OpenSea answered a merkle root, not "0".
const TRAIT_ROOT = "56437522607701336082983860045218093671644625055155094843624326587536835527173";

describe("the pinned constants are the app's own", () => {
  it("match constants.js and the 2026-11-15 facts", () => {
    expect(SEAPORT_16_ADDRESS).toBe(constants.SEAPORT_16_ADDRESS);
    expect(OPENSEA_CONDUIT_KEY).toBe(constants.CONDUIT_KEY);
    expect(BID_WETH_BY_CHAIN[1]).toBe(constants.WETH_BY_CHAIN[1]);
    expect(BID_WETH_BY_CHAIN[8453]).toBe(constants.WETH_BY_CHAIN[8453]);
    expect(SEAPORT_ORDER_TYPES).toEqual(constants.SEAPORT_ORDER_TYPES);
    expect(OPENSEA_SIGNED_ZONE.toLowerCase()).toBe("0x000056f7000000ece9003ca63978907a00ffd100");
    expect(ZERO_HASH).toBe("0x" + "0".repeat(64));
  });
});

describe("the price tick", () => {
  it("rounds a unit price DOWN to 0.00001 ETH, never up", () => {
    expect(PRICE_TICK_WEI).toBe(10_000_000_000_000n);
    expect(roundUnitPriceDown(12_345_678_901_234_567n)).toBe(12_340_000_000_000_000n);
    expect(roundUnitPriceDown(10_000_000_000_000n - 1n)).toBe(0n);
    expect(roundUnitPriceDown(20_000_000_000_000_000n)).toBe(20_000_000_000_000_000n);
    expect(roundUnitPriceDown("19999999999999999")).toBe(19_990_000_000_000_000n);
    expect(() => roundUnitPriceDown(-1n)).toThrow();
    expect(isOnPriceTick(20_000_000_000_000_000n)).toBe(true);
    expect(isOnPriceTick(20_000_000_000_000_001n)).toBe(false);
  });

  it("on the tick, every whole-bps fee is exact and divides by the quantity", () => {
    for (const unit of [PRICE_TICK_WEI, 37n * PRICE_TICK_WEI, 4_500n * PRICE_TICK_WEI, 123_457n * PRICE_TICK_WEI]) {
      for (const qty of [1, 2, 3, 7, 10]) {
        for (const bps of [1, 50, 100, 250, 369, 700]) {
          const p = buildBidParameters({
            chainId: 1, offerer: BIDDER, kind: "collection", collectionContract: JBAC, quantity: qty,
            unitPriceWei: unit, feeLines: [{ recipient: OPENSEA_FEE, bps }], build: liveBuild(JBAC_LC, qty),
            startTime: T0, endTime: T1, salt: SALT,
          });
          const offer = BigInt(p.offer[0].startAmount);
          const fee = BigInt(p.consideration[1].startAmount);
          expect(offer).toBe(unit * BigInt(qty));
          expect(fee * 10000n).toBe(offer * BigInt(bps));
          expect(fee % BigInt(qty)).toBe(0n);
          expect(offer % BigInt(qty)).toBe(0n);
        }
      }
    }
  });

  it("an off-tick or zero unit price is never built", () => {
    const base = { chainId: 1, offerer: BIDDER, kind: "item", collectionContract: JBAC, tokenId: "1", quantity: 1, feeLines: OS_1PCT, startTime: T0, endTime: T1, salt: SALT };
    expect(() => buildBidParameters({ ...base, unitPriceWei: 10_000_000_000_001n })).toThrow(/tick/);
    expect(() => buildBidParameters({ ...base, unitPriceWei: 0n })).toThrow(/above zero/);
  });
});

describe("orderTypeFor copies OpenSea's SDK", () => {
  it("is PARTIAL_RESTRICTED (3) for every bid, quantity 1 included", () => {
    // opensea-js: restrictedByZone true + allowPartialFills true; seaport-js maps that to 3.
    expect(orderTypeFor("collection", 1)).toBe(ORDER_TYPE.PARTIAL_RESTRICTED);
    expect(orderTypeFor("collection", 2)).toBe(3);
    expect(orderTypeFor("trait", 1)).toBe(3);
    expect(orderTypeFor("item", 1)).toBe(3);
  });

  it("refuses a call that cannot be a bid", () => {
    expect(() => orderTypeFor("item", 2)).toThrow();
    expect(() => orderTypeFor("listing", 1)).toThrow();
    expect(() => orderTypeFor("collection", 0)).toThrow();
    expect(() => orderTypeFor("collection", 1.5)).toThrow();
  });
});

describe("validateBuildResponse holds OpenSea's build to the bid", () => {
  const ask = (over = {}) => ({ collectionContract: JBAC, offerer: BIDDER, kind: "collection", quantity: 1, ...over });
  const mutate = (fn, quantity = 1) => { const b = liveBuild(JBAC_LC, quantity); fn(b); return b; };
  const refusedAt = (build, opts) => {
    const r = validateBuildResponse(build, ask(opts));
    expect(r, "the build was let through").not.toBeNull();
    return r;
  };

  it("passes every live answer (any address case)", () => {
    expect(validateBuildResponse(liveBuild(JBAC_LC, 1), ask())).toBeNull();
    expect(validateBuildResponse(liveBuild(JBAC_LC, 2), ask({ quantity: 2 }))).toBeNull();
    expect(validateBuildResponse(liveBuild(GNSS_LC, 1), ask({ collectionContract: GNSS }))).toBeNull();
    expect(validateBuildResponse(liveBuild(JBAC_LC, 1, TRAIT_ROOT), ask({ kind: "trait" }))).toBeNull();
    expect(validateBuildResponse(liveBuild(JBAC, 1), ask({ offerer: BIDDER.toLowerCase() }))).toBeNull();
  });

  it("pin kind: only a collection or trait bid has a build", () => {
    expect(refusedAt(liveBuild(JBAC_LC, 1), { kind: "item" }).field).toBe("kind");
  });

  it("pin shape: no answer, or no consideration list", () => {
    expect(refusedAt(null).field).toBe("shape");
    expect(refusedAt({ zone: OPENSEA_SIGNED_ZONE, zoneHash: ZERO_HASH }).field).toBe("shape");
  });

  it("pin no-nft-line: an answer with no NFT line", () => {
    const r = refusedAt(mutate((b) => { b.consideration = [{ itemType: 1, token: WETH, identifierOrCriteria: "0", startAmount: "1", endAmount: "1", recipient: BIDDER }]; }));
    expect(r).toMatchObject({ error: "nft-mismatch", field: "consideration" });
  });

  it("pin token: the NFT line names another contract", () => {
    expect(refusedAt(mutate((b) => { b.consideration[0].token = GNSS_LC; }))).toMatchObject({ error: "nft-mismatch", field: "token" });
  });

  it("pin token: a second, foreign NFT line beside the right one", () => {
    const r = refusedAt(mutate((b) => { b.consideration.push({ ...b.consideration[0], token: GNSS_LC }); }));
    expect(r).toMatchObject({ error: "nft-mismatch", field: "token" });
  });

  it("pin one-line: ANY extra line is refused, a fee line included", () => {
    const extraFee = mutate((b) => { b.consideration.push({ itemType: 1, token: WETH, identifierOrCriteria: "0", startAmount: "1", endAmount: "1", recipient: OPENSEA_FEE }); });
    expect(refusedAt(extraFee)).toMatchObject({ error: "nft-mismatch", field: "consideration" });
    const twice = mutate((b) => { b.consideration.push({ ...b.consideration[0] }); });
    expect(refusedAt(twice)).toMatchObject({ error: "nft-mismatch", field: "consideration" });
  });

  it("pin itemType: a single-token line or an ERC-1155 criteria line", () => {
    expect(refusedAt(mutate((b) => { b.consideration[0].itemType = 2; }))).toMatchObject({ error: "nft-mismatch", field: "itemType" });
    expect(refusedAt(mutate((b) => { b.consideration[0].itemType = 5; }))).toMatchObject({ error: "nft-mismatch", field: "itemType" });
  });

  it("pin recipient: the NFT goes to someone else", () => {
    const r = refusedAt(mutate((b) => { b.consideration[0].recipient = "0x" + "e".repeat(40); }));
    expect(r).toMatchObject({ error: "wrong-recipient", field: "recipient" });
  });

  it("pin startAmount / endAmount: a different quantity than asked", () => {
    expect(refusedAt(mutate((b) => { b.consideration[0].startAmount = "2"; })).field).toBe("startAmount");
    expect(refusedAt(mutate((b) => { b.consideration[0].endAmount = "2"; })).field).toBe("endAmount");
    expect(refusedAt(liveBuild(JBAC_LC, 1), { quantity: 2 }).field).toBe("startAmount");
  });

  it("pin criteria: a collection bid is for ANY token (criteria 0)", () => {
    expect(refusedAt(mutate((b) => { b.consideration[0].identifierOrCriteria = TRAIT_ROOT; })).field).toBe("criteria");
  });

  it("pin trait-criteria: a trait bid's criteria is a whole uint256", () => {
    expect(refusedAt(mutate((b) => { b.consideration[0].identifierOrCriteria = "0xdeadbeef"; }), { kind: "trait" }).field).toBe("criteria");
    expect(refusedAt(mutate((b) => { b.consideration[0].identifierOrCriteria = "1" + "0".repeat(78); }), { kind: "trait" }).field).toBe("criteria");
  });

  it("pin zone: only OpenSea's SignedZone", () => {
    expect(refusedAt(mutate((b) => { b.zone = "0x" + "0".repeat(40); })).field).toBe("zone");
    expect(refusedAt(mutate((b) => { b.zone = "0x004C00500000aD104D7DBd00e3ae0A5C00560C00"; })).field).toBe("zone");
  });

  it("pin zoneHash: zero", () => {
    expect(refusedAt(mutate((b) => { b.zoneHash = "0x" + "1".padStart(64, "0"); })).field).toBe("zoneHash");
  });

  it("pin conduitKey: a build naming another conduit is refused (the bid pins OpenSea's)", () => {
    expect(refusedAt(mutate((b) => { b.conduitKey = "0x" + "1".repeat(64); })).field).toBe("conduitKey");
    expect(validateBuildResponse(mutate((b) => { b.conduitKey = OPENSEA_CONDUIT_KEY.toUpperCase().replace("0X", "0x"); }), ask())).toBeNull();
  });

  it("pin orderType: a build naming an open or contract order is refused", () => {
    for (const t of [0, 1, 4]) expect(refusedAt(mutate((b) => { b.orderType = t; })).field).toBe("orderType");
    for (const t of [2, 3]) expect(validateBuildResponse(mutate((b) => { b.orderType = t; }), ask())).toBeNull();
  });
});

describe("buildBidParameters: the exact bid", () => {
  const common = { offerer: BIDDER, startTime: T0, endTime: T1, salt: SALT };
  const signed = {
    zone: OPENSEA_SIGNED_ZONE, orderType: 3, startTime: String(T0), endTime: String(T1),
    zoneHash: ZERO_HASH, salt: SALT, conduitKey: OPENSEA_CONDUIT_KEY,
  };
  const wethLine = (token, amount, recipient) => ({ itemType: 1, token, identifierOrCriteria: "0", startAmount: amount, endAmount: amount, recipient });

  it("a collection bid for 1", () => {
    expect(buildBidParameters({ ...common, chainId: 1, kind: "collection", collectionContract: JBAC, quantity: 1, unitPriceWei: 35_000_000_000_000_000n, feeLines: OS_1PCT, build: liveBuild(JBAC_LC, 1) })).toEqual({
      offerer: BIDDER,
      ...signed,
      offer: [{ itemType: 1, token: WETH, identifierOrCriteria: "0", startAmount: "35000000000000000", endAmount: "35000000000000000" }],
      consideration: [
        { itemType: 4, token: JBAC_LC, identifierOrCriteria: "0", startAmount: "1", endAmount: "1", recipient: BIDDER },
        wethLine(WETH, "350000000000000", OPENSEA_FEE),
      ],
      totalOriginalConsiderationItems: 2,
    });
  });

  it("a collection bid for 2: the offer and every fee are for both, and divide by 2", () => {
    expect(buildBidParameters({ ...common, chainId: 1, kind: "collection", collectionContract: JBAC, quantity: 2, unitPriceWei: 20_000_000_000_000_000n, feeLines: OS_1PCT, build: liveBuild(JBAC_LC, 2) })).toEqual({
      offerer: BIDDER,
      ...signed,
      offer: [{ itemType: 1, token: WETH, identifierOrCriteria: "0", startAmount: "40000000000000000", endAmount: "40000000000000000" }],
      consideration: [
        { itemType: 4, token: JBAC_LC, identifierOrCriteria: "0", startAmount: "2", endAmount: "2", recipient: BIDDER },
        wethLine(WETH, "400000000000000", OPENSEA_FEE),
      ],
      totalOriginalConsiderationItems: 2,
    });
  });

  it("a trait bid for 1 and for 2 carries OpenSea's criteria root", () => {
    for (const quantity of [1, 2]) {
      const p = buildBidParameters({ ...common, chainId: 1, kind: "trait", collectionContract: JBAC, quantity, unitPriceWei: 45_000_000_000_000_000n, feeLines: OS_1PCT, build: liveBuild(JBAC_LC, quantity, TRAIT_ROOT) });
      const total = String(45_000_000_000_000_000n * BigInt(quantity));
      const fee = String(450_000_000_000_000n * BigInt(quantity));
      expect(p).toEqual({
        offerer: BIDDER,
        ...signed,
        offer: [{ itemType: 1, token: WETH, identifierOrCriteria: "0", startAmount: total, endAmount: total }],
        consideration: [
          { itemType: 4, token: JBAC_LC, identifierOrCriteria: TRAIT_ROOT, startAmount: String(quantity), endAmount: String(quantity), recipient: BIDDER },
          wethLine(WETH, fee, OPENSEA_FEE),
        ],
        totalOriginalConsiderationItems: 2,
      });
    }
  });

  it("a bid on one NFT: itemType 2, that token, for 1", () => {
    expect(buildBidParameters({ ...common, chainId: 1, kind: "item", collectionContract: JBAC, tokenId: 1, quantity: 1, unitPriceWei: 30_000_000_000_000_000n, feeLines: OS_1PCT })).toEqual({
      offerer: BIDDER,
      ...signed,
      offer: [{ itemType: 1, token: WETH, identifierOrCriteria: "0", startAmount: "30000000000000000", endAmount: "30000000000000000" }],
      consideration: [
        { itemType: 2, token: JBAC, identifierOrCriteria: "1", startAmount: "1", endAmount: "1", recipient: BIDDER },
        wethLine(WETH, "300000000000000", OPENSEA_FEE),
      ],
      totalOriginalConsiderationItems: 2,
    });
  });

  it("a bid on one NFT on Base pays in Base WETH, on the same Seaport and zone", () => {
    const p = buildBidParameters({ ...common, chainId: 8453, kind: "item", collectionContract: BOJUNGLES, tokenId: "7", quantity: 1, unitPriceWei: 1_000_000_000_000_000n, feeLines: OS_1PCT });
    expect(p.offer).toEqual([{ itemType: 1, token: BASE_WETH, identifierOrCriteria: "0", startAmount: "1000000000000000", endAmount: "1000000000000000" }]);
    expect(p.consideration).toEqual([
      { itemType: 2, token: BOJUNGLES, identifierOrCriteria: "7", startAmount: "1", endAmount: "1", recipient: BIDDER },
      wethLine(BASE_WETH, "10000000000000", OPENSEA_FEE),
    ]);
    expect(p.zone).toBe(OPENSEA_SIGNED_ZONE);
  });

  it("a venue line, when asked for, is one more exact line", () => {
    const p = buildBidParameters({ ...common, chainId: 1, kind: "collection", collectionContract: JBAC, quantity: 2, unitPriceWei: 20_000_000_000_000_000n, feeLines: [...OS_1PCT, { recipient: VENUE_SAFE, bps: 50 }], build: liveBuild(JBAC_LC, 2) });
    expect(p.consideration.slice(1)).toEqual([wethLine(WETH, "400000000000000", OPENSEA_FEE), wethLine(WETH, "200000000000000", VENUE_SAFE)]);
    expect(p.totalOriginalConsiderationItems).toBe(3);
  });

  it("never builds from a build it would refuse, even when the caller skipped the check", () => {
    const bad = liveBuild(GNSS_LC, 1);
    expect(() => buildBidParameters({ ...common, chainId: 1, kind: "collection", collectionContract: JBAC, quantity: 1, unitPriceWei: 10_000_000_000_000_000n, feeLines: OS_1PCT, build: bad }))
      .toThrow(expect.objectContaining({ code: "nft-mismatch", field: "token" }));
  });

  it("refuses what cannot be a bid", () => {
    const item = { ...common, chainId: 1, kind: "item", collectionContract: JBAC, tokenId: "1", quantity: 1, unitPriceWei: 10_000_000_000_000_000n, feeLines: OS_1PCT };
    expect(() => buildBidParameters({ ...item, quantity: 2 })).toThrow();
    expect(() => buildBidParameters({ ...item, chainId: 137 })).toThrow();
    expect(() => buildBidParameters({ ...item, tokenId: "abc" })).toThrow();
    expect(() => buildBidParameters({ ...item, endTime: T0 })).toThrow();
    expect(() => buildBidParameters({ ...item, feeLines: [{ recipient: OPENSEA_FEE, bps: 10000 }] })).toThrow();
    expect(() => buildBidParameters({ ...item, feeLines: [{ recipient: "0xnope", bps: 100 }] })).toThrow();
    expect(() => buildBidParameters({ ...item, feeLines: [{ recipient: OPENSEA_FEE, bps: 1.5 }] })).toThrow();
  });
});

// ═══ What Seaport 1.6 ITSELF said about these bids (eth_call, read-only, 2026-11-16) ═══
//
// `getOrderHash(components)` returns the ORDER HASH, the EIP-712 struct hash of
// OrderComponents; a wallet signs keccak256(0x1901 ++ domainSeparator ++ orderHash),
// with Seaport's own separator from `information()`. Both were read on Ethereum and on
// Base and are pinned here, so typedDataFor's message AND domain are held to the contract.
// Raw: dev/bidbot-2026-11-15/build-p0a/raw/live-orderhash.json (outside the repo).
describe("typedDataFor hashes to what Seaport 1.6 computes", () => {
  const SEPARATOR = {
    1: "0xfce34bc6e1752c1117e5063116d25cad2fa2bdcf15ff2d2e275eece7dc31ba64",
    8453: "0x1965c52d779fea3b2c530bc1bbedc135c9671ade2fa4748307d92dbcdb47b2e0",
  };
  const FIXTURES = [
    {
      name: "JBAC collection bid for 2 (Ethereum)", chainId: 1,
      args: { kind: "collection", collectionContract: JBAC, quantity: 2, unitPriceWei: 20_000_000_000_000_000n, feeLines: OS_1PCT, build: liveBuild(JBAC_LC, 2) },
      orderHash: "0xa8afbcdfcb534e8c6dec7aa853f448b99c133ad3c7853403de30db7df06ec939",
      digest: "0xd12bc2beb61f072d0cabff6ce5526704c339d31da43840192c0e53d716c411a9",
    },
    {
      name: "JBAC #1 item bid (Ethereum)", chainId: 1,
      args: { kind: "item", collectionContract: JBAC, tokenId: "1", quantity: 1, unitPriceWei: 30_000_000_000_000_000n, feeLines: OS_1PCT },
      orderHash: "0xcf91fcd2a1d401ea359adc66dffdb79e958d1db3ad145648931e3a07518be6c8",
      digest: "0xd371be19b1e672cda58339d0f91abd592775ef20b2c4f38df8e80e01be502db5",
    },
    {
      name: "Bojungles #7 item bid (Base)", chainId: 8453,
      args: { kind: "item", collectionContract: BOJUNGLES, tokenId: "7", quantity: 1, unitPriceWei: 1_000_000_000_000_000n, feeLines: OS_1PCT },
      orderHash: "0x6a4a5d7efae9ee92a5d8edb85135f1d4280df85b65a0b5bddcf679fca761b41b",
      digest: "0x23c0fab1f4eea2b36fc8e2fd0a9a08759cb2209cdd341c5c6619f28d3af142c5",
    },
  ];

  it("the domain is Seaport's own separator on each chain", () => {
    const EIP712Domain = [
      { name: "name", type: "string" }, { name: "version", type: "string" },
      { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
    ];
    for (const chainId of [1, 8453]) {
      expect(hashDomain({ domain: seaport16Domain(chainId), types: { EIP712Domain } })).toBe(SEPARATOR[chainId]);
    }
  });

  for (const f of FIXTURES) {
    it(`${f.name}: order hash and signed digest`, () => {
      const parameters = buildBidParameters({ chainId: f.chainId, offerer: BIDDER, startTime: T0, endTime: T1, salt: SALT, ...f.args });
      const typed = typedDataFor(parameters, 0n, f.chainId);
      expect(hashStruct({ data: typed.message, primaryType: "OrderComponents", types: typed.types })).toBe(f.orderHash);
      expect(hashTypedData(typed)).toBe(f.digest);
    });
  }

  it("the counter is part of what is signed", () => {
    const f = FIXTURES[0];
    const parameters = buildBidParameters({ chainId: f.chainId, offerer: BIDDER, startTime: T0, endTime: T1, salt: SALT, ...f.args });
    expect(hashTypedData(typedDataFor(parameters, 1n, 1))).not.toBe(f.digest);
    expect(typedDataFor(parameters, "7", 1).message.counter).toBe(7n);
  });
});

describe("one WETH approval budget for every live bid", () => {
  const E = 10n ** 18n;
  const CAP = 100n * E;

  it("approves the sum of the live bids plus this one, once", () => {
    const r = wethApprovalTarget({ allowance: E / 10n, liveOfferTotals: [E / 10n, E / 5n], bidTotal: E / 20n, cap: CAP });
    expect(r).toEqual({ approve: 350_000_000_000_000_000n, needed: 350_000_000_000_000_000n, budgeted: true });
  });

  it("approves nothing when the allowance already covers every bid", () => {
    expect(wethApprovalTarget({ allowance: E, liveOfferTotals: [E / 10n], bidTotal: E / 10n, cap: CAP }).approve).toBeNull();
    expect(wethApprovalTarget({ allowance: E / 5n, liveOfferTotals: [E / 10n], bidTotal: E / 10n, cap: CAP }).approve).toBeNull();
  });

  it("with no other bids, approves this bid's total", () => {
    expect(wethApprovalTarget({ allowance: 0n, liveOfferTotals: [], bidTotal: E / 50n, cap: CAP }).approve).toBe(E / 50n);
  });

  it("when the open bids could not be read, raises the allowance by this bid and never lowers it", () => {
    const r = wethApprovalTarget({ allowance: E / 2n, liveOfferTotals: null, bidTotal: E / 10n, cap: CAP });
    expect(r).toEqual({ approve: 600_000_000_000_000_000n, needed: 600_000_000_000_000_000n, budgeted: false });
  });

  it("stops at the 100 WETH cap, and asks for nothing more once it is reached", () => {
    expect(wethApprovalTarget({ allowance: 0n, liveOfferTotals: [150n * E], bidTotal: E, cap: CAP }).approve).toBe(CAP);
    expect(wethApprovalTarget({ allowance: CAP, liveOfferTotals: [150n * E], bidTotal: E, cap: CAP }).approve).toBeNull();
  });
});
