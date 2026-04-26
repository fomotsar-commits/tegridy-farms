// AUDIT R053 integration tests: orderbook signature recovery, on-chain
// ownership, and price-overflow rejection.
//
// We mock supabase + viem.recoverMessageAddress + the seaport-verify helpers
// so the handler runs end-to-end inside vitest. Real RPC isn't available
// here; the helpers are tested separately in seaport-verify.test.js.

import { describe, it, expect, beforeEach, vi } from "vitest";

const OFFERER = "0x" + "a".repeat(40);
const NAKAMIGOS = "0xd774557b647330c91bf44cfeab205095f7e6c367";

// ── Module mocks ──
// Set NODE_ENV early so seaport-verify's "fail-open in dev" path doesn't
// kick in before we override its mock.
process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
process.env.ALLOWED_ORIGIN = "https://test.invalid";

const recoverMock = vi.fn(async () => OFFERER);
const sigCheckMock = vi.fn(async () => ({ ok: true }));
const ownerCheckMock = vi.fn(async () => ({ ok: true }));

vi.mock("viem", () => ({
  recoverMessageAddress: recoverMock,
  // verifyTypedData is reached via seaport-verify which we stub below; this
  // re-export keeps the import in seaport-verify happy if the module is
  // loaded by accident.
  verifyTypedData: vi.fn(async () => true),
}));

vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
}));

vi.mock("../_lib/seaport-verify.js", () => ({
  verifySeaportSignature: sigCheckMock,
  verifyNftOwnership: ownerCheckMock,
  MAX_PRICE_WEI: 10n ** 24n,
  priceWeiToEthNumber: (wei, decimals) => {
    const divisor = 10n ** BigInt(decimals);
    return Number((wei * 100000000n) / divisor) / 100000000;
  },
}));

// Supabase client stub. Every chain call returns `this` so the .then()
// terminator returns a configurable result. We track the inserted row.
const insertedRows = [];
const supabaseFromMock = vi.fn(() => {
  let lastOp = null;
  const chain = {
    select: vi.fn(() => chain),
    insert: vi.fn((row) => { lastOp = "insert"; insertedRows.push(row); return Promise.resolve({ error: null }); }),
    update: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    gte: vi.fn(() => chain),
    gt: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    single: vi.fn(() => Promise.resolve({ data: null, error: null })),
    // makes `await chain` resolve like a query result
    then: function (resolve) {
      // count queries (existingListings, makerOrderCount) → return empty
      if (lastOp === "insert") return resolve({ error: null });
      return resolve({ data: [], count: 0, error: null });
    },
  };
  return chain;
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: supabaseFromMock })),
}));

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
    status: (code) => { statusSpy(code); return res; },
    json: (payload) => { jsonSpy(payload); return res; },
    setHeader: vi.fn(),
    end: vi.fn(),
  };
  return { req, res, statusSpy, jsonSpy };
}

function buildOrder({ priceWei = "1000000000000000000", offerer = OFFERER } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const seaportSig = "0x" + "1".repeat(130);
  const authSig = "0x" + "2".repeat(130);
  return {
    parameters: {
      offerer,
      zone: "0x0000000000000000000000000000000000000000",
      offer: [{
        itemType: 2, // ERC721
        token: NAKAMIGOS,
        identifierOrCriteria: "42",
        startAmount: "1",
        endAmount: "1",
      }],
      consideration: [{
        itemType: 0,
        token: "0x0000000000000000000000000000000000000000",
        identifierOrCriteria: "0",
        startAmount: priceWei,
        endAmount: priceWei,
        recipient: offerer,
      }],
      orderType: 2,
      startTime: String(now),
      endTime: String(now + 86400),
      zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      salt: "1",
      conduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
      totalOriginalConsiderationItems: 1,
    },
    signature: authSig,
    seaportSignature: seaportSig,
    protocol_address: "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC",
  };
}

describe("orderbook R053 — signature + ownership + price overflow", () => {
  let handler;

  beforeEach(async () => {
    insertedRows.length = 0;
    recoverMock.mockReset();
    recoverMock.mockResolvedValue(OFFERER);
    sigCheckMock.mockReset();
    sigCheckMock.mockResolvedValue({ ok: true });
    ownerCheckMock.mockReset();
    ownerCheckMock.mockResolvedValue({ ok: true });
    vi.resetModules();
    handler = (await import("../orderbook.js")).default;
  });

  it("happy path: valid order with matching sig + ownership creates row", async () => {
    const order = buildOrder();
    const { req, res, statusSpy, jsonSpy } = makeReqRes({ action: "create", order });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(201);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(sigCheckMock).toHaveBeenCalledTimes(1);
    expect(ownerCheckMock).toHaveBeenCalledTimes(1);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].price_eth).toBe(1);
  });

  // ── H-2 part 1: Seaport signature mismatch ──
  it("rejects 403 when Seaport signature does not match offerer", async () => {
    sigCheckMock.mockResolvedValue({ ok: false, error: "signature-mismatch" });
    const order = buildOrder();
    const { req, res, statusSpy, jsonSpy } = makeReqRes({ action: "create", order });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringMatching(/Seaport signature/),
    }));
    expect(insertedRows).toHaveLength(0);
  });

  // ── H-2 part 2: NFT ownership mismatch ──
  it("rejects 403 when offerer does not own the NFT", async () => {
    ownerCheckMock.mockResolvedValue({ ok: false, error: "not-owner" });
    const order = buildOrder();
    const { req, res, statusSpy, jsonSpy } = makeReqRes({ action: "create", order });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringMatching(/does not own/i),
    }));
    expect(insertedRows).toHaveLength(0);
  });

  it("returns 503 when RPC unavailable in production", async () => {
    sigCheckMock.mockResolvedValue({ ok: false, error: "rpc-unavailable" });
    const order = buildOrder();
    const { req, res, statusSpy } = makeReqRes({ action: "create", order });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(503);
    expect(insertedRows).toHaveLength(0);
  });

  it("returns 400 when token does not exist on-chain", async () => {
    ownerCheckMock.mockResolvedValue({ ok: false, error: "token-not-found" });
    const order = buildOrder();
    const { req, res, statusSpy } = makeReqRes({ action: "create", order });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(insertedRows).toHaveLength(0);
  });

  // ── H-3: price overflow ──
  it("rejects 400 when single startAmount exceeds MAX_PRICE_WEI", async () => {
    // 10**25 wei = 10M ETH — past the 1M cap
    const order = buildOrder({ priceWei: (10n ** 25n).toString() });
    const { req, res, statusSpy, jsonSpy } = makeReqRes({ action: "create", order });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringMatching(/out of range/i),
    }));
    expect(insertedRows).toHaveLength(0);
    // Signature verification must NOT be reached for overflow rejection.
    expect(sigCheckMock).not.toHaveBeenCalled();
  });

  it("rejects 400 when summed consideration overflows MAX_PRICE_WEI", async () => {
    // Single under the cap but sum over: 6 items at 2*10**23 each = 12*10**23 > 10**24
    const order = buildOrder();
    const big = (2n * 10n ** 23n).toString();
    order.parameters.consideration = Array.from({ length: 6 }, () => ({
      itemType: 0,
      token: "0x0000000000000000000000000000000000000000",
      identifierOrCriteria: "0",
      startAmount: big,
      endAmount: big,
      recipient: OFFERER,
    }));
    const { req, res, statusSpy } = makeReqRes({ action: "create", order });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(insertedRows).toHaveLength(0);
  });

  it("rejects 400 when startAmount is negative", async () => {
    const order = buildOrder({ priceWei: "-1" });
    const { req, res, statusSpy } = makeReqRes({ action: "create", order });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(insertedRows).toHaveLength(0);
  });

  it("rejects 400 when startAmount is non-numeric garbage", async () => {
    const order = buildOrder();
    order.parameters.consideration[0].startAmount = "0x_not_a_number";
    const { req, res, statusSpy } = makeReqRes({ action: "create", order });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(insertedRows).toHaveLength(0);
  });

  it("happy path on USDC offer (different decimals) — price scales to 6 dp", async () => {
    const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    // ERC20 offer (USDC) for an NFT (consideration)
    const order = buildOrder();
    // Convert to an OFFER type instead of listing
    order.parameters.offer = [{
      itemType: 1, // ERC20
      token: USDC,
      identifierOrCriteria: "0",
      startAmount: "1000000000", // 1000 USDC at 6 decimals
      endAmount: "1000000000",
    }];
    order.parameters.consideration = [{
      itemType: 2, // ERC721 in the consideration for offers
      token: NAKAMIGOS,
      identifierOrCriteria: "42",
      startAmount: "1",
      endAmount: "1",
      recipient: OFFERER,
    }];
    const { req, res, statusSpy } = makeReqRes({ action: "create", order });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(201);
    // For OFFERS we don't run ownership (offerer offers ERC20, doesn't own NFT)
    expect(ownerCheckMock).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].order_type).toBe("offer");
    // 1000 USDC ÷ 10^6 = 1000.00000000
    expect(insertedRows[0].price_eth).toBe(1000);
  });
});
