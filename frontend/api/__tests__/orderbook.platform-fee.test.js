// The 0.5% venue fee on a native listing is enforced by the SERVER.
//
// createNativeListing / createNativeBundleListing (src/nakamigos/lib/orderbook.js) add a
// consideration item paying 0.5% of the price to the treasury Safe, but the client is
// optional: a hand-built Seaport order POSTed straight to /api/orderbook was stored and
// served with a live Buy button whether or not it paid the venue anything.
import { describe, it, expect, beforeEach, vi } from "vitest";
// Warms the module graph at collection time; each block re-imports under
// `vi.resetModules()` so the Supabase client is built after SUPABASE_* are set.
import "../orderbook.js";
import { PLATFORM_FEE_RECIPIENT as CLIENT_RECIPIENT, PLATFORM_FEE_BPS as CLIENT_BPS } from "../../src/nakamigos/constants.js";
import { PLATFORM_FEE_RECIPIENT, PLATFORM_FEE_BPS, platformFeeError } from "../_lib/platform-fee.js";

vi.mock("../_lib/ratelimit.js", () => ({ checkRateLimit: vi.fn(async () => true) }));

const SELLER = "0x" + "a".repeat(40);
const STRANGER = "0x" + "e".repeat(40);
const TREASURY = "0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d";
const NAKAMIGOS = "0xd774557b647330c91bf44cfeab205095f7e6c367";
const CANONICAL_CONDUIT = "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000";
const ZERO_ADDR = "0x" + "0".repeat(40);
const ZERO32 = "0x" + "0".repeat(64);

vi.mock("viem", () => ({
  recoverMessageAddress: vi.fn(async () => SELLER),
  decodeAbiParameters: vi.fn(() => []),
  parseAbiParameters: vi.fn(() => []),
}));
vi.mock("../_lib/seaport-verify.js", async () => {
  const actual = await vi.importActual("../_lib/seaport-verify.js");
  return {
    ...actual,
    verifySeaportSignature: vi.fn(async () => ({ ok: true })),
    verifyNftOwnership: vi.fn(async () => ({ ok: true })),
    verifyBundleOwnership: vi.fn(async () => ({ ok: true })),
    fetchNftOwner: vi.fn(async () => SELLER),
  };
});
vi.mock("../_lib/seaportHash.js", () => ({
  computeSeaportOrderHash: vi.fn(() => "0x" + "b".repeat(64)),
  isValidSeaportOrderHash: vi.fn(() => true),
}));
vi.mock("../_lib/push.js", () => ({ sendPushToWallet: vi.fn(async () => {}) }));

let inserted = [];
function makeChain(table) {
  const chain = {
    insert: vi.fn((row) => { inserted.push({ table, row }); return chain; }),
    update: vi.fn(() => chain),
    select: vi.fn((_cols, opts) => { chain._isCount = opts?.head === true; return chain; }),
    eq: vi.fn(() => chain), gt: vi.fn(() => chain), gte: vi.fn(() => chain),
    order: vi.fn(() => chain), limit: vi.fn(() => chain),
    single: vi.fn(async () => ({ data: null, error: null })),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    then: (resolve) => resolve(chain._isCount
      ? { data: null, error: null, count: 0 }
      : { data: [], error: null, count: 0 }),
  };
  return chain;
}
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: (t) => makeChain(t) })),
}));

const PRICE = 1_234_567_890_123_456_789n;
const FEE = (PRICE * 50n) / 10000n;
const eth = (amount, recipient, itemType = 0) => ({
  itemType, token: ZERO_ADDR, identifierOrCriteria: "0",
  startAmount: amount.toString(), endAmount: amount.toString(), recipient,
});
// The consideration createNativeListing signs: seller gets price minus fee, treasury gets fee.
const clientConsideration = () => [eth(PRICE - FEE, SELLER), eth(FEE, TREASURY)];

function params(tokenIds, consideration) {
  const now = Math.floor(Date.now() / 1000);
  return {
    offerer: SELLER, zone: ZERO_ADDR, zoneHash: ZERO32, orderType: 0,
    conduitKey: CANONICAL_CONDUIT,
    startTime: String(now), endTime: String(now + 86400), salt: "0x1",
    totalOriginalConsiderationItems: consideration.length,
    offer: tokenIds.map((id) => ({
      itemType: 2, token: NAKAMIGOS, identifierOrCriteria: String(id), startAmount: "1", endAmount: "1",
    })),
    consideration,
  };
}

async function post(handler, action, parameters) {
  const calls = { status: null, json: null };
  const res = {
    setHeader: vi.fn(() => res),
    status: (c) => { calls.status = c; return res; },
    json: (p) => { calls.json = p; return res; },
    end: vi.fn(),
  };
  await handler({
    method: "POST",
    headers: { origin: "https://memetics.finance" },
    query: {},
    body: {
      action,
      order: {
        parameters,
        signature: "0x" + "c".repeat(130),
        seaportSignature: "0x" + "c".repeat(130),
        seaportOrderHash: "0x" + "b".repeat(64),
        seaportCounter: "0",
        protocol_address: "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC",
      },
    },
  }, res);
  return calls;
}

// Hand-built orders that must be refused, each against what the client signs.
const REFUSED = [
  ["has no fee item", () => [eth(PRICE, SELLER)]],
  ["pays the fee to someone else", () => [eth(PRICE - FEE, SELLER), eth(FEE, STRANGER)]],
  ["pays the treasury half the fee", () => [eth(PRICE - FEE / 2n, SELLER), eth(FEE / 2n, TREASURY)]],
  ["pays the treasury one wei short", () => [eth(PRICE - FEE + 1n, SELLER), eth(FEE - 1n, TREASURY)]],
  ["splits the fee over two treasury items", () => [
    eth(PRICE - FEE, SELLER), eth(FEE / 2n, TREASURY), eth(FEE - FEE / 2n, TREASURY),
  ]],
  ["pays the fee as an ERC-20 item", () => [eth(PRICE - FEE, SELLER), eth(FEE, TREASURY, 1)]],
  ["omits the fee amount", () => [eth(PRICE - FEE, SELLER), { ...eth(FEE, TREASURY), startAmount: undefined, endAmount: undefined }]],
];

describe("orderbook create: the 0.5% venue fee", () => {
  let handler;
  beforeEach(async () => {
    vi.resetModules();
    inserted = [];
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "service-role";
    process.env.NODE_ENV = "test";
    handler = (await import("../orderbook.js")).default;
  });

  it.each(REFUSED)("refuses a listing that %s", async (_label, consideration) => {
    const c = await post(handler, "create", params([1], consideration()));
    expect(c.status).toBe(400);
    expect(c.json.error).toMatch(/venue fee/i);
    expect(inserted).toHaveLength(0);
  });

  it("stores the listing the client builds", async () => {
    const c = await post(handler, "create", params([1], clientConsideration()));
    expect(c.status).toBe(201);
    expect(inserted).toHaveLength(1);
  });

  it("matches the treasury address in any letter case", async () => {
    const c = await post(handler, "create", params([1], [eth(PRICE - FEE, SELLER), eth(FEE, TREASURY.toLowerCase())]));
    expect(c.status).toBe(201);
  });
});

describe("orderbook create-bundle: the 0.5% venue fee", () => {
  let handler;
  beforeEach(async () => {
    vi.resetModules();
    inserted = [];
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "service-role";
    process.env.BUNDLE_LISTING_ENABLED = "true";
    process.env.NODE_ENV = "test";
    handler = (await import("../orderbook.js")).default;
  });

  it.each(REFUSED)("refuses a bundle that %s", async (_label, consideration) => {
    const c = await post(handler, "create-bundle", params([1, 2], consideration()));
    expect(c.status).toBe(400);
    expect(c.json.error).toMatch(/venue fee/i);
    expect(inserted).toHaveLength(0);
  });

  it("stores the bundle the client builds", async () => {
    const c = await post(handler, "create-bundle", params([1, 2], clientConsideration()));
    expect(c.status).toBe(201);
    expect(inserted).toHaveLength(1);
  });
});

describe("the server's fee terms", () => {
  it("equal the client's", () => {
    expect(PLATFORM_FEE_RECIPIENT).toBe(CLIENT_RECIPIENT.toLowerCase());
    expect(PLATFORM_FEE_BPS).toBe(BigInt(CLIENT_BPS));
  });

  // The owner's call of 2026-10-18: half of OpenSea's 1%.
  it("are 0.5% (50 bps)", () => {
    expect(CLIENT_BPS).toBe(50);
    expect(PLATFORM_FEE_BPS).toBe(50n);
  });

  it("round down like the client when the fee is not a whole wei", () => {
    // 0.5% of 399 wei is 1.995 wei: the fee is 1, never 2.
    expect(platformFeeError([eth(398n, SELLER), eth(1n, TREASURY)], 399n)).toBeNull();
    expect(platformFeeError([eth(397n, SELLER), eth(2n, TREASURY)], 399n)).toMatch(/exactly 1 wei/);
  });
});
