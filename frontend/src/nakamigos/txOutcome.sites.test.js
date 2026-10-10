// Every marketplace function that waits on a transaction, against every way
// ethers' wait() can end.
//
// A helper's own tests prove the rule exists, not that anyone calls it. So this
// file is the parity table: each site that sends a transaction, times each
// outcome, asserted on what the site RETURNS. The error shapes are the ones
// lib/txOutcome.ethers.test.js measures from the real library.
//
//   revert             -> the site's own "reverted" answer
//   unread receipt     -> "unconfirmed": we can't tell, never "failed"
//   wallet cancel      -> "replaced": it did not happen
//   a different call   -> "replaced": it did not happen as sent
//   speed-up           -> success, under the hash that mined
//   speed-up, reverted -> the site's "reverted" answer
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeError } from "ethers";
import { ADDR } from "./__fixtures__/jungleBayFamily";
import { buyFulfillment, acceptFulfillment, SEAPORT_16 } from "./__fixtures__/seaportFulfillment";

const VENUE = ADDR.gnssart;
const GOLD = ADDR.junglebaygoldcards;
const WALLET = "0x" + "a".repeat(40);
const OFFERER = "0x" + "c".repeat(40);
const TAKER = "0x" + "d".repeat(40);
const ZERO = "0x0000000000000000000000000000000000000000";
const SENT = "0x" + "11".repeat(32);
const TOOK = "0x" + "22".repeat(32);

const h = vi.hoisted(() => ({
  account: null,
  fault: null,
  sent: [],
  approved: false,
  wethBalance: 0n,
  ownerOf: null,
  sendTransaction: null,
  signTypedData: null,
  signMessage: null,
  openseaPost: null,
}));

// A transaction the wallet accepted. Its wait() resolves unless this test
// faults the transaction of that name.
function sendTx(name) {
  h.sent.push(name);
  return Promise.resolve({
    hash: SENT,
    wait: () => (h.fault?.at === name ? h.fault.wait() : Promise.resolve({ status: 1, hash: SENT })),
  });
}

vi.mock("./constants", async (importOriginal) => ({
  ...(await importOriginal()),
  BUNDLE_LISTING_ENABLED: true,
}));
vi.mock("../lib/wagmi", () => ({ config: { __test: true } }));
vi.mock("wagmi/actions", () => ({ getAccount: () => h.account }));

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal();
  class MockBrowserProvider {
    async getNetwork() { return { chainId: 1n }; }
    async getBalance() { return 10n ** 20n; }
    // No EIP-5792: the atomic batch declines and the sequential path runs.
    async send() { throw new Error("unsupported"); }
    async getSigner() {
      return {
        provider: { getBalance: async () => 10n ** 20n },
        getAddress: async () => WALLET,
        sendTransaction: () => sendTx("sendTransaction"),
        signTypedData: (...a) => h.signTypedData(...a),
        signMessage: (...a) => h.signMessage(...a),
      };
    }
  }
  const TX_METHODS = new Set([
    "setApprovalForAll", "cancel", "fulfillOrder", "fulfillAdvancedOrder", "deposit", "approve",
  ]);
  class MockContract {
    constructor(target, abi) {
      this.target = target;
      this.interface = new actual.Interface(abi);
      return new Proxy(this, {
        get(obj, prop) {
          if (prop in obj) return obj[prop];
          if (typeof prop !== "string" || prop === "then") return undefined;
          return (...args) => {
            if (TX_METHODS.has(prop)) return sendTx(prop);
            switch (prop) {
              case "isApprovedForAll": return Promise.resolve(h.approved || h.sent.includes("setApprovalForAll"));
              case "ownerOf": return Promise.resolve(h.ownerOf(String(target), args));
              case "getCounter": return Promise.resolve(0n);
              case "getOrderStatus": return Promise.resolve([true, false, 0n, 1n]);
              case "balanceOf": return Promise.resolve(h.wethBalance);
              case "allowance": return Promise.resolve(0n);
              default: return Promise.resolve(undefined);
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
  openseaGet: vi.fn(async () => ({})),
  openseaPost: (...a) => h.openseaPost(...a),
  ApiError: class ApiError extends Error {},
}));
vi.mock("./lib/rpcProvider", () => ({ getReadProvider: async () => ({ __readProvider: true }) }));

let fetchSpy;

beforeEach(() => {
  vi.resetModules();
  h.fault = null;
  h.sent = [];
  h.approved = false;
  h.wethBalance = 0n;
  h.ownerOf = () => WALLET;
  h.signTypedData = vi.fn(async () => "0x" + "ab".repeat(65));
  h.signMessage = vi.fn(async () => "0x" + "cd".repeat(65));
  h.openseaPost = vi.fn(async () => buyFulfillment(VENUE));
  fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "{}" }));
  vi.stubGlobal("fetch", fetchSpy);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const provider = { request: vi.fn(async () => null) };
  h.account = { address: WALLET, connector: { getProvider: async () => provider } };
  window.ethereum = provider;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.ethereum;
});

// What wait() does, in the shapes ethers 6 throws them.
const replacedError = (reason, status) => makeError("transaction was replaced", "TRANSACTION_REPLACED", {
  cancelled: reason !== "repriced", reason, replacement: {}, hash: TOOK, receipt: { status, hash: TOOK },
});
const WAITS = {
  revert: () => Promise.reject(makeError("transaction execution reverted", "CALL_EXCEPTION", {
    action: "sendTransaction", data: null, reason: null, invocation: null, revert: null,
    transaction: { to: null, from: WALLET, data: "" }, receipt: { status: 0, hash: SENT },
  })),
  unread: () => Promise.reject(makeError("could not coalesce error", "UNKNOWN_ERROR", {
    error: { code: -32005, message: "limit exceeded" },
  })),
  cancel: () => Promise.reject(replacedError("cancelled", 1)),
  otherCall: () => Promise.reject(replacedError("replaced", 1)),
  speedUp: () => Promise.reject(replacedError("repriced", 1)),
  speedUpReverted: () => Promise.reject(replacedError("repriced", 0)),
};

// ─── the sites ───────────────────────────────────────────────────────────────

const listingParams = (token) => ({
  offerer: WALLET,
  offer: [{ itemType: 2, token, identifierOrCriteria: "1", startAmount: "1", endAmount: "1" }],
  consideration: [],
});
const nativeOrder = (token) => ({
  order_hash: "0xrow",
  contract_address: token.toLowerCase(),
  protocol_address: SEAPORT_16,
  signature: "0x" + "ab".repeat(65),
  parameters: {
    offerer: OFFERER,
    offer: [{ itemType: 2, token, identifierOrCriteria: "1", startAmount: "1", endAmount: "1" }],
    consideration: [{ itemType: 0, token: ZERO, identifierOrCriteria: "0", startAmount: "1000", endAmount: "1000", recipient: OFFERER }],
    endTime: String(Math.floor(Date.now() / 1000) + 3600),
  },
});
const trade = (considerationItem, offerer = OFFERER) => ({
  id: "trade-1",
  protocol_address: SEAPORT_16,
  signature: "0x" + "ab".repeat(65),
  offerer,
  parameters: {
    offerer,
    zone: ZERO,
    offer: [{ itemType: 2, token: VENUE, identifierOrCriteria: "1", startAmount: "1", endAmount: "1" }],
    consideration: [considerationItem],
    orderType: 0,
    startTime: String(Math.floor(Date.now() / 1000) - 60),
    endTime: String(Math.floor(Date.now() / 1000) + 3600),
    salt: "1",
  },
});
const wants = (itemType, id) => ({ itemType, token: GOLD, identifierOrCriteria: id, startAmount: "1", endAmount: "1", recipient: OFFERER });
// The maker owns what the trade offers; the connected wallet owns the rest.
const tradeOwners = (target) => (target.toLowerCase() === VENUE.toLowerCase() ? OFFERER : WALLET);
const criteriaBuild = (token) => (path) => (path === "offers/build"
  ? { partialParameters: { consideration: [{ itemType: 4, token, identifierOrCriteria: "0", startAmount: "1", endAmount: "1", recipient: WALLET }], zone: ZERO, zoneHash: "0x" + "0".repeat(64) } }
  : { ok: true });

const signed = () => expect(h.signTypedData, "the flow went on to sign").toHaveBeenCalled();
const notSigned = () => expect(h.signTypedData, "nothing was signed after it").not.toHaveBeenCalled();

/**
 * `at` is the transaction whose wait() is faulted. A FINAL site ends on that
 * transaction and returns its hash. A step site sends more afterwards, so it is
 * judged on whether the flow `wentOn` or `stopped`.
 */
const SITES = [
  {
    name: "api.js fulfillSeaportOrder",
    at: "sendTransaction",
    final: true,
    reverted: { error: "failed", message: "Transaction reverted on-chain" },
    run: async () => (await import("./api")).fulfillSeaportOrder(
      { orderHash: "0xabc", protocolAddress: SEAPORT_16, contract: VENUE }, { buyerAddress: WALLET },
    ),
  },
  {
    name: "api-offers.js cancelOrder",
    at: "cancel",
    final: true,
    reverted: { error: "reverted", message: /reverted on-chain/i },
    run: async () => (await import("./api-offers")).cancelOrder(
      { protocol_address: SEAPORT_16, protocol_data: { parameters: listingParams(GOLD) } },
    ),
  },
  {
    name: "api-offers.js acceptOffer, the NFT approval",
    at: "setApprovalForAll",
    reverted: { error: "approval-failed", message: /approval.*reverted/i },
    setup: () => { h.openseaPost = vi.fn(async () => acceptFulfillment(VENUE)); },
    run: async () => (await import("./api-offers")).acceptOffer(
      { orderHash: "0xoffer", protocolAddress: SEAPORT_16, tokenContract: VENUE, tokenId: "7" },
    ),
    wentOn: () => expect(h.sent).toEqual(["setApprovalForAll", "sendTransaction"]),
    stopped: () => expect(h.sent, "the fill was not sent").toEqual(["setApprovalForAll"]),
  },
  {
    name: "api-offers.js acceptOffer, the fill",
    at: "sendTransaction",
    final: true,
    reverted: { error: "failed", message: "Transaction reverted on-chain" },
    setup: () => { h.approved = true; h.openseaPost = vi.fn(async () => acceptFulfillment(VENUE)); },
    run: async () => (await import("./api-offers")).acceptOffer(
      { orderHash: "0xoffer", protocolAddress: SEAPORT_16, tokenContract: VENUE, tokenId: "7" },
    ),
  },
  {
    name: "lib/orderbook.js fulfillNativeOrder",
    at: "fulfillOrder",
    final: true,
    reverted: { error: "reverted", message: "Transaction was mined but reverted on-chain" },
    run: async () => (await import("./lib/orderbook")).fulfillNativeOrder(nativeOrder(GOLD)),
  },
  {
    name: "lib/orderbook.js createNativeListing, the NFT approval",
    at: "setApprovalForAll",
    reverted: { error: "approval-failed", message: "NFT approval transaction reverted" },
    run: async () => (await import("./lib/orderbook")).createNativeListing({ contract: GOLD, tokenId: "1", priceEth: 0.1 }),
    wentOn: signed,
    stopped: notSigned,
  },
  {
    name: "lib/orderbook.js createNativeBundleListing, the NFT approval",
    at: "setApprovalForAll",
    reverted: { error: "approval-failed", message: "NFT approval transaction reverted" },
    run: async () => (await import("./lib/orderbook")).createNativeBundleListing({
      items: [{ contract: GOLD, tokenId: "1" }, { contract: GOLD, tokenId: "2" }], priceEth: 0.2,
    }),
    wentOn: signed,
    stopped: notSigned,
  },
  {
    name: "lib/trades.js createTradeOffer, the collection approval",
    at: "setApprovalForAll",
    reverted: { error: "approval-failed", message: "Collection approval reverted" },
    run: async () => (await import("./lib/trades")).createTradeOffer({
      give: [{ contract: GOLD, tokenId: "1" }], get: [{ contract: VENUE, tokenId: "2" }], taker: TAKER,
    }),
    wentOn: signed,
    stopped: notSigned,
  },
  {
    name: "lib/trades.js acceptTrade, the collection approval",
    at: "setApprovalForAll",
    reverted: { error: "approval-failed", message: "Collection approval reverted" },
    setup: () => { h.ownerOf = tradeOwners; },
    run: async () => (await import("./lib/trades")).acceptTrade(trade(wants(2, "2"))),
    wentOn: () => expect(h.sent).toEqual(["setApprovalForAll", "fulfillOrder"]),
    stopped: () => expect(h.sent, "the trade was not sent").toEqual(["setApprovalForAll"]),
  },
  {
    name: "lib/trades.js acceptTrade, the trade",
    at: "fulfillOrder",
    final: true,
    reverted: { error: "reverted", message: "Trade transaction reverted on-chain" },
    setup: () => { h.approved = true; h.ownerOf = tradeOwners; },
    run: async () => (await import("./lib/trades")).acceptTrade(trade(wants(2, "2"))),
  },
  {
    name: "lib/trades.js acceptOpenTrade, the collection approval",
    at: "setApprovalForAll",
    reverted: { error: "approval-failed", message: "Collection approval reverted" },
    setup: () => { h.ownerOf = tradeOwners; },
    run: async () => (await import("./lib/trades")).acceptOpenTrade(trade(wants(4, "0")), { 0: "5" }),
    wentOn: () => expect(h.sent).toEqual(["setApprovalForAll", "fulfillAdvancedOrder"]),
    stopped: () => expect(h.sent, "the trade was not sent").toEqual(["setApprovalForAll"]),
  },
  {
    name: "lib/trades.js acceptOpenTrade, the trade",
    at: "fulfillAdvancedOrder",
    final: true,
    reverted: { error: "reverted", message: "Trade transaction reverted on-chain" },
    setup: () => { h.approved = true; h.ownerOf = tradeOwners; },
    run: async () => (await import("./lib/trades")).acceptOpenTrade(trade(wants(4, "0")), { 0: "5" }),
  },
  {
    name: "lib/trades.js cancelTradeOnChain",
    at: "cancel",
    final: true,
    reverted: { error: "reverted", message: "On-chain cancel reverted" },
    run: async () => (await import("./lib/trades")).cancelTradeOnChain(trade(wants(2, "2"), WALLET)),
  },
  // lib/weth.js throws, so each of its callers is a site of its own.
  ...[
    ["createItemOffer", "wrap-failed", "approve-failed", () => {}, async () => (await import("./api-offers")).createItemOffer({ tokenId: "1", priceEth: 0.01, contract: GOLD })],
    ["createCollectionOffer", "failed", "failed", () => { h.openseaPost = vi.fn(async (path) => criteriaBuild(GOLD)(path)); },
      async () => (await import("./api-offers")).createCollectionOffer({ priceEth: 0.01, slug: "junglebaygoldcards", openseaSlug: "junglebaygoldcards" })],
    ["createTraitOffer", "failed", "failed", () => { h.openseaPost = vi.fn(async (path) => criteriaBuild(VENUE)(path)); },
      async () => (await import("./api-offers")).createTraitOffer({ traitType: "a", traitValue: "b", priceEth: 0.01, slug: "gnssart", openseaSlug: "gnssart" })],
    ["createTradeOffer", "wrap-failed", "approve-failed", () => { h.approved = true; },
      async () => (await import("./lib/trades")).createTradeOffer({
        give: [{ contract: GOLD, tokenId: "1" }], get: [{ contract: VENUE, tokenId: "2" }], taker: TAKER, wethTopupEth: "0.01",
      })],
  ].flatMap(([caller, wrapCode, approveCode, setup, run]) => [
    {
      name: `lib/weth.js wrapEth, called by ${caller}`,
      at: "deposit",
      reverted: { error: wrapCode, message: /reverted on-chain/i },
      setup,
      run,
      wentOn: () => expect(h.sent.slice(0, 2)).toEqual(["deposit", "approve"]),
      stopped: () => { expect(h.sent, "nothing was sent after the wrap").toEqual(["deposit"]); notSigned(); },
    },
    {
      name: `lib/weth.js approveWeth, called by ${caller}`,
      at: "approve",
      reverted: { error: approveCode, message: /reverted on-chain/i },
      setup: () => { setup(); h.wethBalance = 10n ** 19n; },
      run,
      wentOn: signed,
      stopped: () => { expect(h.sent, "nothing was sent after the approval").toEqual(["approve"]); notSigned(); },
    },
  ]),
];

async function runSite(site, how) {
  site.setup?.();
  h.fault = how ? { at: site.at, wait: WAITS[how] } : null;
  const res = await site.run();
  expect(h.sent, `${site.name} never sent its ${site.at}`).toContain(site.at);
  return res;
}

function expectReverted(site, res) {
  expect(res.success).toBeUndefined();
  expect(res.error).toBe(site.reverted.error);
  if (site.reverted.message instanceof RegExp) expect(res.message).toMatch(site.reverted.message);
  else expect(res.message).toContain(site.reverted.message);
  if (!site.final) site.stopped();
}

describe.each(SITES)("$name", (site) => {
  it("control: a transaction that mines is waited for, and the flow completes", async () => {
    const res = await runSite(site, null);
    if (site.final) expect(res).toMatchObject({ success: true, hash: SENT });
    else site.wentOn();
  });

  it("a revert gets the site's own reverted answer", async () => {
    expectReverted(site, await runSite(site, "revert"));
  });

  it("an unread receipt is unconfirmed: we can't tell, and it is never called failed", async () => {
    const res = await runSite(site, "unread");
    expect(res.success).toBeUndefined();
    expect(res.error).toBe("unconfirmed");
    expect(res.hash).toBe(SENT);
    expect(res.message).toMatch(/couldn't confirm/i);
    expect(res.message).toMatch(/before you send it again/i);
    expect(res.message).not.toMatch(/fail/i);
    expect(res.message).not.toMatch(/—/);
    if (!site.final) site.stopped();
  });

  it.each([["a wallet cancel", "cancel", "cancelled"], ["a different call at that nonce", "otherCall", "replaced"]])(
    "%s did not happen",
    async (_label, how, reason) => {
      const res = await runSite(site, how);
      expect(res.success).toBeUndefined();
      expect(res).toMatchObject({ error: "replaced", reason, hash: TOOK, sentHash: SENT });
      expect(res.message).toMatch(/did not happen/i);
      expect(res.message).not.toMatch(/fail/i);
      if (!site.final) site.stopped();
    },
  );

  it("a speed-up counts, under the hash that mined", async () => {
    const res = await runSite(site, "speedUp");
    if (site.final) expect(res).toMatchObject({ success: true, hash: TOOK });
    else site.wentOn();
  });

  it("a speed-up that reverted is a revert", async () => {
    expectReverted(site, await runSite(site, "speedUpReverted"));
  });
});

describe("a fill is recorded under the hash that mined", () => {
  // The backend row and the signed notify name a transaction. After a speed-up
  // the one that was sent never mined, so naming it points at nothing.
  const notified = () => fetchSpy.mock.calls
    .map(([, init]) => (init?.body ? JSON.parse(init.body) : null))
    .find((body) => body?.action === "fill" || body?.action === "trade-fill");

  it.each([
    ["fulfillNativeOrder", "fulfillOrder", () => {}, async () => (await import("./lib/orderbook")).fulfillNativeOrder(nativeOrder(GOLD))],
    ["acceptTrade", "fulfillOrder", () => { h.approved = true; h.ownerOf = tradeOwners; }, async () => (await import("./lib/trades")).acceptTrade(trade(wants(2, "2")))],
    ["acceptOpenTrade", "fulfillAdvancedOrder", () => { h.approved = true; h.ownerOf = tradeOwners; }, async () => (await import("./lib/trades")).acceptOpenTrade(trade(wants(4, "0")), { 0: "5" })],
  ])("%s", async (_name, at, setup, run) => {
    setup();
    h.fault = { at, wait: WAITS.speedUp };
    const res = await run();
    expect(res.success).toBe(true);
    expect(notified()?.txHash).toBe(TOOK);
    expect(String(h.signMessage.mock.calls.at(-1)[0])).toContain(TOOK);
  });
});
