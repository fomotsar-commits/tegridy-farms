// AUDIT F10: regression tests for the orderbook fill verification rewrite.
//
// Background
// ──────────
// Pre-fix the fill handler did:
//   topics[1].toLowerCase() === orderHash.toLowerCase()
// where:
//   - topics[1] is Seaport's indexed offerer (a zero-padded address)
//   - orderHash is the application's sha256(JSON(params)) PRIMARY KEY
// The two are different types and could never match. Every legitimate
// fill returned 400 "Transaction does not contain a matching Seaport
// OrderFulfilled event" and the row stayed `active` until end_time.
//
// Fix
// ────
// 1. Store Seaport's canonical struct-hash of OrderComponents in a
//    new `seaport_order_hash` column at create-time.
// 2. In the fill handler, ABI-decode the OrderFulfilled `data` field —
//    the first 32 bytes are the canonical orderHash — and compare to
//    the stored value.
// 3. For pre-migration rows where `seaport_order_hash` is NULL, REJECT the
//    fill outright. (An earlier revision fell back to a presence-only check —
//    Seaport-allowlisted address + matching offerer in topic[1] — but that let
//    anyone replay a maker's past Seaport sale to mark an unrelated active
//    legacy listing as filled. The fallback was removed; NULL-hash rows expire
//    on their own 7-day TTL.)
//
// These tests cover:
//   - canonical hash helper produces a value matching viem hashStruct
//   - canonical helper rejects malformed input
//   - server re-derives client's claimed seaportOrderHash and rejects mismatch
//   - successful fill: ABI-decoded orderHash equals stored seaport_order_hash
//   - rejected fill: legitimate Seaport log but DIFFERENT orderHash in data
//   - rejected fill: same orderHash from a non-Seaport contract (forgery)
//   - NULL seaport_order_hash is rejected even with a matching-offerer Seaport
//     log (the old maker-spoof acceptance path)
//   - NULL seaport_order_hash is rejected for a non-Seaport log address

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  encodeAbiParameters,
  parseAbiParameters,
  pad,
  keccak256,
  toBytes,
} from "viem";
import { computeSeaportOrderHash, isValidSeaportOrderHash } from "../_lib/seaportHash.js";

// ── Constants ──
const NAKAMIGOS = "0xd774557b647330c91bf44cfeab205095f7e6c367";
const OFFERER = "0x" + "a".repeat(40);
const ATTACKER = "0x" + "b".repeat(40);
const ORDER_FULFILLED_TOPIC = "0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31";
const SEAPORT_15 = "0x00000000000000adc04c56bf30ac9d3c0aaf14dc";
const MALICIOUS_CONTRACT = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

// ── Helpers ──

function buildSampleParams({ offerer = OFFERER } = {}) {
  return {
    offerer,
    zone: "0x0000000000000000000000000000000000000000",
    offer: [{
      itemType: 2,
      token: NAKAMIGOS,
      identifierOrCriteria: "42",
      startAmount: "1",
      endAmount: "1",
    }],
    consideration: [{
      itemType: 0,
      token: "0x0000000000000000000000000000000000000000",
      identifierOrCriteria: "0",
      startAmount: "1000000000000000000",
      endAmount: "1000000000000000000",
      recipient: offerer,
    }],
    orderType: 2,
    startTime: "0",
    endTime: "99999999999",
    zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    salt: "0",
    conduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
  };
}

function encodeOrderFulfilledData(orderHash) {
  // OrderFulfilled non-indexed args: bytes32 orderHash, address recipient,
  // SpentItem[] offer, ReceivedItem[] consideration.
  const recipient = "0x2222222222222222222222222222222222222222";
  const offer = [[2, NAKAMIGOS, 42n, 1n]];
  const consideration = [
    [0, "0x0000000000000000000000000000000000000000", 0n, 1000000000000000000n, OFFERER],
  ];
  return encodeAbiParameters(
    parseAbiParameters(
      "bytes32, address, (uint8,address,uint256,uint256)[], (uint8,address,uint256,uint256,address)[]"
    ),
    [orderHash, recipient, offer, consideration],
  );
}

function offererTopic(addr) {
  // 32-byte left-padded address topic
  return pad(addr, { size: 32 }).toLowerCase();
}

// ── Helper-only tests ──

describe("seaportHash helper", () => {
  it("produces the canonical Seaport struct-hash for a known fixture", () => {
    // Same fixture used during ground-truth verification against viem's hashStruct
    // and ethers.TypedDataEncoder.from(types).hash(...) — both produce this value.
    const params = {
      offerer: "0x1111111111111111111111111111111111111111",
      zone: "0x0000000000000000000000000000000000000000",
      offer: [{ itemType: 2, token: NAKAMIGOS, identifierOrCriteria: "42", startAmount: "1", endAmount: "1" }],
      consideration: [
        { itemType: 0, token: "0x0000000000000000000000000000000000000000", identifierOrCriteria: "0", startAmount: "990000000000000000", endAmount: "990000000000000000", recipient: "0x1111111111111111111111111111111111111111" },
        { itemType: 0, token: "0x0000000000000000000000000000000000000000", identifierOrCriteria: "0", startAmount: "10000000000000000", endAmount: "10000000000000000", recipient: "0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e" },
      ],
      orderType: 2,
      startTime: "0",
      endTime: "99999999999",
      zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      salt: "0",
      conduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
    };
    const hash = computeSeaportOrderHash(params, 0n);
    expect(hash).toBe("0x45752cd0df746ac5999d62a2eb8e6b022c2c7d73268230b902fe4e43bd672974");
  });

  it("returns lowercase 0x-prefixed 66-char hex string", () => {
    const hash = computeSeaportOrderHash(buildSampleParams(), 0n);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("changes when counter changes (counter is part of typed-data)", () => {
    const params = buildSampleParams();
    const a = computeSeaportOrderHash(params, 0n);
    const b = computeSeaportOrderHash(params, 1n);
    expect(a).not.toBe(b);
  });

  it("changes when any single field changes (deterministic + sensitive)", () => {
    const a = computeSeaportOrderHash(buildSampleParams(), 0n);
    const tamperedParams = buildSampleParams();
    tamperedParams.offer[0].identifierOrCriteria = "43";
    const b = computeSeaportOrderHash(tamperedParams, 0n);
    expect(a).not.toBe(b);
  });

  it("throws on missing parameters", () => {
    expect(() => computeSeaportOrderHash(null, 0n)).toThrow();
    expect(() => computeSeaportOrderHash(undefined, 0n)).toThrow();
  });

  it("throws on missing counter", () => {
    expect(() => computeSeaportOrderHash(buildSampleParams())).toThrow();
    expect(() => computeSeaportOrderHash(buildSampleParams(), null)).toThrow();
  });

  it("isValidSeaportOrderHash accepts canonical 0x-prefixed lowercase hex", () => {
    expect(isValidSeaportOrderHash("0x" + "a".repeat(64))).toBe(true);
    expect(isValidSeaportOrderHash("0x" + "0".repeat(64))).toBe(true);
  });

  it("isValidSeaportOrderHash rejects uppercase, missing prefix, wrong length", () => {
    expect(isValidSeaportOrderHash("0x" + "A".repeat(64))).toBe(false);
    expect(isValidSeaportOrderHash("a".repeat(64))).toBe(false);
    expect(isValidSeaportOrderHash("0x" + "a".repeat(63))).toBe(false);
    expect(isValidSeaportOrderHash("0x" + "a".repeat(65))).toBe(false);
    expect(isValidSeaportOrderHash(null)).toBe(false);
    expect(isValidSeaportOrderHash(123)).toBe(false);
  });

  it("OrderFulfilled topic0 matches the value pinned in orderbook.js", () => {
    // Sanity check that our regression suite is using the correct topic.
    const sig = "OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])";
    expect(keccak256(toBytes(sig))).toBe(ORDER_FULFILLED_TOPIC);
  });
});

// ── Handler integration tests ──

// vi.mock factories are hoisted ABOVE local `const`s, so any reference to
// a module-level variable inside the factory throws "Cannot access X before
// initialization". Use vi.hoisted() to declare the mocks before the
// factories that close over them. Same pattern Vitest's docs recommend.
const mocks = vi.hoisted(() => ({
  recoverMock: vi.fn(),
  fetchMock: vi.fn(),
  supabaseState: {
    storedRow: null,           // { seaport_order_hash, maker, status }
    updateResult: { data: [{}], error: null },
    mockUpdates: [],
  },
}));

// Mock viem: keep ABI-decoding real (the handler uses it), stub
// recoverMessageAddress so we can pretend the buyer signed.
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    recoverMessageAddress: mocks.recoverMock,
  };
});

vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
}));

// Stub Seaport signature/ownership helpers so create-path doesn't need RPC.
vi.mock("../_lib/seaport-verify.js", () => ({
  verifySeaportSignature: vi.fn(async () => ({ ok: true })),
  verifyNftOwnership: vi.fn(async () => ({ ok: true })),
  MAX_PRICE_WEI: 10n ** 24n,
  priceWeiToEthNumber: (wei, decimals) => {
    const divisor = 10n ** BigInt(decimals);
    return Number((wei * 100000000n) / divisor) / 100000000;
  },
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => {
      let lastOp = null;
      let lastUpdatePayload = null;
      const chain = {
        select: vi.fn(() => chain),
        insert: vi.fn(() => Promise.resolve({ error: null })),
        update: vi.fn((payload) => { lastOp = "update"; lastUpdatePayload = payload; return chain; }),
        eq: vi.fn(() => chain),
        gte: vi.fn(() => chain),
        gt: vi.fn(() => chain),
        order: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        single: vi.fn(() => Promise.resolve({ data: mocks.supabaseState.storedRow, error: null })),
        maybeSingle: vi.fn(() => Promise.resolve({ data: mocks.supabaseState.storedRow, error: null })),
        then: function (resolve) {
          if (lastOp === "update") {
            mocks.supabaseState.mockUpdates.push(lastUpdatePayload);
            return resolve(mocks.supabaseState.updateResult);
          }
          // Default: SELECT count for tx_hash duplicate check returns 0.
          return resolve({ data: [], count: 0, error: null });
        },
      };
      return chain;
    }),
  })),
}));

// Mock global fetch for Alchemy RPC.
global.fetch = mocks.fetchMock;

function makeReqRes(body) {
  const req = {
    method: "POST",
    headers: { origin: "https://test.invalid" },
    body,
    query: {},
  };
  const statusSpy = vi.fn();
  const jsonSpy = vi.fn();
  const res = {
    status: (c) => { statusSpy(c); return res; },
    json: (p) => { jsonSpy(p); return res; },
    setHeader: vi.fn(),
    end: vi.fn(),
  };
  return { req, res, statusSpy, jsonSpy };
}

function buildFillBody({ orderHash = "0x" + "1".repeat(64), txHash = "0x" + "2".repeat(64) } = {}) {
  return {
    action: "fill",
    orderHash,
    txHash,
    signature: "0x" + "3".repeat(130),
    chainId: 1,
    timestamp: Math.floor(Date.now() / 1000),
  };
}

function makeReceipt({ logs }) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      status: "0x1",
      logs,
    },
  };
}

describe("orderbook fill — F10 strict-hash path", () => {
  let handler;

  beforeEach(async () => {
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "service-role";
    process.env.NODE_ENV = "production"; // exercise prod path with Alchemy
    process.env.ALCHEMY_API_KEY = "test-key"; // non-"demo" so hasAlchemy=true
    process.env.ALLOWED_ORIGIN = "https://test.invalid";
    mocks.supabaseState.storedRow = null;
    mocks.supabaseState.updateResult = { data: [{ status: "filled" }], error: null };
    mocks.supabaseState.mockUpdates = [];
    mocks.recoverMock.mockReset();
    mocks.recoverMock.mockResolvedValue(OFFERER);
    mocks.fetchMock.mockReset();
    vi.resetModules();
    handler = (await import("../orderbook.js")).default;
  });

  it("accepts a fill where OrderFulfilled.data orderHash matches stored seaport_order_hash", async () => {
    const seaportHash = computeSeaportOrderHash(buildSampleParams(), 0n);
    mocks.supabaseState.storedRow = { seaport_order_hash: seaportHash, maker: OFFERER, status: "active" };

    mocks.fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => makeReceipt({
        logs: [{
          address: SEAPORT_15,
          topics: [ORDER_FULFILLED_TOPIC, offererTopic(OFFERER), offererTopic("0x" + "0".repeat(40))],
          data: encodeOrderFulfilledData(seaportHash),
        }],
      }),
    });

    const { req, res, statusSpy, jsonSpy } = makeReqRes(buildFillBody());
    await handler(req, res);
    // Handler returns 200 implicitly via res.json without calling res.status —
    // assert no error status was set and the success payload was returned.
    expect(jsonSpy).toHaveBeenCalledWith({ success: true });
    // None of the error paths' explicit status codes were triggered
    expect(statusSpy).not.toHaveBeenCalledWith(400);
    expect(statusSpy).not.toHaveBeenCalledWith(403);
    expect(statusSpy).not.toHaveBeenCalledWith(503);
  });

  it("rejects 400 when log present but data orderHash differs from stored", async () => {
    const stored = computeSeaportOrderHash(buildSampleParams(), 0n);
    const onChain = computeSeaportOrderHash(buildSampleParams({ offerer: ATTACKER }), 0n);
    mocks.supabaseState.storedRow = { seaport_order_hash: stored, maker: OFFERER, status: "active" };

    mocks.fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => makeReceipt({
        logs: [{
          address: SEAPORT_15,
          topics: [ORDER_FULFILLED_TOPIC, offererTopic(OFFERER), offererTopic("0x" + "0".repeat(40))],
          data: encodeOrderFulfilledData(onChain),
        }],
      }),
    });

    const { req, res, statusSpy, jsonSpy } = makeReqRes(buildFillBody());
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringMatching(/OrderFulfilled/i),
    }));
  });

  it("rejects 400 when matching log was emitted from a non-Seaport contract (forgery)", async () => {
    const seaportHash = computeSeaportOrderHash(buildSampleParams(), 0n);
    mocks.supabaseState.storedRow = { seaport_order_hash: seaportHash, maker: OFFERER, status: "active" };

    mocks.fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => makeReceipt({
        logs: [{
          address: MALICIOUS_CONTRACT,
          topics: [ORDER_FULFILLED_TOPIC, offererTopic(OFFERER), offererTopic("0x" + "0".repeat(40))],
          data: encodeOrderFulfilledData(seaportHash),
        }],
      }),
    });

    const { req, res, statusSpy } = makeReqRes(buildFillBody());
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
  });

  it("rejects 400 when receipt has no Seaport OrderFulfilled log at all", async () => {
    const seaportHash = computeSeaportOrderHash(buildSampleParams(), 0n);
    mocks.supabaseState.storedRow = { seaport_order_hash: seaportHash, maker: OFFERER, status: "active" };

    mocks.fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => makeReceipt({
        logs: [{
          address: SEAPORT_15,
          topics: ["0x" + "f".repeat(64)], // unrelated event
          data: "0x",
        }],
      }),
    });

    const { req, res, statusSpy } = makeReqRes(buildFillBody());
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
  });

  it("rejects 503 when Alchemy RPC is unreachable in production", async () => {
    const seaportHash = computeSeaportOrderHash(buildSampleParams(), 0n);
    mocks.supabaseState.storedRow = { seaport_order_hash: seaportHash, maker: OFFERER, status: "active" };

    mocks.fetchMock.mockRejectedValueOnce(new Error("network down"));

    const { req, res, statusSpy } = makeReqRes(buildFillBody());
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(503);
  });

  it("rejects 400 when transaction reverted on-chain", async () => {
    const seaportHash = computeSeaportOrderHash(buildSampleParams(), 0n);
    mocks.supabaseState.storedRow = { seaport_order_hash: seaportHash, maker: OFFERER, status: "active" };

    mocks.fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: { status: "0x0", logs: [] } }),
    });

    const { req, res, statusSpy } = makeReqRes(buildFillBody());
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
  });
});

describe("orderbook fill — F10 NULL seaport_order_hash is rejected (legacy fallback REMOVED)", () => {
  let handler;

  beforeEach(async () => {
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "service-role";
    process.env.NODE_ENV = "production";
    process.env.ALCHEMY_API_KEY = "test-key";
    process.env.ALLOWED_ORIGIN = "https://test.invalid";
    mocks.supabaseState.storedRow = null;
    mocks.supabaseState.updateResult = { data: [{ status: "filled" }], error: null };
    mocks.supabaseState.mockUpdates = [];
    mocks.recoverMock.mockReset();
    mocks.recoverMock.mockResolvedValue(OFFERER);
    mocks.fetchMock.mockReset();
    vi.resetModules();
    handler = (await import("../orderbook.js")).default;
  });

  // AUDIT FIX (2026-05-25): the old "legacy fallback" accepted a NULL-hash fill
  // whenever topic[1] (the indexed offerer) matched the recorded maker. That let
  // anyone who observed ANY past Seaport sale by `maker` replay that tx hash to
  // mark an unrelated active legacy listing as filled (maker-spoof). The fallback
  // was removed: every NULL-hash row is now rejected outright. This test asserts
  // the secure behavior — what used to be the maker-spoof acceptance path.
  it("rejects a fill when seaport_order_hash is NULL even if topic[1] offerer matches a real Seaport log", async () => {
    mocks.supabaseState.storedRow = { seaport_order_hash: null, maker: OFFERER, status: "active" };

    mocks.fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => makeReceipt({
        logs: [{
          address: SEAPORT_15,
          topics: [ORDER_FULFILLED_TOPIC, offererTopic(OFFERER), offererTopic("0x" + "0".repeat(40))],
          data: encodeOrderFulfilledData("0x" + "5".repeat(64)),
        }],
      }),
    });

    const { req, res, statusSpy, jsonSpy } = makeReqRes(buildFillBody());
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringMatching(/Legacy listing without canonical order hash/i),
    }));
  });

  it("rejects NULL-hash fill when topic[1] offerer does not match recorded maker", async () => {
    mocks.supabaseState.storedRow = { seaport_order_hash: null, maker: OFFERER, status: "active" };

    mocks.fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => makeReceipt({
        logs: [{
          address: SEAPORT_15,
          topics: [ORDER_FULFILLED_TOPIC, offererTopic(ATTACKER), offererTopic("0x" + "0".repeat(40))],
          data: encodeOrderFulfilledData("0x" + "5".repeat(64)),
        }],
      }),
    });

    const { req, res, statusSpy } = makeReqRes(buildFillBody());
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
  });

  it("rejects NULL-hash fill when log emitted from non-Seaport address", async () => {
    mocks.supabaseState.storedRow = { seaport_order_hash: null, maker: OFFERER, status: "active" };

    mocks.fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => makeReceipt({
        logs: [{
          address: MALICIOUS_CONTRACT,
          topics: [ORDER_FULFILLED_TOPIC, offererTopic(OFFERER), offererTopic("0x" + "0".repeat(40))],
          data: encodeOrderFulfilledData("0x" + "5".repeat(64)),
        }],
      }),
    });

    const { req, res, statusSpy } = makeReqRes(buildFillBody());
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
  });
});

describe("orderbook create — F10 seaportOrderHash claim verification", () => {
  let handler;

  beforeEach(async () => {
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "service-role";
    process.env.NODE_ENV = "production";
    process.env.ALCHEMY_API_KEY = "test-key";
    process.env.ALLOWED_ORIGIN = "https://test.invalid";
    mocks.supabaseState.storedRow = null;
    mocks.supabaseState.updateResult = { data: [{}], error: null };
    mocks.supabaseState.mockUpdates = [];
    mocks.recoverMock.mockReset();
    mocks.recoverMock.mockResolvedValue(OFFERER);
    mocks.fetchMock.mockReset();
    vi.resetModules();
    handler = (await import("../orderbook.js")).default;
  });

  function buildCreateBody({ offerer = OFFERER, seaportOrderHash, seaportCounter = "0" } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const params = {
      offerer,
      zone: "0x0000000000000000000000000000000000000000",
      offer: [{ itemType: 2, token: NAKAMIGOS, identifierOrCriteria: "42", startAmount: "1", endAmount: "1" }],
      consideration: [{
        itemType: 0,
        token: "0x0000000000000000000000000000000000000000",
        identifierOrCriteria: "0",
        startAmount: "1000000000000000000",
        endAmount: "1000000000000000000",
        recipient: offerer,
      }],
      orderType: 2,
      startTime: String(now),
      endTime: String(now + 86400),
      zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      salt: "0",
      conduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
      totalOriginalConsiderationItems: 1,
    };
    return {
      action: "create",
      order: {
        parameters: params,
        signature: "0x" + "1".repeat(130),
        seaportSignature: "0x" + "2".repeat(130),
        protocol_address: "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC",
        seaportOrderHash,
        seaportCounter,
      },
    };
  }

  it("rejects 400 when seaportOrderHash format is invalid (uppercase)", async () => {
    const body = buildCreateBody({
      seaportOrderHash: "0xABCDEF" + "0".repeat(58),
      seaportCounter: "0",
    });
    const { req, res, statusSpy, jsonSpy } = makeReqRes(body);
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringMatching(/Invalid seaportOrderHash/i),
    }));
  });

  it("rejects 400 when seaportCounter missing while seaportOrderHash present", async () => {
    const body = buildCreateBody({
      seaportOrderHash: "0x" + "a".repeat(64),
    });
    // The builder defaults seaportCounter to "0"; remove to simulate missing.
    delete body.order.seaportCounter;
    const { req, res, statusSpy, jsonSpy } = makeReqRes(body);
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringMatching(/seaportCounter/i),
    }));
  });

  it("rejects 400 when client-claimed hash does not match server-derived hash", async () => {
    const body = buildCreateBody({
      seaportOrderHash: "0x" + "a".repeat(64), // doesn't match real derivation
      seaportCounter: "0",
    });
    const { req, res, statusSpy, jsonSpy } = makeReqRes(body);
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringMatching(/seaportOrderHash mismatch/i),
    }));
  });

  it("accepts when client-claimed hash matches server-derived hash (canonical Seaport hash flow)", async () => {
    const body = buildCreateBody({ seaportCounter: "0" });
    // Compute the canonical hash with the same params + counter the handler will use.
    body.order.seaportOrderHash = computeSeaportOrderHash(body.order.parameters, 0n);
    const { req, res, statusSpy, jsonSpy } = makeReqRes(body);
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(201);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});
