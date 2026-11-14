// No money action starts for a collection that does not trade here.
//
// Five of the six Jungle Bay family collections are view-only on this venue:
// two ERC-1155s on Ethereum, two ERC-721s on Base and a Solana pNFT set. The
// view layer never mounts a money surface for them (externalCollectionView
// .test.jsx), and this file is the SECOND layer: every function that can move
// value, sign an order or grant an approval refuses a non-venue contract as
// its first act, before it resolves a wallet, fetches, approves or wraps.
//
// Refused means: the sink answers `not-venue-tradeable`, and NOTHING below
// happened (a wallet provider request, a transaction, a typed-data signature,
// a setApprovalForAll, a WETH wrap or approve, an OpenSea POST, a fetch).
// Each sink also has a positive control: a venue contract passes the check
// and reaches its next step (with no wallet connected, that step is the
// no-wallet answer).
//
// One exception: Bojungles and Seeds (venueBuy, Base ERC-721s) trade here on
// Base and only on Base. Their OpenSea listings are bought one at a time
// (fulfillSeaportOrder), they are listed on the venue's order book and bought
// from it (lib/orderbook.js), bid on item by item and those bids accepted
// (api-offers.js), each with Base's Seaport 1.6, Base WETH and the Base
// treasury Safe. The cart, bundles, P2P trades and collection or trait bids
// still refuse them.
//
// A cancel is sent on the order's own chain: a Base order on Base, refused
// while the wallet is elsewhere. Every other cancel stays open on Ethereum,
// Ethereum non-venue contracts included, so a signed Ethereum order is never
// stranded if a contract leaves the venue list. A P2P trade cancel stays
// Ethereum only and refuses a Base NFT.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { ADDR } from "./__fixtures__/jungleBayFamily";
import {
  buyFulfillment, acceptFulfillment, fulfillOrderFulfillment, opaqueFulfillment, SEAPORT_16,
} from "./__fixtures__/seaportFulfillment";

const NON_VENUE = {
  "Bojungles (Base ERC-721)": ADDR.bojungles,
  "Seeds (Base ERC-721)": ADDR.memeticseeds,
  "the memes (Ethereum ERC-1155)": ADDR.junglebaymemes,
  "Rare Towelie Cards (Ethereum ERC-1155)": ADDR.raretowelie,
};
// The ones the order book and item bids still refuse: no chain here settles them.
const NOT_ON_BOOK = {
  "the memes (Ethereum ERC-1155)": ADDR.junglebaymemes,
  "Rare Towelie Cards (Ethereum ERC-1155)": ADDR.raretowelie,
};
const BASE_SAFE = "0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0";
const ETH_SAFE = "0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d";
const BASE_WETH = "0x4200000000000000000000000000000000000006";
const SEAPORT_15 = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC";
const VENUE = ADDR.gnssart;
const GOLD = ADDR.junglebaygoldcards;
const WALLET = "0x" + "a".repeat(40);

const h = vi.hoisted(() => ({
  chainId: 1n,
  account: null,
  connectorGetProvider: null,
  providerRequest: null,
  browserProviders: 0,
  sendTransaction: null,
  signTypedData: null,
  contractCalls: [],
  contractImpl: null,
  openseaPost: null,
  openseaGet: null,
  wrapEth: null,
  approveWeth: null,
}));

vi.mock("./constants", async (importOriginal) => ({
  ...(await importOriginal()),
  // The bundle path is behind a feature flag that is off in production. It is
  // switched on here so the venue check BEHIND the flag is exercised too.
  BUNDLE_LISTING_ENABLED: true,
}));

vi.mock("../lib/wagmi", () => ({ config: { __test: true } }));
vi.mock("wagmi/actions", () => ({ getAccount: () => h.account }));

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal();
  class MockBrowserProvider {
    constructor() { h.browserProviders += 1; }
    async getNetwork() { return { chainId: h.chainId }; }
    async getSigner() {
      return {
        provider: this,
        getAddress: async () => WALLET,
        sendTransaction: (...a) => h.sendTransaction(...a),
        signTypedData: (...a) => h.signTypedData(...a),
        signMessage: async () => "0xauth",
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
          return (...args) => {
            h.contractCalls.push({ target: String(target), method: prop, args });
            return h.contractImpl(prop, String(target), args);
          };
        },
      });
    }
  }
  return {
    ...actual,
    ethers: { ...actual.ethers, BrowserProvider: MockBrowserProvider, Contract: MockContract },
  };
});

vi.mock("./lib/proxy", () => ({
  alchemyGet: vi.fn(async () => ({})),
  alchemyPost: vi.fn(async () => ({})),
  openseaGet: (...a) => h.openseaGet(...a),
  openseaPost: (...a) => h.openseaPost(...a),
  ApiError: class ApiError extends Error {},
}));

vi.mock("./lib/weth", () => ({
  getWethBalance: vi.fn(async () => 0n),
  getEthBalance: vi.fn(async () => 10n ** 20n),
  getWethAllowance: vi.fn(async () => 0n),
  wrapEth: (...a) => h.wrapEth(...a),
  approveWeth: (...a) => h.approveWeth(...a),
  formatEth: (v) => String(v),
}));

vi.mock("./lib/rpcProvider", () => ({ getReadProvider: async () => ({ __readProvider: true }) }));

let fetchSpy;

function connectWallet() {
  const provider = { request: (...a) => h.providerRequest(...a) };
  h.account = { address: WALLET, connector: { getProvider: (...a) => h.connectorGetProvider(provider, ...a) } };
  window.ethereum = provider;
}

function disconnectWallet() {
  h.account = null;
  delete window.ethereum;
}

beforeEach(() => {
  vi.resetModules();
  h.chainId = 1n;
  h.browserProviders = 0;
  h.contractCalls = [];
  h.providerRequest = vi.fn(async () => null);
  h.connectorGetProvider = vi.fn(async (provider) => provider);
  h.sendTransaction = vi.fn(async () => ({ hash: "0xsent", wait: async () => ({ status: 1 }) }));
  h.signTypedData = vi.fn(async () => "0xsig");
  h.openseaPost = vi.fn(async () => buyFulfillment(VENUE));
  h.openseaGet = vi.fn(async () => ({}));
  h.wrapEth = vi.fn(async () => ({ hash: "0xwrap" }));
  h.approveWeth = vi.fn(async () => ({ hash: "0xapprove" }));
  h.contractImpl = (method) => {
    switch (method) {
      case "isApprovedForAll": return Promise.resolve(false);
      case "setApprovalForAll": return Promise.resolve({ hash: "0xsetapproval", wait: async () => ({ status: 1 }) });
      case "ownerOf": return Promise.resolve(WALLET);
      case "getCounter": return Promise.resolve(0n);
      case "cancel": return Promise.resolve({ hash: "0xcancel", wait: async () => ({ status: 1 }) });
      case "getOrderStatus": return Promise.resolve([true, false, 0n, 1n]);
      default: return Promise.resolve(undefined);
    }
  };
  fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "{}" }));
  vi.stubGlobal("fetch", fetchSpy);
  connectWallet();
});

afterEach(() => {
  vi.unstubAllGlobals();
  disconnectWallet();
});

/** Nothing that costs, signs, approves or asks happened. */
function expectNothingHappened() {
  expect(h.connectorGetProvider, "a wallet provider was resolved").not.toHaveBeenCalled();
  expect(h.providerRequest, "the wallet was asked for something").not.toHaveBeenCalled();
  expect(h.browserProviders, "a BrowserProvider was built").toBe(0);
  expect(h.sendTransaction, "a transaction was sent").not.toHaveBeenCalled();
  expect(h.signTypedData, "an order was signed").not.toHaveBeenCalled();
  expect(h.contractCalls.map((c) => c.method), "an NFT contract was touched").toEqual([]);
  expect(h.wrapEth, "ETH was wrapped").not.toHaveBeenCalled();
  expect(h.approveWeth, "WETH was approved").not.toHaveBeenCalled();
  expect(h.openseaPost, "OpenSea was asked to build or take an order").not.toHaveBeenCalled();
  expect(fetchSpy, "a request left the page").not.toHaveBeenCalled();
}

/** A sink that returns `{ error, message }` refused. */
function expectRefused(res) {
  expect(res?.error).toBe("not-venue-tradeable");
  expect(typeof res?.message).toBe("string");
  expect(res?.success).toBeUndefined();
}

// ═══ api.js: buying an OpenSea (Seaport) listing ═══
// The view-only collections that cannot be bought here at all.
const NOT_BUYABLE = {
  "the memes (Ethereum ERC-1155)": ADDR.junglebaymemes,
  "Rare Towelie Cards (Ethereum ERC-1155)": ADDR.raretowelie,
};

describe("api.js buys", () => {
  for (const [label, contract] of Object.entries(NOT_BUYABLE)) {
    it(`fulfillSeaportOrder refuses a listing of ${label} (token read from the listing)`, async () => {
      const api = await import("./api");
      const res = await api.fulfillSeaportOrder({ tokenId: "7", priceWei: "100000000000000000", orderHash: "0xabc", protocolAddress: SEAPORT_16, contract }, { buyerAddress: WALLET });
      expectRefused(res);
      expectNothingHappened();
    });
  }

  it("reads the token from the signed order when the listing carries one", async () => {
    const api = await import("./api");
    const res = await api.fulfillSeaportOrder({
      tokenId: "7", priceWei: "100000000000000000", orderHash: "0xabc",
      protocolAddress: SEAPORT_16,
      orderData: { parameters: { offer: [{ itemType: 3, token: ADDR.junglebaymemes, identifierOrCriteria: "1" }] } },
    }, { buyerAddress: WALLET });
    expectRefused(res);
    expectNothingHappened();
  });

  it("refuses a listing whose signed order mixes a Base NFT with an Ethereum one, before any wallet call", async () => {
    const api = await import("./api");
    const res = await api.fulfillSeaportOrder({
      orderHash: "0xabc",
      protocolAddress: SEAPORT_16,
      orderData: { parameters: { offer: [
        { itemType: 2, token: ADDR.bojungles, identifierOrCriteria: "1" },
        { itemType: 2, token: VENUE, identifierOrCriteria: "1" },
      ] } },
    }, { buyerAddress: WALLET });
    expectRefused(res);
    expectNothingHappened();
  });

  describe("Bojungles and Seeds are bought on Base, and only on Base", () => {
    const BASE_CHAIN = 8453n;
    for (const [label, contract] of [["Bojungles", ADDR.bojungles], ["Seeds", ADDR.memeticseeds]]) {
      it(`a ${label} listing with the wallet on Ethereum asks for Base, and nothing is built or sent`, async () => {
        const api = await import("./api");
        const res = await api.fulfillSeaportOrder({ orderHash: "0xabc", protocolAddress: SEAPORT_16, contract }, { buyerAddress: WALLET });
        expect(res.error).toBe("wrong-chain");
        expect(res.chainId).toBe(8453);
        expect(res.message).toMatch(/switch to Base to buy/);
        expect(h.openseaPost).not.toHaveBeenCalled();
        expect(h.sendTransaction).not.toHaveBeenCalled();
      });

      it(`a ${label} listing with the wallet on Base asks OpenSea for a Base fill and buys it`, async () => {
        h.chainId = BASE_CHAIN;
        h.openseaPost = vi.fn(async () => buyFulfillment(contract));
        const api = await import("./api");
        // Shaped like a real listing (token id and the price shown), so it
        // also passes the trade-on-screen check open in #1023.
        const res = await api.fulfillSeaportOrder({ tokenId: "7", price: 0.1, priceWei: "100000000000000000", orderHash: "0xabc", protocolAddress: SEAPORT_16, contract }, { buyerAddress: WALLET });
        expect(res.success).toBe(true);
        expect(h.openseaPost).toHaveBeenCalledTimes(1);
        expect(h.openseaPost.mock.calls[0][0]).toBe("listings/fulfillment_data");
        expect(h.openseaPost.mock.calls[0][1].listing.chain).toBe("base");
        expect(h.sendTransaction).toHaveBeenCalledTimes(1);
        expect(h.sendTransaction.mock.calls[0][0].to).toBe(SEAPORT_16);
      });
    }

    it("refuses a Bojungles fill whose calldata moves an Ethereum venue NFT, and sends nothing", async () => {
      h.chainId = BASE_CHAIN;
      h.openseaPost = vi.fn(async () => buyFulfillment(VENUE));
      const api = await import("./api");
      const res = await api.fulfillSeaportOrder({ orderHash: "0xabc", protocolAddress: SEAPORT_16, contract: ADDR.bojungles }, { buyerAddress: WALLET });
      expect(res.error).toBe("nft-mismatch");
      expect(h.sendTransaction).not.toHaveBeenCalled();
    });

    it("refuses a Bojungles fill whose calldata moves a Seed instead, and sends nothing", async () => {
      h.chainId = BASE_CHAIN;
      h.openseaPost = vi.fn(async () => buyFulfillment(ADDR.memeticseeds));
      const api = await import("./api");
      const res = await api.fulfillSeaportOrder({ orderHash: "0xabc", protocolAddress: SEAPORT_16, contract: ADDR.bojungles }, { buyerAddress: WALLET });
      expect(res.error).toBe("nft-mismatch");
      expect(h.sendTransaction).not.toHaveBeenCalled();
    });

    it("refuses a Bojungles fill whose calldata moves the memes, and sends nothing", async () => {
      h.chainId = BASE_CHAIN;
      h.openseaPost = vi.fn(async () => fulfillOrderFulfillment(ADDR.junglebaymemes));
      const api = await import("./api");
      const res = await api.fulfillSeaportOrder({ orderHash: "0xabc", protocolAddress: SEAPORT_16, contract: ADDR.bojungles }, { buyerAddress: WALLET });
      expectRefused(res);
      expect(h.sendTransaction).not.toHaveBeenCalled();
    });

    it("an Ethereum venue listing with the wallet on Base still asks for Ethereum Mainnet", async () => {
      h.chainId = BASE_CHAIN;
      const api = await import("./api");
      const res = await api.fulfillSeaportOrder({ orderHash: "0xabc", protocolAddress: SEAPORT_16, contract: VENUE }, { buyerAddress: WALLET });
      expect(res.error).toBe("wrong-chain");
      expect(res.chainId).toBe(1);
      expect(res.message).toMatch(/switch to Ethereum Mainnet to buy/);
      expect(h.sendTransaction).not.toHaveBeenCalled();
    });

    it("an Ethereum venue fill whose calldata moves a Bojungle is refused", async () => {
      h.openseaPost = vi.fn(async () => buyFulfillment(ADDR.bojungles));
      const api = await import("./api");
      const res = await api.fulfillSeaportOrder({ orderHash: "0xabc", protocolAddress: SEAPORT_16, contract: VENUE }, { buyerAddress: WALLET });
      expectRefused(res);
      expect(h.sendTransaction).not.toHaveBeenCalled();
    });

    it("the cart still refuses a Bojungle outright, before any wallet call", async () => {
      h.chainId = BASE_CHAIN;
      const api = await import("./api");
      const res = await api.fulfillSeaportOrdersBatch([
        { orderHash: "0x1", protocolAddress: SEAPORT_16, contract: ADDR.bojungles },
      ], { buyerAddress: WALLET });
      expectRefused(res);
      expectNothingHappened();
    });
  });

  it("refuses a listing that names no token at all, rather than assuming Nakamigos", async () => {
    const api = await import("./api");
    const res = await api.fulfillSeaportOrder({ tokenId: "7", priceWei: "100000000000000000", orderHash: "0xabc", protocolAddress: SEAPORT_16 }, { buyerAddress: WALLET });
    expectRefused(res);
    expectNothingHappened();
  });

  it("fulfillSeaportOrdersBatch refuses the whole cart when one item is not venue-tradeable", async () => {
    const api = await import("./api");
    const res = await api.fulfillSeaportOrdersBatch([
      { orderHash: "0x1", protocolAddress: SEAPORT_16, contract: VENUE },
      { orderHash: "0x2", protocolAddress: SEAPORT_16, contract: ADDR.memeticseeds },
    ], { buyerAddress: WALLET });
    expectRefused(res);
    expectNothingHappened();
  });

  describe("the calldata is checked, not the listing's word for it", () => {
    it("refuses when OpenSea's calldata moves a foreign NFT, even though the listing named a venue token", async () => {
      h.openseaPost = vi.fn(async () => buyFulfillment(ADDR.bojungles));
      const api = await import("./api");
      const res = await api.fulfillSeaportOrder({ tokenId: "7", priceWei: "100000000000000000", orderHash: "0xabc", protocolAddress: SEAPORT_16, contract: VENUE }, { buyerAddress: WALLET });
      expectRefused(res);
      expect(h.sendTransaction).not.toHaveBeenCalled();
    });

    it("trusts the encoded calldata over the advisory orders array", async () => {
      // `orders` claims a venue token; the calldata that would be SIGNED moves Seeds.
      h.openseaPost = vi.fn(async () => buyFulfillment(ADDR.memeticseeds, { ordersToken: VENUE }));
      const api = await import("./api");
      const res = await api.fulfillSeaportOrder({ tokenId: "7", priceWei: "100000000000000000", orderHash: "0xabc", protocolAddress: SEAPORT_16, contract: VENUE }, { buyerAddress: WALLET });
      expectRefused(res);
      expect(h.sendTransaction).not.toHaveBeenCalled();
    });

    it("reads the offer items of a full fulfillOrder, not only the basic-order fields", async () => {
      h.openseaPost = vi.fn(async () => fulfillOrderFulfillment(ADDR.raretowelie));
      const api = await import("./api");
      const res = await api.fulfillSeaportOrder({ tokenId: "7", priceWei: "100000000000000000", orderHash: "0xabc", protocolAddress: SEAPORT_16, contract: VENUE }, { buyerAddress: WALLET });
      expectRefused(res);
      expect(h.sendTransaction).not.toHaveBeenCalled();
    });

    it("names calldata with no decodable NFT as its own failure, and sends nothing", async () => {
      h.openseaPost = vi.fn(async () => opaqueFulfillment());
      const api = await import("./api");
      const res = await api.fulfillSeaportOrder({ tokenId: "7", priceWei: "100000000000000000", orderHash: "0xabc", protocolAddress: SEAPORT_16, contract: VENUE }, { buyerAddress: WALLET });
      expect(res.error).toBe("no-nft-token");
      expect(h.sendTransaction).not.toHaveBeenCalled();
    });

    it("positive control: a venue listing whose calldata moves that venue token is bought", async () => {
      h.openseaPost = vi.fn(async () => buyFulfillment(VENUE));
      const api = await import("./api");
      const res = await api.fulfillSeaportOrder({ tokenId: "7", priceWei: "100000000000000000", orderHash: "0xabc", protocolAddress: SEAPORT_16, contract: VENUE }, { buyerAddress: WALLET });
      expect(res.success).toBe(true);
      expect(h.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it("positive control: Gold Cards buys the same way", async () => {
      h.openseaPost = vi.fn(async () => fulfillOrderFulfillment(GOLD));
      const api = await import("./api");
      const res = await api.fulfillSeaportOrder({ tokenId: "7", priceWei: "100000000000000000", orderHash: "0xabc", protocolAddress: SEAPORT_16, contract: GOLD }, { buyerAddress: WALLET });
      expect(res.success).toBe(true);
    });
  });

  it("positive control: a venue listing with no wallet reaches the no-wallet answer", async () => {
    disconnectWallet();
    const api = await import("./api");
    const res = await api.fulfillSeaportOrder({ tokenId: "7", priceWei: "100000000000000000", orderHash: "0xabc", protocolAddress: SEAPORT_16, contract: VENUE });
    expect(res.error).toBe("no-metamask");
  });
});

// ═══ lib/orderbook.js: the venue's own order book ═══
describe("lib/orderbook.js", () => {
  const nativeOrder = (token) => ({
    contract_address: token.toLowerCase(),
    protocol_address: SEAPORT_16,
    signature: "0xsig",
    parameters: {
      offerer: "0x" + "c".repeat(40),
      offer: [{ itemType: 2, token, identifierOrCriteria: "1", startAmount: "1", endAmount: "1" }],
      consideration: [{ itemType: 0, token: "0x0000000000000000000000000000000000000000", identifierOrCriteria: "0", startAmount: "1000", endAmount: "1000", recipient: "0x" + "c".repeat(40) }],
      endTime: String(Math.floor(Date.now() / 1000) + 3600),
    },
  });

  for (const [label, contract] of Object.entries(NOT_ON_BOOK)) {
    it(`fulfillNativeOrder refuses ${label}`, async () => {
      const ob = await import("./lib/orderbook");
      expectRefused(await ob.fulfillNativeOrder(nativeOrder(contract)));
      expectNothingHappened();
    });

    it(`createNativeListing refuses ${label} before any setApprovalForAll`, async () => {
      const ob = await import("./lib/orderbook");
      expectRefused(await ob.createNativeListing({ contract, tokenId: "1", priceEth: 0.1 }));
      expectNothingHappened();
    });
  }

  it("createNativeBundleListing refuses a bundle of a non-venue collection", async () => {
    const ob = await import("./lib/orderbook");
    const res = await ob.createNativeBundleListing({
      items: [{ contract: ADDR.bojungles, tokenId: "1" }, { contract: ADDR.bojungles, tokenId: "2" }],
      priceEth: 0.2,
    });
    expectRefused(res);
    expectNothingHappened();
  });

  it("positive controls: venue orders reach the no-wallet answer", async () => {
    disconnectWallet();
    const ob = await import("./lib/orderbook");
    expect((await ob.fulfillNativeOrder(nativeOrder(VENUE))).error).toBe("no-wallet");
    expect((await ob.createNativeListing({ contract: GOLD, tokenId: "1", priceEth: 0.1 })).error).toBe("no-wallet");
    expect((await ob.createNativeBundleListing({
      items: [{ contract: VENUE, tokenId: "1" }, { contract: VENUE, tokenId: "2" }], priceEth: 0.2,
    })).error).toBe("no-wallet");
  });

  describe("fulfillNativeOrder reads what the order asks of the buyer, not only what it offers", () => {
    // A stored row is attacker-writable data. Seaport pulls every consideration
    // item from the buyer, so an item that is not ETH takes the buyer's own tokens.
    const goldAsking = (item) => {
      const order = nativeOrder(GOLD);
      order.parameters.consideration.push({ recipient: order.parameters.offerer, ...item });
      return order;
    };
    // Seaport would fill whatever reaches it, so a refusal is the only thing between.
    beforeEach(() => {
      const base = h.contractImpl;
      h.contractImpl = (method, target, args) => (method === "fulfillOrder"
        ? Promise.resolve({ hash: "0xfilled", wait: async () => ({ status: 1 }) })
        : base(method, target, args));
    });

    it("refuses a Gold Card offer whose consideration asks for a memes ERC-1155", async () => {
      const ob = await import("./lib/orderbook");
      const res = await ob.fulfillNativeOrder(goldAsking({
        itemType: 3, token: ADDR.junglebaymemes, identifierOrCriteria: "1", startAmount: "1", endAmount: "1",
      }));
      expectRefused(res);
      expectNothingHappened();
    });

    it("refuses a Gold Card offer whose consideration asks for WETH, which is not native ETH", async () => {
      const ob = await import("./lib/orderbook");
      const res = await ob.fulfillNativeOrder(goldAsking({
        itemType: 1, token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", identifierOrCriteria: "0", startAmount: "1000", endAmount: "1000",
      }));
      expect(res.error).toBe("not-eth-priced");
      expect(res.message).not.toMatch(/\u2014/);
      expect(res.success).toBeUndefined();
      expectNothingHappened();
    });

    it("positive control: a Gold Card native listing priced in ETH fills", async () => {
      const ob = await import("./lib/orderbook");
      const res = await ob.fulfillNativeOrder(nativeOrder(GOLD));
      expect(res.success).toBe(true);
      expect(h.browserProviders).toBe(1);
      const fill = h.contractCalls.find((c) => c.method === "fulfillOrder");
      expect(fill.args[0].parameters.offer[0].token).toBe(GOLD);
      expect(fill.args[2]).toEqual({ value: 1000n });
    });
  });
});

// ═══ api-offers.js: bids and accepting bids ═══
describe("api-offers.js", () => {
  for (const [label, contract] of Object.entries(NOT_ON_BOOK)) {
    it(`createItemOffer refuses ${label} before the WETH wrap and approve`, async () => {
      const offers = await import("./api-offers");
      expectRefused(await offers.createItemOffer({ tokenId: "1", priceEth: 0.01, contract }));
      expectNothingHappened();
    });

    it(`acceptOffer refuses a bid on ${label} before any setApprovalForAll`, async () => {
      const offers = await import("./api-offers");
      expectRefused(await offers.acceptOffer({ orderHash: "0xoffer", protocolAddress: SEAPORT_16, tokenContract: contract, tokenId: "1" }));
      expectNothingHappened();
    });
  }

  it("createCollectionOffer and createTraitOffer refuse a view-only collection's slug", async () => {
    const offers = await import("./api-offers");
    expectRefused(await offers.createCollectionOffer({ priceEth: 0.01, slug: "bojungles", openseaSlug: "bojungless" }));
    expectRefused(await offers.createTraitOffer({ traitType: "Artist", traitValue: "x", priceEth: 0.01, slug: "memeticseeds", openseaSlug: "seeds-from-the-memetic-garden" }));
    expectNothingHappened();
  });

  it("acceptOffer refuses an offer that names no contract, rather than assuming Nakamigos", async () => {
    const offers = await import("./api-offers");
    expectRefused(await offers.acceptOffer({ orderHash: "0xoffer", protocolAddress: SEAPORT_16, tokenId: "1" }));
    expectNothingHappened();
  });

  it("acceptOffer refuses when the fill's calldata hands over a foreign NFT, before the approval", async () => {
    h.openseaPost = vi.fn(async () => acceptFulfillment(ADDR.junglebaymemes));
    const offers = await import("./api-offers");
    const res = await offers.acceptOffer({ orderHash: "0xoffer", protocolAddress: SEAPORT_16, tokenContract: VENUE, tokenId: "7" });
    expectRefused(res);
    expect(h.contractCalls.map((c) => c.method)).not.toContain("setApprovalForAll");
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });

  it("positive control: accepting a venue bid whose calldata hands over that token fills", async () => {
    h.openseaPost = vi.fn(async () => acceptFulfillment(VENUE));
    const offers = await import("./api-offers");
    const res = await offers.acceptOffer({ orderHash: "0xoffer", protocolAddress: SEAPORT_16, tokenContract: VENUE, tokenId: "7" });
    expect(res.success).toBe(true);
  });

  it("positive controls: venue bids reach the no-wallet answer", async () => {
    disconnectWallet();
    const offers = await import("./api-offers");
    expect((await offers.createItemOffer({ tokenId: "1", priceEth: 0.01, contract: GOLD })).error).toBe("no-wallet");
    expect((await offers.createCollectionOffer({ priceEth: 0.01, slug: "gnssart", openseaSlug: "gnssart" })).error).toBe("no-wallet");
    expect((await offers.createTraitOffer({ traitType: "a", traitValue: "b", priceEth: 0.01, slug: "junglebaygoldcards", openseaSlug: "junglebaygoldcards" })).error).toBe("no-wallet");
    expect((await offers.acceptOffer({ orderHash: "0xoffer", tokenContract: VENUE, tokenId: "1" })).error).toBe("no-wallet");
  });

  describe("a collection or trait bid signs only for the collection it names", () => {
    // The NFT leg of a criteria bid comes from OpenSea's offers/build answer.
    // The slug check above cannot see it, so the answer itself is held to the
    // venue collection's contract, before any wrap, approve or signature.
    const criteria = (token, itemType = 4) => ({
      itemType, token, identifierOrCriteria: "0", startAmount: "1", endAmount: "1", recipient: WALLET,
    });
    const build = (consideration) => ({
      partialParameters: {
        consideration,
        zone: "0x" + "0".repeat(40),
        zoneHash: "0x" + "0".repeat(64),
      },
    });
    function answerBuild(consideration) {
      h.openseaPost = vi.fn(async (path) => (path === "offers/build" ? build(consideration) : { ok: true }));
    }
    const posted = () => h.openseaPost.mock.calls.map(([path]) => path);

    function expectNothingFundedOrSigned(res) {
      expect(res.success).toBeUndefined();
      expect(res.error).toBe("nft-mismatch");
      expect(typeof res.message).toBe("string");
      expect(h.wrapEth, "ETH was wrapped").not.toHaveBeenCalled();
      expect(h.approveWeth, "WETH was approved").not.toHaveBeenCalled();
      expect(h.signTypedData, "an order was signed").not.toHaveBeenCalled();
      expect(h.contractCalls.map((c) => c.method)).not.toContain("getCounter");
      expect(posted()).toEqual(["offers/build"]);
    }

    it("createCollectionOffer refuses a Gold Cards build whose NFT is Bojungles", async () => {
      answerBuild([criteria(ADDR.bojungles)]);
      const offers = await import("./api-offers");
      expectNothingFundedOrSigned(await offers.createCollectionOffer({ priceEth: 0.01, slug: "junglebaygoldcards", openseaSlug: "junglebaygoldcards" }));
    });

    it("createTraitOffer refuses a gnssart build whose NFT is the memes", async () => {
      answerBuild([criteria(ADDR.junglebaymemes)]);
      const offers = await import("./api-offers");
      expectNothingFundedOrSigned(await offers.createTraitOffer({ traitType: "a", traitValue: "b", priceEth: 0.01, slug: "gnssart", openseaSlug: "gnssart" }));
    });

    it("refuses a build that names the right contract with a second, foreign NFT beside it", async () => {
      answerBuild([criteria(GOLD), criteria(ADDR.raretowelie)]);
      const offers = await import("./api-offers");
      expectNothingFundedOrSigned(await offers.createCollectionOffer({ priceEth: 0.01, slug: "junglebaygoldcards", openseaSlug: "junglebaygoldcards" }));
    });

    it("refuses a build whose NFT is one token rather than a criteria item", async () => {
      answerBuild([criteria(GOLD, 2)]);
      const offers = await import("./api-offers");
      expectNothingFundedOrSigned(await offers.createCollectionOffer({ priceEth: 0.01, slug: "junglebaygoldcards", openseaSlug: "junglebaygoldcards" }));
    });

    it("refuses a build that names no NFT at all", async () => {
      answerBuild([{ itemType: 1, token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", identifierOrCriteria: "0", startAmount: "1", endAmount: "1", recipient: WALLET }]);
      const offers = await import("./api-offers");
      expectNothingFundedOrSigned(await offers.createTraitOffer({ traitType: "a", traitValue: "b", priceEth: 0.01, slug: "junglebaygoldcards", openseaSlug: "junglebaygoldcards" }));
    });

    it("a build that fails costs no gas: nothing is wrapped or approved", async () => {
      h.openseaPost = vi.fn(async () => { throw new Error("build down"); });
      const offers = await import("./api-offers");
      const res = await offers.createCollectionOffer({ priceEth: 0.01, slug: "junglebaygoldcards", openseaSlug: "junglebaygoldcards" });
      expect(res.error).toBe("build-failed");
      expect(h.wrapEth).not.toHaveBeenCalled();
      expect(h.approveWeth).not.toHaveBeenCalled();
      expect(h.signTypedData).not.toHaveBeenCalled();
    });

    it("positive control: a Gold Cards build naming Gold Cards (any case) is funded, signed and posted", async () => {
      answerBuild([criteria(GOLD.toLowerCase())]);
      const offers = await import("./api-offers");
      const res = await offers.createCollectionOffer({ priceEth: 0.01, slug: "junglebaygoldcards", openseaSlug: "junglebaygoldcards" });
      expect(res.success).toBe(true);
      expect(h.wrapEth).toHaveBeenCalledTimes(1);
      expect(h.approveWeth).toHaveBeenCalledTimes(1);
      expect(h.signTypedData).toHaveBeenCalledTimes(1);
      const signed = h.signTypedData.mock.calls[0][2];
      const nftTokens = signed.consideration.filter((c) => [2, 3, 4, 5].includes(Number(c.itemType))).map((c) => c.token.toLowerCase());
      expect(nftTokens).toEqual([GOLD.toLowerCase()]);
      expect(posted()).toEqual(["offers/build", "criteria_offers"]);
    });

    it("positive control: a gnssart trait build naming gnssart is signed", async () => {
      answerBuild([criteria(VENUE)]);
      const offers = await import("./api-offers");
      const res = await offers.createTraitOffer({ traitType: "a", traitValue: "b", priceEth: 0.01, slug: "gnssart", openseaSlug: "gnssart" });
      expect(res.success).toBe(true);
      expect(h.signTypedData).toHaveBeenCalledTimes(1);
    });
  });

  describe("an item bid names a token that exists", () => {
    // Gold Cards ids run 1..123; ownerOf(0) and ownerOf(124) revert. A bid on
    // an id that does not exist used to wrap ETH and approve WETH before
    // OpenSea could reject it: gas spent on an order nobody can ever fill.
    it("refuses a bid when ownerOf reverts, before any wrap, approve or signature", async () => {
      const base = h.contractImpl;
      h.contractImpl = (method, target, args) => (method === "ownerOf"
        ? Promise.reject(Object.assign(new Error("execution reverted: ERC721: owner query for nonexistent token"), { code: "CALL_EXCEPTION" }))
        : base(method, target, args));
      const offers = await import("./api-offers");
      const res = await offers.createItemOffer({ tokenId: "0", priceEth: 0.01, contract: GOLD });
      expect(res.success).toBeUndefined();
      expect(res.message).toMatch(/does not exist/i);
      expect(h.contractCalls.some((c) => c.method === "ownerOf" && c.target.toLowerCase() === GOLD.toLowerCase())).toBe(true);
      expect(h.wrapEth).not.toHaveBeenCalled();
      expect(h.approveWeth).not.toHaveBeenCalled();
      expect(h.signTypedData).not.toHaveBeenCalled();
      expect(h.openseaPost).not.toHaveBeenCalled();
    });

    it("positive control: a token that exists goes on to fund the bid", async () => {
      const offers = await import("./api-offers");
      await offers.createItemOffer({ tokenId: "1", priceEth: 0.01, contract: GOLD });
      expect(h.wrapEth).toHaveBeenCalled();
    });
  });
});

// ═══ lib/trades.js: P2P trades ═══
describe("lib/trades.js", () => {
  const TAKER = "0x" + "d".repeat(40);
  const trade = ({ offerToken, considerationItem }) => ({
    protocol_address: SEAPORT_16,
    signature: "0xsig",
    offerer: "0x" + "c".repeat(40),
    parameters: {
      offerer: "0x" + "c".repeat(40),
      zone: "0x0000000000000000000000000000000000000000",
      offer: [{ itemType: 2, token: offerToken, identifierOrCriteria: "1", startAmount: "1", endAmount: "1" }],
      consideration: [considerationItem],
      orderType: 0,
      startTime: String(Math.floor(Date.now() / 1000) - 60),
      endTime: String(Math.floor(Date.now() / 1000) + 3600),
      salt: "1",
    },
  });
  const nft = (token, id = "2") => ({ itemType: 2, token, identifierOrCriteria: id, startAmount: "1", endAmount: "1", recipient: "0x" + "c".repeat(40) });
  const anyOf = (token) => ({ itemType: 4, token, identifierOrCriteria: "0", startAmount: "1", endAmount: "1", recipient: "0x" + "c".repeat(40) });

  for (const [label, contract] of Object.entries(NON_VENUE)) {
    it(`createTradeOffer refuses giving ${label}`, async () => {
      const t = await import("./lib/trades");
      expectRefused(await t.createTradeOffer({ give: [{ contract, tokenId: "1" }], get: [{ contract: VENUE, tokenId: "2" }], taker: TAKER }));
      expectNothingHappened();
    });

    it(`createTradeOffer refuses asking for any ${label}`, async () => {
      const t = await import("./lib/trades");
      expectRefused(await t.createTradeOffer({ give: [{ contract: VENUE, tokenId: "1" }], get: [{ contract, any: true }], open: true }));
      expectNothingHappened();
    });

    it(`acceptTrade refuses a trade carrying ${label}`, async () => {
      const t = await import("./lib/trades");
      expectRefused(await t.acceptTrade(trade({ offerToken: contract, considerationItem: nft(VENUE) })));
      expectNothingHappened();
    });

    it(`acceptOpenTrade refuses an open trade asking for any ${label}`, async () => {
      const t = await import("./lib/trades");
      expectRefused(await t.acceptOpenTrade(trade({ offerToken: VENUE, considerationItem: anyOf(contract) }), { 0: "5" }));
      expectNothingHappened();
    });
  }

  it("cancelTradeOnChain is NOT refused for an Ethereum contract outside the venue: it can act on the order", async () => {
    const t = await import("./lib/trades");
    // The connected wallet is the maker here: only a maker can cancel.
    const mine = trade({ offerToken: ADDR.junglebaymemes, considerationItem: nft(VENUE) });
    mine.offerer = WALLET;
    mine.parameters.offerer = WALLET;
    const res = await t.cancelTradeOnChain(mine);
    expect(res.error).not.toBe("not-venue-tradeable");
    expect(h.contractCalls.map((c) => c.method)).toContain("cancel");
  });

  it("cancelTradeOnChain refuses a trade carrying a Base NFT, before any wallet call", async () => {
    const t = await import("./lib/trades");
    const mine = trade({ offerToken: VENUE, considerationItem: nft(ADDR.bojungles) });
    mine.offerer = WALLET;
    mine.parameters.offerer = WALLET;
    const res = await t.cancelTradeOnChain(mine);
    expectRefused(res);
    expect(res.message).toMatch(/Bojungles/);
    expect(res.message).toMatch(/\bBase\b/);
    expect(res.message).toMatch(/OpenSea/);
    expectNothingHappened();
  });

  it("positive controls: venue trades reach the no-wallet answer", async () => {
    disconnectWallet();
    const t = await import("./lib/trades");
    expect((await t.createTradeOffer({ give: [{ contract: GOLD, tokenId: "1" }], get: [{ contract: VENUE, tokenId: "2" }], taker: TAKER })).error).toBe("no-wallet");
    expect((await t.acceptTrade(trade({ offerToken: VENUE, considerationItem: nft(GOLD) }))).error).toBe("no-wallet");
    expect((await t.acceptOpenTrade(trade({ offerToken: VENUE, considerationItem: anyOf(VENUE) }), { 0: "5" })).error).toBe("no-wallet");
  });
});

// ═══ cancels: open on Ethereum, refused for an order on another chain ═══
describe("cancels", () => {
  const ETHEREUM_NON_VENUE = {
    "the memes (Ethereum ERC-1155)": ADDR.junglebaymemes,
    "Rare Towelie Cards (Ethereum ERC-1155)": ADDR.raretowelie,
  };
  const ON_BASE = {
    "Bojungles (Base ERC-721)": [ADDR.bojungles, "Bojungles"],
    "Seeds (Base ERC-721)": [ADDR.memeticseeds, "Seeds from the Memetic Garden"],
  };
  const listingParams = (token) => ({ offerer: WALLET, offer: [{ itemType: 2, token, identifierOrCriteria: "1", startAmount: "1", endAmount: "1" }], consideration: [] });
  // A bid: the NFT the offerer wants sits in the consideration.
  const bidParams = (token) => ({
    offerer: WALLET,
    offer: [{ itemType: 1, token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", identifierOrCriteria: "0", startAmount: "1", endAmount: "1" }],
    consideration: [{ itemType: 2, token, identifierOrCriteria: "1", startAmount: "1", endAmount: "1", recipient: WALLET }],
  });

  for (const [label, contract] of Object.entries(ETHEREUM_NON_VENUE)) {
    it(`cancelSeaportOrder still cancels an order that carries ${label}`, async () => {
      const { cancelSeaportOrder } = await import("./lib/seaportCancel");
      const { ethers } = await import("ethers");
      const tx = await cancelSeaportOrder({ ethers, signer: {}, params: listingParams(contract), seaportAddress: SEAPORT_16 });
      expect(tx?.hash).toBe("0xcancel");
    });

    it(`api-offers cancelOrder still cancels an order that carries ${label}`, async () => {
      const offers = await import("./api-offers");
      const res = await offers.cancelOrder({ protocol_address: SEAPORT_16, protocol_data: { parameters: listingParams(contract) } });
      expect(res.success).toBe(true);
    });
  }

  for (const [label, [contract]] of Object.entries(ON_BASE)) {
    it(`api-offers cancelOrder cancels a listing of ${label} on Seaport 1.6, with the wallet on Base`, async () => {
      h.chainId = 8453n;
      const offers = await import("./api-offers");
      const res = await offers.cancelOrder({ protocol_address: SEAPORT_16, protocol_data: { parameters: listingParams(contract) } });
      expect(res.success).toBe(true);
      expect(h.contractCalls.map((c) => [c.method, c.target.toLowerCase()])).toEqual([["getCounter", SEAPORT_16.toLowerCase()], ["cancel", SEAPORT_16.toLowerCase()]]);
    });

    it(`api-offers cancelOrder of a bid on ${label} asks for Base while the wallet is on Ethereum, and sends nothing`, async () => {
      const offers = await import("./api-offers");
      const res = await offers.cancelOrder({ rawOrder: { protocol_address: SEAPORT_16, protocol_data: { parameters: bidParams(contract) } } });
      expect(res.error).toBe("wrong-chain");
      expect(res.chainId).toBe(8453);
      expect(h.contractCalls).toEqual([]);
    });

    it(`cancelSeaportOrder refuses a ${label} order while the signer is on Ethereum, before reading a counter`, async () => {
      const { cancelSeaportOrder } = await import("./lib/seaportCancel");
      const { ethers } = await import("ethers");
      const signer = { provider: { getNetwork: async () => ({ chainId: 1n }) } };
      await expect(cancelSeaportOrder({ ethers, signer, params: listingParams(contract), seaportAddress: SEAPORT_16 }))
        .rejects.toMatchObject({ code: "wrong-chain" });
      expect(h.contractCalls).toEqual([]);
    });

    it(`cancelSeaportOrder refuses a ${label} order named on Seaport 1.5: it was signed for 1.6`, async () => {
      const { cancelSeaportOrder } = await import("./lib/seaportCancel");
      const { ethers } = await import("ethers");
      const signer = { provider: { getNetwork: async () => ({ chainId: 8453n }) } };
      await expect(cancelSeaportOrder({ ethers, signer, params: listingParams(contract), seaportAddress: SEAPORT_15 }))
        .rejects.toThrow(/Unexpected transaction target/);
      expect(h.contractCalls).toEqual([]);
    });
  }

  it("positive control: a venue cancel still reaches the chain", async () => {
    const offers = await import("./api-offers");
    const res = await offers.cancelOrder({ protocol_address: SEAPORT_16, protocol_data: { parameters: listingParams(GOLD) } });
    expect(res.success).toBe(true);
    expect(h.contractCalls.map((c) => c.method)).toEqual(["getCounter", "cancel"]);
  });
});

// ═══ Bojungles and Seeds on the book and in bids, on Base ═══
describe("Bojungles and Seeds are listed, bought from the book and bid on, on Base only", () => {
  const BASE = 8453n;
  const nativeOrder = (token, protocol = SEAPORT_16) => ({
    order_hash: "0x" + "d".repeat(64),
    contract_address: token.toLowerCase(),
    protocol_address: protocol,
    signature: "0xsig",
    parameters: {
      offerer: "0x" + "c".repeat(40),
      offer: [{ itemType: 2, token, identifierOrCriteria: "7", startAmount: "1", endAmount: "1" }],
      consideration: [
        { itemType: 0, token: "0x0000000000000000000000000000000000000000", identifierOrCriteria: "0", startAmount: "995", endAmount: "995", recipient: "0x" + "c".repeat(40) },
        { itemType: 0, token: "0x0000000000000000000000000000000000000000", identifierOrCriteria: "0", startAmount: "5", endAmount: "5", recipient: BASE_SAFE },
      ],
      endTime: String(Math.floor(Date.now() / 1000) + 3600),
    },
  });
  const posted = () => fetchSpy.mock.calls.filter(([url]) => url === "/api/orderbook").map(([, init]) => JSON.parse(init.body));

  for (const [label, contract] of [["Bojungles", ADDR.bojungles], ["Seeds", ADDR.memeticseeds]]) {
    describe(label, () => {
      it("a listing with the wallet on Ethereum asks for Base, and nothing is approved or signed", async () => {
        const ob = await import("./lib/orderbook");
        const res = await ob.createNativeListing({ contract, tokenId: "7", priceEth: 0.02 });
        expect(res.error).toBe("wrong-chain");
        expect(res.chainId).toBe(8453);
        expect(h.contractCalls).toEqual([]);
        expect(h.signTypedData).not.toHaveBeenCalled();
        expect(posted()).toEqual([]);
      });

      it("a listing on Base is signed for Seaport 1.6 on Base and pays 0.5% to the Base treasury Safe", async () => {
        h.chainId = BASE;
        const base = h.contractImpl;
        h.contractImpl = (method, target, args) => (method === "isApprovedForAll" ? Promise.resolve(true) : base(method, target, args));
        const ob = await import("./lib/orderbook");
        const res = await ob.createNativeListing({ contract, tokenId: "7", priceEth: 0.02 });
        expect(res.success).toBe(true);
        const [domain, , signed] = h.signTypedData.mock.calls[0];
        expect(domain).toEqual({ name: "Seaport", version: "1.6", chainId: 8453, verifyingContract: SEAPORT_16 });
        expect(signed.consideration.map((c) => [c.recipient, c.startAmount])).toEqual([
          [WALLET, "19900000000000000"],
          [BASE_SAFE, "100000000000000"],
        ]);
        expect(signed.consideration.map((c) => c.recipient)).not.toContain(ETH_SAFE);
        expect(h.contractCalls.find((c) => c.method === "getCounter").target).toBe(SEAPORT_16);
        expect(h.contractCalls.find((c) => c.method === "isApprovedForAll").target).toBe(contract);
        const [body] = posted();
        expect(body.action).toBe("create");
        expect(body.order.protocol_address).toBe(SEAPORT_16);
      });

      it("a listing on Base from a wallet that does not own the token is refused before any approval", async () => {
        h.chainId = BASE;
        const base = h.contractImpl;
        h.contractImpl = (method, target, args) => (method === "ownerOf" ? Promise.resolve("0x" + "c".repeat(40)) : base(method, target, args));
        const ob = await import("./lib/orderbook");
        const res = await ob.createNativeListing({ contract, tokenId: "7", priceEth: 0.02 });
        expect(res.error).toBe("not-owner");
        expect(h.contractCalls.map((c) => c.method)).not.toContain("setApprovalForAll");
        expect(h.signTypedData).not.toHaveBeenCalled();
      });

      it("its native listing is bought on Base, on Seaport 1.6, and the fill is reported as Base's", async () => {
        h.chainId = BASE;
        const base = h.contractImpl;
        h.contractImpl = (method, target, args) => (method === "fulfillOrder"
          ? Promise.resolve({ hash: "0xfilled", wait: async () => ({ status: 1 }) })
          : base(method, target, args));
        const ob = await import("./lib/orderbook");
        const res = await ob.fulfillNativeOrder(nativeOrder(contract));
        expect(res.success).toBe(true);
        const fill = h.contractCalls.find((c) => c.method === "fulfillOrder");
        expect(fill.target).toBe(SEAPORT_16);
        expect(fill.args[2]).toEqual({ value: 1000n });
        expect(posted().map((b) => [b.action, b.chainId])).toEqual([["fill", 8453]]);
      });

      it("its native listing is refused with the wallet on Ethereum, and when the row names Seaport 1.5", async () => {
        const ob = await import("./lib/orderbook");
        const wrong = await ob.fulfillNativeOrder(nativeOrder(contract));
        expect(wrong.error).toBe("wrong-chain");
        h.chainId = BASE;
        const foreign = await ob.fulfillNativeOrder(nativeOrder(contract, SEAPORT_15));
        expect(foreign.message).toMatch(/Unexpected transaction target/);
        expect(h.sendTransaction).not.toHaveBeenCalled();
        expect(h.contractCalls.map((c) => c.method)).not.toContain("fulfillOrder");
      });

      it("its native listing is cancelled on Base, then the row with chain 8453", async () => {
        h.chainId = BASE;
        const ob = await import("./lib/orderbook");
        const order = nativeOrder(contract);
        order.parameters.offerer = WALLET;
        const res = await ob.cancelNativeListing(order);
        expect(res.success).toBe(true);
        expect(h.contractCalls.map((c) => [c.method, c.target])).toEqual([["getCounter", SEAPORT_16], ["cancel", SEAPORT_16]]);
        expect(posted().map((b) => [b.action, b.chainId])).toEqual([["cancel", 8453]]);
      });

      it("an item bid on Base is funded in Base WETH, signed for Seaport 1.6 on Base, pays the Base treasury and is posted to Base", async () => {
        h.chainId = BASE;
        h.openseaPost = vi.fn(async () => ({ order: { order_hash: "0xbid" } }));
        const offers = await import("./api-offers");
        const res = await offers.createItemOffer({ tokenId: "7", priceEth: 0.01, contract });
        expect(res.success).toBe(true);
        expect(h.wrapEth.mock.calls[0][1]).toBe(8453);
        expect(h.approveWeth.mock.calls[0][1]).toBe(8453);
        const [domain, , signed] = h.signTypedData.mock.calls[0];
        expect(domain).toEqual({ name: "Seaport", version: "1.6", chainId: 8453, verifyingContract: SEAPORT_16 });
        expect(signed.offer[0].token).toBe(BASE_WETH);
        expect(signed.consideration.map((c) => [c.token, c.recipient, c.startAmount])).toEqual([
          [contract, WALLET, "1"],
          [BASE_WETH, "0x0000a26b00c1F0DF003000390027140000fAa719", "100000000000000"],
          [BASE_WETH, BASE_SAFE, "50000000000000"],
        ]);
        expect(h.openseaPost.mock.calls[0][0]).toBe("orders/base/seaport/offers");
        expect(h.openseaPost.mock.calls[0][1].protocol_address).toBe(SEAPORT_16);
        // The token is read on Base, through the wallet, not Ethereum's read provider.
        expect(h.contractCalls.find((c) => c.method === "ownerOf").target).toBe(contract);
      });

      it("an item bid with the wallet on Ethereum asks for Base, and nothing is wrapped or signed", async () => {
        const offers = await import("./api-offers");
        const res = await offers.createItemOffer({ tokenId: "7", priceEth: 0.01, contract });
        expect(res.error).toBe("wrong-chain");
        expect(res.chainId).toBe(8453);
        expect(h.wrapEth).not.toHaveBeenCalled();
        expect(h.approveWeth).not.toHaveBeenCalled();
        expect(h.signTypedData).not.toHaveBeenCalled();
      });

      it("accepting a bid on Base asks OpenSea for a Base fill and sends it when the calldata hands over this token", async () => {
        h.chainId = BASE;
        h.openseaPost = vi.fn(async () => acceptFulfillment(contract));
        const offers = await import("./api-offers");
        const res = await offers.acceptOffer({ orderHash: "0xoffer", protocolAddress: SEAPORT_16, tokenContract: contract, tokenId: "7" });
        expect(res.success).toBe(true);
        expect(h.openseaPost.mock.calls[0][1].offer.chain).toBe("base");
      });

      it("accepting a bid on Base refuses calldata that hands over an Ethereum venue NFT, before the approval", async () => {
        h.chainId = BASE;
        h.openseaPost = vi.fn(async () => acceptFulfillment(GOLD));
        const offers = await import("./api-offers");
        const res = await offers.acceptOffer({ orderHash: "0xoffer", protocolAddress: SEAPORT_16, tokenContract: contract, tokenId: "7" });
        expect(res.success).toBeUndefined();
        expect(h.contractCalls.map((c) => c.method)).not.toContain("setApprovalForAll");
        expect(h.sendTransaction).not.toHaveBeenCalled();
      });
    });
  }

  it("an Ethereum listing is unchanged: Seaport 1.5 on chain 1, fee to the Ethereum fee Safe", async () => {
    const base = h.contractImpl;
    h.contractImpl = (method, target, args) => (method === "isApprovedForAll" ? Promise.resolve(true) : base(method, target, args));
    const ob = await import("./lib/orderbook");
    const res = await ob.createNativeListing({ contract: GOLD, tokenId: "7", priceEth: 0.02 });
    expect(res.success).toBe(true);
    const [domain, , signed] = h.signTypedData.mock.calls[0];
    expect(domain).toEqual({ name: "Seaport", version: "1.5", chainId: 1, verifyingContract: SEAPORT_15 });
    expect(signed.consideration[1].recipient).toBe(ETH_SAFE);
    expect(posted()[0].order.protocol_address).toBe(SEAPORT_15);
  });

  it("an Ethereum item bid is unchanged: Ethereum WETH, the Ethereum fee Safe, posted to Ethereum", async () => {
    h.openseaPost = vi.fn(async () => ({ order: { order_hash: "0xbid" } }));
    const offers = await import("./api-offers");
    const res = await offers.createItemOffer({ tokenId: "7", priceEth: 0.01, contract: GOLD });
    expect(res.success).toBe(true);
    const [, , signed] = h.signTypedData.mock.calls[0];
    expect(signed.consideration[2].recipient).toBe(ETH_SAFE);
    expect(signed.offer[0].token).toBe("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    expect(h.openseaPost.mock.calls[0][0]).toBe("orders/ethereum/seaport/offers");
    expect(h.wrapEth.mock.calls[0][1]).toBe(1);
  });

  it("a Bojungles bundle is still refused: bundles stay Ethereum only", async () => {
    h.chainId = BASE;
    const ob = await import("./lib/orderbook");
    expectRefused(await ob.createNativeBundleListing({ items: [{ contract: ADDR.bojungles, tokenId: "1" }, { contract: ADDR.bojungles, tokenId: "2" }], priceEth: 0.2 }));
  });
});

// ═══ the cart ═══
describe("CartContext", () => {
  it("addToCart does nothing under a view-only collection, and writes nothing to storage", async () => {
    localStorage.clear();
    const { CollectionProvider } = await import("./contexts/CollectionContext");
    const { CartProvider, useCart } = await import("./contexts/CartContext");
    let cart;
    function Probe() { cart = useCart(); return null; }
    const view = render(
      <CollectionProvider slug="bojungles">
        <CartProvider><Probe /></CartProvider>
      </CollectionProvider>,
    );
    act(() => cart.addToCart({ id: "0", name: "Bojungles #0", price: 0.1 }));
    expect(cart.cartCount).toBe(0);
    for (let i = 0; i < localStorage.length; i++) {
      expect(localStorage.getItem(localStorage.key(i)), localStorage.key(i)).not.toContain("Bojungles #0");
    }
    view.unmount();
  });

  it("positive control: the cart still works for a venue collection", async () => {
    localStorage.clear();
    const { CollectionProvider } = await import("./contexts/CollectionContext");
    const { CartProvider, useCart } = await import("./contexts/CartContext");
    let cart;
    function Probe() { cart = useCart(); return null; }
    const view = render(
      <CollectionProvider slug="gnssart">
        <CartProvider><Probe /></CartProvider>
      </CollectionProvider>,
    );
    act(() => cart.addToCart({ id: "5", name: "GNSS #5", price: 0.1 }));
    expect(cart.cartCount).toBe(1);
    view.unmount();
  });
});


// ═══ The fill is held to the trade on screen (lib/seaportTrade.js) ═══
//
// The checks above pin WHICH NFT contract a fill moves. These pin the rest of
// what OpenSea's answer could commit the user to, end to end through the real
// buy, accept and bid functions: each tampered answer is refused before any
// approval, signature or transaction, and a sound one still goes through.
describe("a fill is held to the trade on screen", () => {
  const ATTACKER = "0x00000000000000000000000000000000deadbeef";
  const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const listing = (over = {}) => ({ tokenId: "7", priceWei: "100000000000000000", orderHash: "0xabc", protocolAddress: SEAPORT_16, contract: VENUE, ...over });

  it("a buy whose fill moves a different token than the card is refused, unsent", async () => {
    const api = await import("./api");
    const res = await api.fulfillSeaportOrder(listing({ tokenId: "8" }), { buyerAddress: WALLET });
    expect(res.error).toBe("nft-mismatch");
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });

  it("a buy whose fill asks more ETH than the price shown is refused, unsent", async () => {
    const api = await import("./api");
    const res = await api.fulfillSeaportOrder(listing({ priceWei: "50000000000000000" }), { buyerAddress: WALLET });
    expect(res.error).toBe("over-price");
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });

  it("a buy whose fill is paid in USDC is refused, unsent", async () => {
    const usdcFill = buyFulfillment(VENUE);
    Object.assign(usdcFill.fulfillment_data.transaction.input_data.parameters, { basicOrderType: 8, considerationToken: USDC });
    usdcFill.fulfillment_data.transaction.value = "0";
    h.openseaPost = vi.fn(async () => usdcFill);
    const api = await import("./api");
    const res = await api.fulfillSeaportOrder(listing(), { buyerAddress: WALLET });
    expect(res.error).toBe("not-eth");
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });

  it("the cart refuses the same tampered fill before the wallet is asked to batch", async () => {
    const api = await import("./api");
    const res = await api.fulfillSeaportOrdersBatch([listing({ tokenId: "8" })], { buyerAddress: WALLET });
    expect(res.error).toBe("build-failed");
    expect(h.providerRequest.mock.calls.map(([a]) => a?.method)).not.toContain("wallet_sendCalls");
  });

  it("an accept whose fill asks the seller for ETH is refused before the approval", async () => {
    const fill = acceptFulfillment(VENUE);
    fill.fulfillment_data.transaction.value = "1";
    h.openseaPost = vi.fn(async () => fill);
    const offers = await import("./api-offers");
    const res = await offers.acceptOffer({ orderHash: "0xoffer", protocolAddress: SEAPORT_16, tokenContract: VENUE, tokenId: "7" });
    expect(res.error).toBe("sends-eth");
    expect(h.contractCalls.map((c) => c.method)).not.toContain("setApprovalForAll");
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });

  it("an accept whose fill hands over a different token is refused before the approval", async () => {
    h.openseaPost = vi.fn(async () => acceptFulfillment(VENUE, { tokenId: "7" }));
    const offers = await import("./api-offers");
    const res = await offers.acceptOffer({ orderHash: "0xoffer", protocolAddress: SEAPORT_16, tokenContract: VENUE, tokenId: "8" });
    expect(res.error).toBe("nft-mismatch");
    expect(h.contractCalls.map((c) => c.method)).not.toContain("setApprovalForAll");
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });

  describe("a bid build", () => {
    const nftLeg = (over = {}) => ({ itemType: 4, token: GOLD, identifierOrCriteria: "0", startAmount: "1", endAmount: "1", recipient: WALLET, ...over });
    const answer = (partial) => {
      h.openseaPost = vi.fn(async (path) => (path === "offers/build"
        ? { partialParameters: { zone: "0x" + "0".repeat(40), zoneHash: "0x" + "0".repeat(64), ...partial } }
        : { ok: true }));
    };
    const bid = async () => (await import("./api-offers")).createCollectionOffer({ priceEth: 0.01, slug: "junglebaygoldcards", openseaSlug: "junglebaygoldcards" });
    const expectUnfunded = () => {
      expect(h.wrapEth, "ETH was wrapped").not.toHaveBeenCalled();
      expect(h.approveWeth, "WETH was approved").not.toHaveBeenCalled();
      expect(h.signTypedData, "an order was signed").not.toHaveBeenCalled();
    };

    it("delivering the NFT to another wallet is refused before anything is funded or signed", async () => {
      answer({ consideration: [nftLeg({ recipient: ATTACKER })] });
      expect((await bid()).error).toBe("wrong-recipient");
      expectUnfunded();
    });

    it("a foreign conduit is refused before anything is funded or signed", async () => {
      answer({ consideration: [nftLeg()], conduitKey: "0x" + "1".repeat(64) });
      expect((await bid()).error).toBe("build-mismatch");
      expectUnfunded();
    });

    it("a contract-order type is refused before anything is funded or signed", async () => {
      answer({ consideration: [nftLeg()], orderType: 4 });
      expect((await bid()).error).toBe("build-mismatch");
      expectUnfunded();
    });

    it("positive control: the standard build delivering to the bidder is signed", async () => {
      answer({ consideration: [nftLeg()], conduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000", orderType: 2 });
      expect((await bid()).success).toBe(true);
      expect(h.signTypedData).toHaveBeenCalledTimes(1);
    });
  });
});
