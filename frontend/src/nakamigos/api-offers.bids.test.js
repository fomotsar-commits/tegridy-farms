// Bids work again on Seaport 1.6 (2026-11-16), pinned on what api-offers.js
// actually sends, signs, approves and posts.
//
// Before this, every bid button failed (measured live 2026-11-15): the
// collection/trait build was refused (400, no `protocol_address`), the post went
// to `criteria_offers` (404), and a bid on one NFT was signed for Seaport 1.5 with
// no zone, after the wrap and approval gas was already paid. These tests fail on
// that code and pass on this one:
//   - the build asks for Seaport 1.6 with offer protection; the post goes to the
//     route OpenSea's spec names, with the counter inside `parameters`;
//   - every bid is signed for Seaport 1.6 with OpenSea's SignedZone, PARTIAL_RESTRICTED;
//   - a price is rounded DOWN to the 0.00001 tick, and a price that rounds to
//     nothing is refused before any wallet call;
//   - ONE WETH approval covers every live bid (approve SETS, so approving only the
//     new bid cut the allowance under the older ones);
//   - the venue's line rides on BID_VENUE_FEE_ENABLED (off), at 0.5%;
//   - a SignedZone bid is cancelled without gas, falling back to the on-chain cancel;
//     a listing keeps the on-chain cancel (review 2026-11-16 F1);
//   - a trait bid where OpenSea has trait offers off is refused before any wallet
//     call (review 2026-11-16 F5);
//   - an accept stops with "This bid just changed or ended." when OpenSea will not
//     build the fill, before any approval.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hashStruct } from "viem";
import { ADDR } from "./__fixtures__/jungleBayFamily";
import { acceptFulfillment, SEAPORT_16 } from "./__fixtures__/seaportFulfillment";
import { buildBidParameters, typedDataFor, OPENSEA_SIGNED_ZONE } from "./lib/seaportOffer";

const WALLET = "0x" + "a".repeat(40);
const JBAC = ADDR.junglebay;
const GNSS = ADDR.gnssart;
const GOLD = ADDR.junglebaygoldcards;
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const OPENSEA_FEE = "0x0000a26b00c1F0DF003000390027140000fAa719";
const ETH_SAFE = "0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d";
const SEAPORT_15 = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC";
const E = 10n ** 18n;

const h = vi.hoisted(() => ({
  account: null,
  chainId: 1n,
  bidVenueFee: false,
  sendTransaction: null,
  signTypedData: null,
  contractCalls: [],
  openseaPost: null,
  openseaGet: null,
  wrapEth: null,
  approveWeth: null,
  wethBalance: 0n,
  allowance: 0n,
  order: [],
}));

vi.mock("./constants", async (importOriginal) => ({
  ...(await importOriginal()),
  get BID_VENUE_FEE_ENABLED() { return h.bidVenueFee; },
}));
vi.mock("../lib/wagmi", () => ({ config: { __test: true } }));
vi.mock("wagmi/actions", () => ({ getAccount: () => h.account }));
vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal();
  class MockBrowserProvider {
    async getNetwork() { return { chainId: h.chainId }; }
    async getSigner() {
      return {
        provider: this,
        getAddress: async () => WALLET,
        sendTransaction: (...a) => h.sendTransaction(...a),
        signTypedData: (...a) => { h.order.push("sign"); return h.signTypedData(...a); },
      };
    }
    async getBalance() { return 10n ** 20n; }
  }
  class MockContract {
    constructor(target) {
      this.target = target;
      return new Proxy(this, {
        get(obj, prop) {
          if (prop in obj) return obj[prop];
          if (typeof prop !== "string" || prop === "then") return undefined;
          return async (...args) => {
            h.contractCalls.push({ target: String(target), method: prop, args });
            h.order.push(prop);
            switch (prop) {
              case "ownerOf": return WALLET;
              case "getCounter": return 0n;
              case "isApprovedForAll": return true;
              case "cancel": return { hash: "0xoncancel", wait: async () => ({ status: 1, hash: "0xoncancel" }) };
              default: return undefined;
            }
          };
        },
      });
    }
  }
  return { ...actual, ethers: { ...actual.ethers, BrowserProvider: MockBrowserProvider, Contract: MockContract } };
});
vi.mock("./lib/proxy", () => ({
  alchemyGet: vi.fn(async () => ({})),
  alchemyPost: vi.fn(async () => ({})),
  openseaGet: (...a) => h.openseaGet(...a),
  openseaPost: (...a) => h.openseaPost(...a),
  ApiError: class ApiError extends Error {},
}));
vi.mock("./lib/weth", () => ({
  getWethBalance: vi.fn(async () => h.wethBalance),
  getEthBalance: vi.fn(async () => 10n ** 20n),
  getWethAllowance: vi.fn(async () => h.allowance),
  wrapEth: (...a) => { h.order.push("wrap"); return h.wrapEth(...a); },
  approveWeth: (...a) => { h.order.push("approve"); return h.approveWeth(...a); },
  formatEth: (v) => String(v),
}));
vi.mock("./lib/rpcProvider", () => ({ getReadProvider: async () => ({ __readProvider: true }) }));

// OpenSea's live build answer (2026-11-16): one NFT line, its SignedZone, zero zoneHash.
const liveBuild = (token, quantity = 1, criteria = "0") => ({
  partialParameters: {
    consideration: [{ itemType: 4, token: token.toLowerCase(), identifierOrCriteria: criteria, startAmount: String(quantity), endAmount: String(quantity), recipient: WALLET }],
    zone: OPENSEA_SIGNED_ZONE.toLowerCase(),
    zoneHash: "0x" + "0".repeat(64),
  },
});
/** OpenSea answering a build and a post the way it does live. */
function openseaAnswers(token, { quantity = 1, criteria } = {}) {
  h.openseaPost = vi.fn(async (path) => {
    h.order.push(`post:${path}`);
    if (path === "offers/build") return liveBuild(token, quantity, criteria);
    return { order_hash: "0x" + "be".repeat(32) };
  });
}
const posts = () => h.openseaPost.mock.calls.map(([path]) => path);
const postBody = (path) => h.openseaPost.mock.calls.find(([p]) => p === path)?.[1];

beforeEach(() => {
  vi.resetModules();
  h.chainId = 1n;
  h.bidVenueFee = false;
  h.contractCalls = [];
  h.order = [];
  h.wethBalance = 0n;
  h.allowance = 0n;
  h.sendTransaction = vi.fn(async () => ({ hash: "0xsent", wait: async () => ({ status: 1 }) }));
  h.signTypedData = vi.fn(async () => "0x" + "ab".repeat(65));
  h.openseaGet = vi.fn(async () => ({ offers: [] }));
  h.wrapEth = vi.fn(async () => ({ hash: "0xwrap" }));
  h.approveWeth = vi.fn(async () => ({ hash: "0xapprove" }));
  openseaAnswers(JBAC);
  const provider = { request: vi.fn(async () => null) };
  h.account = { address: WALLET, connector: { getProvider: async () => provider } };
  window.ethereum = provider;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  delete window.ethereum;
  vi.restoreAllMocks();
});

describe("a collection bid", () => {
  it("is built for Seaport 1.6 with offer protection, the two fields OpenSea requires", async () => {
    const offers = await import("./api-offers");
    const res = await offers.createCollectionOffer({ priceEth: "0.03", slug: "junglebay", openseaSlug: "junglebay" });
    expect(res).toEqual({ success: true, orderHash: "0x" + "be".repeat(32) });
    expect(postBody("offers/build")).toEqual({
      offerer: WALLET,
      quantity: 1,
      criteria: { collection: { slug: "junglebay" } },
      protocol_address: SEAPORT_16,
      offer_protection_enabled: true,
    });
  });

  it("is posted to `offers` in OpenSea's post_criteria_offer_v2 shape, the counter inside `parameters`", async () => {
    const offers = await import("./api-offers");
    await offers.createCollectionOffer({ priceEth: "0.03", slug: "junglebay", openseaSlug: "junglebay" });
    expect(posts()).toEqual(["offers/build", "offers"]);
    const body = postBody("offers");
    expect(Object.keys(body).sort()).toEqual(["criteria", "protocol_address", "protocol_data"]);
    expect(body.criteria).toEqual({ collection: { slug: "junglebay" } });
    expect(body.protocol_address).toBe(SEAPORT_16);
    expect(body.protocol_data.signature).toBe("0x" + "ab".repeat(65));
    const p = body.protocol_data.parameters;
    expect(p.counter).toBe("0");
    expect(p.zone).toBe(OPENSEA_SIGNED_ZONE);
    expect(p.orderType).toBe(3);
    expect(p.offer).toEqual([{ itemType: 1, token: WETH, identifierOrCriteria: "0", startAmount: "30000000000000000", endAmount: "30000000000000000" }]);
    expect(p.consideration).toEqual([
      { itemType: 4, token: JBAC.toLowerCase(), identifierOrCriteria: "0", startAmount: "1", endAmount: "1", recipient: WALLET },
      { itemType: 1, token: WETH, identifierOrCriteria: "0", startAmount: "300000000000000", endAmount: "300000000000000", recipient: OPENSEA_FEE },
    ]);
    expect(p.totalOriginalConsiderationItems).toBe(2);
  });

  it("is signed for Seaport 1.6 (domain, zone, order type, counter)", async () => {
    const offers = await import("./api-offers");
    await offers.createCollectionOffer({ priceEth: "0.03", slug: "junglebay", openseaSlug: "junglebay" });
    const [domain, types, message] = h.signTypedData.mock.calls[0];
    expect(domain).toEqual({ name: "Seaport", version: "1.6", chainId: 1, verifyingContract: SEAPORT_16 });
    expect(Object.keys(types).sort()).toEqual(["ConsiderationItem", "OfferItem", "OrderComponents"]);
    expect(message.zone).toBe(OPENSEA_SIGNED_ZONE);
    expect(message.orderType).toBe(3);
    expect(message.counter).toBe(0n);
    expect(h.contractCalls.find((c) => c.method === "getCounter").target).toBe(SEAPORT_16);
  });

  it("a trait bid sends OpenSea's `traits` array and posts the same criteria", async () => {
    openseaAnswers(JBAC, { criteria: "56437522607701336082983860045218093671644625055155094843624326587536835527173" });
    const offers = await import("./api-offers");
    const res = await offers.createTraitOffer({ traitType: "Background", traitValue: "Green", priceEth: "0.04", slug: "junglebay", openseaSlug: "junglebay" });
    expect(res.success).toBe(true);
    const criteria = { collection: { slug: "junglebay" }, traits: [{ type: "Background", value: "Green" }] };
    expect(postBody("offers/build").criteria).toEqual(criteria);
    expect(postBody("offers").criteria).toEqual(criteria);
  });

  // OpenSea has trait offers switched off on GNSS and the Gold Cards (read live
  // 2026-11-16). A trait bid there used to build, wrap and approve, then be refused
  // at the post, the gas spent (review 2026-11-16 F5). It is refused first now.
  it("a trait bid where OpenSea has trait offers off is refused before any wallet call", async () => {
    const getProvider = vi.fn(h.account.connector.getProvider);
    h.account.connector.getProvider = getProvider;
    const offers = await import("./api-offers");
    for (const slug of ["gnssart", "junglebaygoldcards"]) {
      const res = await offers.createTraitOffer({ traitType: "Background", traitValue: "Green", priceEth: "0.04", slug, openseaSlug: slug });
      expect(res.error, slug).toBe("trait-offers-off");
      expect(res.message, slug).toMatch(/^OpenSea does not take trait bids on .+, so nothing was funded or signed\.$/);
    }
    expect(getProvider).not.toHaveBeenCalled();
    expect(h.openseaPost).not.toHaveBeenCalled();
    expect(h.contractCalls).toEqual([]);
    expect(h.wrapEth).not.toHaveBeenCalled();
    expect(h.approveWeth).not.toHaveBeenCalled();
    // A collection bid on the same collections is still made.
    openseaAnswers(GNSS);
    expect((await offers.createCollectionOffer({ priceEth: "0.03", slug: "gnssart", openseaSlug: "gnssart" })).success).toBe(true);
  });

  it("checks the build, reads the counter, then wraps and approves, then signs, then posts", async () => {
    const offers = await import("./api-offers");
    await offers.createCollectionOffer({ priceEth: "0.03", slug: "junglebay", openseaSlug: "junglebay" });
    const steps = h.order.filter((s) => ["post:offers/build", "getCounter", "wrap", "approve", "sign", "post:offers"].includes(s));
    expect(steps).toEqual(["post:offers/build", "getCounter", "wrap", "approve", "sign", "post:offers"]);
  });

  it("a build this venue would not sign costs nothing: no wrap, approve, counter or signature", async () => {
    h.openseaPost = vi.fn(async (path) => (path === "offers/build"
      ? { partialParameters: { ...liveBuild(JBAC).partialParameters, zone: "0x" + "0".repeat(40) } }
      : { order_hash: "0x" }));
    const offers = await import("./api-offers");
    const res = await offers.createCollectionOffer({ priceEth: "0.03", slug: "junglebay", openseaSlug: "junglebay" });
    expect(res).toMatchObject({ error: "build-mismatch", field: "zone" });
    expect(h.wrapEth).not.toHaveBeenCalled();
    expect(h.approveWeth).not.toHaveBeenCalled();
    expect(h.signTypedData).not.toHaveBeenCalled();
    expect(h.contractCalls.map((c) => c.method)).not.toContain("getCounter");
    expect(posts()).toEqual(["offers/build"]);
  });
});

describe("a bid on one NFT", () => {
  it("is Seaport 1.6 with OpenSea's SignedZone, itemType 2, posted to orders/ethereum/seaport/offers", async () => {
    const offers = await import("./api-offers");
    const res = await offers.createItemOffer({ tokenId: "7", priceEth: "0.05", contract: GNSS });
    expect(res.success).toBe(true);
    expect(posts()).toEqual(["orders/ethereum/seaport/offers"]);
    const body = postBody("orders/ethereum/seaport/offers");
    expect(Object.keys(body).sort()).toEqual(["parameters", "protocol_address", "signature"]);
    expect(body.protocol_address).toBe(SEAPORT_16);
    expect(body.parameters.counter).toBe("0");
    expect(body.parameters.zone).toBe(OPENSEA_SIGNED_ZONE);
    expect(body.parameters.orderType).toBe(3);
    expect(body.parameters.consideration).toEqual([
      { itemType: 2, token: GNSS, identifierOrCriteria: "7", startAmount: "1", endAmount: "1", recipient: WALLET },
      { itemType: 1, token: WETH, identifierOrCriteria: "0", startAmount: "500000000000000", endAmount: "500000000000000", recipient: OPENSEA_FEE },
    ]);
    const [domain] = h.signTypedData.mock.calls[0];
    expect(domain.version).toBe("1.6");
    expect(domain.verifyingContract).toBe(SEAPORT_16);
    // Never Seaport 1.5 any more.
    expect(h.contractCalls.some((c) => c.target === SEAPORT_15)).toBe(false);
  });
});

describe("the price", () => {
  it("is rounded DOWN to the 0.00001 WETH tick, never up", async () => {
    const offers = await import("./api-offers");
    await offers.createItemOffer({ tokenId: "7", priceEth: "0.012345678", contract: GNSS });
    expect(postBody("orders/ethereum/seaport/offers").parameters.offer[0].startAmount).toBe("12340000000000000");
  });

  it("a float price is read as its decimal, then rounded down", async () => {
    const offers = await import("./api-offers");
    await offers.createItemOffer({ tokenId: "7", priceEth: 0.1 + 0.2, contract: GNSS });
    expect(postBody("orders/ethereum/seaport/offers").parameters.offer[0].startAmount).toBe("300000000000000000");
  });

  it("a price that rounds to nothing, or no price, is refused before any wallet call", async () => {
    const offers = await import("./api-offers");
    for (const priceEth of ["0.000009", "0", "-1", "abc", ""]) {
      const res = await offers.createItemOffer({ tokenId: "7", priceEth, contract: GNSS });
      expect(res.success, String(priceEth)).toBeUndefined();
      expect(["price-too-small", "bad-price"]).toContain(res.error);
    }
    expect(h.contractCalls).toEqual([]);
    expect(h.openseaPost).not.toHaveBeenCalled();
  });
});

describe("one WETH approval for every live bid", () => {
  // A live bid row the way `offers/collection/{slug}/all?maker=` returns it.
  const liveRow = (totalWei, token = WETH) => ({
    order_hash: "0x" + "cc".repeat(32),
    status: "ACTIVE",
    protocol_data: { parameters: {
      offerer: WALLET,
      offer: [{ itemType: 1, token, identifierOrCriteria: "0", startAmount: String(totalWei), endAmount: String(totalWei) }],
      consideration: [{ itemType: 4, token: JBAC, identifierOrCriteria: "0", startAmount: "1", endAmount: "1", recipient: WALLET }],
      endTime: String(Math.floor(Date.now() / 1000) + 3600),
    } },
  });

  it("approves the wallet's live bids on every venue collection plus this one, once", async () => {
    h.openseaGet = vi.fn(async (path) => {
      if (path === "offers/collection/junglebay/all") return { offers: [liveRow(E / 10n)] };
      if (path === "offers/collection/gnssart/all") return { offers: [liveRow(E / 5n), liveRow(E, "0x" + "9".repeat(40))] };
      return { offers: [] };
    });
    const offers = await import("./api-offers");
    await offers.createCollectionOffer({ priceEth: "0.05", slug: "junglebay", openseaSlug: "junglebay" });
    // 0.1 + 0.2 live (the non-WETH row is not this allowance's) + 0.05 this bid.
    expect(h.approveWeth).toHaveBeenCalledTimes(1);
    expect(h.approveWeth.mock.calls[0]).toEqual([350_000_000_000_000_000n, 1]);
    const read = h.openseaGet.mock.calls.map(([p, q]) => [p, q.maker]);
    expect(read).toEqual(expect.arrayContaining([
      ["offers/collection/junglebay/all", WALLET],
      ["offers/collection/gnssart/all", WALLET],
      ["offers/collection/nakamigos/all", WALLET],
      ["offers/collection/junglebaygoldcards/all", WALLET],
    ]));
  });

  it("approves nothing when the allowance already covers every live bid and this one", async () => {
    h.allowance = E;
    h.openseaGet = vi.fn(async (path) => (path === "offers/collection/junglebay/all" ? { offers: [liveRow(E / 2n)] } : { offers: [] }));
    const offers = await import("./api-offers");
    expect((await offers.createCollectionOffer({ priceEth: "0.05", slug: "junglebay", openseaSlug: "junglebay" })).success).toBe(true);
    expect(h.approveWeth).not.toHaveBeenCalled();
  });

  it("when the open bids cannot be read, raises the allowance by this bid and never lowers it", async () => {
    h.allowance = E / 2n;
    h.openseaGet = vi.fn(async () => { throw new Error("rate limited"); });
    const offers = await import("./api-offers");
    await offers.createItemOffer({ tokenId: "7", priceEth: "0.05", contract: GNSS });
    expect(h.approveWeth.mock.calls[0]).toEqual([550_000_000_000_000_000n, 1]);
  });

  it("only wraps what the bid is missing", async () => {
    h.wethBalance = E / 100n;
    const offers = await import("./api-offers");
    await offers.createItemOffer({ tokenId: "7", priceEth: "0.05", contract: GNSS });
    expect(h.wrapEth.mock.calls[0]).toEqual([40_000_000_000_000_000n, 1]);
  });

  it("a bid above 100 WETH in total is refused before any wallet call", async () => {
    const offers = await import("./api-offers");
    const res = await offers.createItemOffer({ tokenId: "7", priceEth: "100.00001", contract: GNSS });
    expect(res.error).toBe("too-large");
    expect(h.contractCalls).toEqual([]);
  });
});

describe("the venue's line", () => {
  it("is not on a bid while BID_VENUE_FEE_ENABLED is off", async () => {
    const offers = await import("./api-offers");
    await offers.createCollectionOffer({ priceEth: "0.03", slug: "junglebay", openseaSlug: "junglebay" });
    expect(postBody("offers").protocol_data.parameters.consideration.map((c) => c.recipient)).toEqual([WALLET, OPENSEA_FEE]);
  });

  it("is 0.5% of the offer to the fee Safe on every kind of bid once switched on", async () => {
    h.bidVenueFee = true;
    const offers = await import("./api-offers");
    await offers.createCollectionOffer({ priceEth: "0.03", slug: "junglebay", openseaSlug: "junglebay" });
    const line = postBody("offers").protocol_data.parameters.consideration[2];
    expect(line).toEqual({ itemType: 1, token: WETH, identifierOrCriteria: "0", startAmount: "150000000000000", endAmount: "150000000000000", recipient: ETH_SAFE });
    h.openseaPost.mockClear();
    await offers.createItemOffer({ tokenId: "7", priceEth: "0.03", contract: GNSS });
    expect(postBody("orders/ethereum/seaport/offers").parameters.consideration[2].recipient).toBe(ETH_SAFE);
  });
});

describe("cancelling a bid", () => {
  // A real Seaport 1.6 SignedZone bid by WALLET, and the order hash Seaport gives
  // it at counter 0 (viem hashStruct; lib/seaportOffer.test.js holds that equal to
  // Seaport 1.6's own getOrderHash).
  const params = buildBidParameters({
    chainId: 1, offerer: WALLET, kind: "collection", collectionContract: GOLD, quantity: 1,
    unitPriceWei: 20_000_000_000_000_000n, feeLines: [{ recipient: OPENSEA_FEE, bps: 100 }],
    build: liveBuild(GOLD).partialParameters, startTime: 1763251200, endTime: 1763253000, salt: 7n,
  });
  const typed = typedDataFor(params, 0n, 1);
  const HASH = hashStruct({ data: typed.message, primaryType: "OrderComponents", types: typed.types });
  const bid = (over = {}) => ({ orderHash: HASH, protocolAddress: SEAPORT_16, rawOrder: { order_hash: HASH, protocol_address: SEAPORT_16, protocol_data: { parameters: params } }, ...over });
  const CANCEL_PATH = `orders/chain/ethereum/protocol/0x0000000000000068f116a894984e2db1123eb395/${HASH}/cancel`;

  it("signs OpenSea's OrderHash message and posts it: no gas, and the 5-minute caveat said", async () => {
    h.openseaPost = vi.fn(async () => ({ last_signature_issued_valid_until: "2026-11-16T00:05:00Z" }));
    const offers = await import("./api-offers");
    const res = await offers.cancelOrder(bid());
    expect(res).toEqual({
      success: true,
      gasless: true,
      message: "Cancelled. OpenSea can still complete a sale it approved in the last 5 minutes.",
      lastSignatureValidUntil: "2026-11-16T00:05:00Z",
    });
    const [domain, types, message] = h.signTypedData.mock.calls[0];
    expect(domain).toEqual({ name: "Seaport", version: "1.6", chainId: 1, verifyingContract: SEAPORT_16 });
    expect(types).toEqual({ OrderHash: [{ name: "orderHash", type: "bytes32" }] });
    expect(message).toEqual({ orderHash: HASH });
    expect(h.openseaPost.mock.calls).toEqual([[CANCEL_PATH, { offererSignature: "0x" + "ab".repeat(65) }]]);
    expect(h.contractCalls.map((c) => c.method)).not.toContain("cancel");
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });

  it("falls back to the on-chain cancel when OpenSea refuses (a very new order)", async () => {
    h.openseaPost = vi.fn(async () => { throw Object.assign(new Error("OpenSea proxy 400"), { status: 400 }); });
    const offers = await import("./api-offers");
    const res = await offers.cancelOrder(bid());
    expect(res.success).toBe(true);
    expect(res.gasless).toBeUndefined();
    expect(h.contractCalls.filter((c) => c.method === "cancel").map((c) => c.target)).toEqual([SEAPORT_16]);
  });

  it("falls back to the on-chain cancel when OpenSea's answer confirms nothing", async () => {
    h.openseaPost = vi.fn(async () => ({}));
    const offers = await import("./api-offers");
    expect((await offers.cancelOrder(bid())).gasless).toBeUndefined();
    expect(h.contractCalls.map((c) => c.method)).toContain("cancel");
  });

  it("never signs a cancel for a hash that is not this order's: the on-chain cancel runs instead", async () => {
    const offers = await import("./api-offers");
    const res = await offers.cancelOrder(bid({ orderHash: "0x" + "11".repeat(32), rawOrder: { order_hash: "0x" + "11".repeat(32), protocol_address: SEAPORT_16, protocol_data: { parameters: params } } }));
    expect(res.success).toBe(true);
    expect(h.signTypedData).not.toHaveBeenCalled();
    expect(h.openseaPost).not.toHaveBeenCalled();
    expect(h.contractCalls.map((c) => c.method)).toContain("cancel");
  });

  it("a declined cancel signature is the answer: nothing on chain", async () => {
    h.signTypedData = vi.fn(async () => { throw Object.assign(new Error("user rejected"), { code: 4001 }); });
    const offers = await import("./api-offers");
    expect((await offers.cancelOrder(bid())).error).toBe("rejected");
    expect(h.contractCalls.map((c) => c.method)).not.toContain("cancel");
    expect(h.openseaPost).not.toHaveBeenCalled();
  });

  // A LISTING on the same Seaport and zone (164 of 254 live GNSS listings were,
  // 2026-11-15). After a free cancel, anyone OpenSea approved a fill for in the
  // last 5 minutes can still buy it at the old price, while My Collection said
  // "Listing cancelled". Only a bid takes the free cancel.
  it("a listing on Seaport 1.6's SignedZone keeps the on-chain cancel", async () => {
    const listing = {
      offerer: WALLET,
      zone: OPENSEA_SIGNED_ZONE,
      offer: [{ itemType: 2, token: JBAC, identifierOrCriteria: "7", startAmount: "1", endAmount: "1" }],
      consideration: [
        { itemType: 0, token: "0x" + "0".repeat(40), identifierOrCriteria: "0", startAmount: "29700000000000000", endAmount: "29700000000000000", recipient: WALLET },
        { itemType: 0, token: "0x" + "0".repeat(40), identifierOrCriteria: "0", startAmount: "300000000000000", endAmount: "300000000000000", recipient: OPENSEA_FEE },
      ],
      orderType: 2,
      startTime: "1763251200",
      endTime: "1763337600",
      zoneHash: "0x" + "0".repeat(64),
      salt: "7",
      conduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
      totalOriginalConsiderationItems: 2,
    };
    const t = typedDataFor(listing, 0n, 1);
    const LISTING_HASH = hashStruct({ data: t.message, primaryType: "OrderComponents", types: t.types });
    h.openseaPost = vi.fn(async () => ({ last_signature_issued_valid_until: "2026-11-16T00:05:00Z" }));
    const offers = await import("./api-offers");
    const res = await offers.cancelOrder({ orderHash: LISTING_HASH, protocolAddress: SEAPORT_16, rawOrder: { order_hash: LISTING_HASH, protocol_address: SEAPORT_16, protocol_data: { parameters: listing } } });
    expect(res.success).toBe(true);
    expect(res.gasless).toBeUndefined();
    expect(h.signTypedData).not.toHaveBeenCalled();
    expect(h.openseaPost).not.toHaveBeenCalled();
    expect(h.contractCalls.filter((c) => c.method === "cancel").map((c) => c.target)).toEqual([SEAPORT_16]);
  });

  it("a Seaport 1.5 or zone-less order keeps the on-chain cancel", async () => {
    const offers = await import("./api-offers");
    const zoneless = { ...params, zone: "0x" + "0".repeat(40) };
    await offers.cancelOrder({ orderHash: HASH, rawOrder: { order_hash: HASH, protocol_address: SEAPORT_16, protocol_data: { parameters: zoneless } } });
    await offers.cancelOrder({ orderHash: HASH, rawOrder: { order_hash: HASH, protocol_address: SEAPORT_15, protocol_data: { parameters: params } } });
    expect(h.signTypedData).not.toHaveBeenCalled();
    expect(h.openseaPost).not.toHaveBeenCalled();
    expect(h.contractCalls.filter((c) => c.method === "cancel").map((c) => c.target)).toEqual([SEAPORT_16, SEAPORT_15]);
  });
});

describe("accepting a bid that just changed or ended", () => {
  const offer = { orderHash: "0xoffer", protocolAddress: SEAPORT_16, tokenContract: GNSS, tokenId: "7" };

  it("stops with the plain answer when OpenSea will not build the fill, before any approval", async () => {
    for (const status of [400, 404, 410, 422]) {
      h.openseaPost = vi.fn(async () => { throw Object.assign(new Error(`OpenSea proxy ${status}: {"error":"upstream-rejected","status":${status}}`), { status }); });
      const offers = await import("./api-offers");
      expect(await offers.acceptOffer(offer), String(status)).toEqual({ error: "offer-gone", message: "This bid just changed or ended." });
    }
    expect(h.contractCalls.map((c) => c.method)).not.toContain("setApprovalForAll");
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });

  it("an outage or the proxy's own refusal is not called 'ended'", async () => {
    for (const err of [
      Object.assign(new Error("OpenSea proxy 502: {}"), { status: 502 }),
      Object.assign(new Error('OpenSea proxy 400: {"error":"Invalid contract address format"}'), { status: 400 }),
      Object.assign(new Error('OpenSea proxy 403: {"error":"Contract not supported"}'), { status: 403 }),
    ]) {
      h.openseaPost = vi.fn(async () => { throw err; });
      const offers = await import("./api-offers");
      expect((await offers.acceptOffer(offer)).message).toBe("Could not get fulfillment data");
    }
  });

  it("control: a fill OpenSea builds for this token is still accepted", async () => {
    h.openseaPost = vi.fn(async () => acceptFulfillment(GNSS));
    const offers = await import("./api-offers");
    expect((await offers.acceptOffer(offer)).success).toBe(true);
  });
});
