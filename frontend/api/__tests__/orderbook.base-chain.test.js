// Bojungles and Seeds are listed on the venue's own order book, on Base. Each
// order's chain is read from the registry by its contract, never from the
// request: the fee goes to the Base treasury Safe (the Ethereum fee Safe has no
// code on Base), the signature and ownership are checked on Base, the order is
// pinned to Seaport 1.6, and its cancel and fill are held to Base. Ethereum
// orders keep every rule they had.
import { describe, it, expect, beforeEach, vi } from "vitest";
// Warms the module graph at collection time (see orderbook.platform-fee.test.js).
import "../orderbook.js";

vi.mock("../_lib/ratelimit.js", () => ({ checkRateLimit: vi.fn(async () => true) }));

const SELLER = "0x" + "a".repeat(40);
const ETH_SAFE = "0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d";
const BASE_SAFE = "0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0";
const BOJ = "0x36afee4fadc3b77ff5f1f9a040e264150afb979a";
const SEEDS = "0xb34bb1d81a4e5f9dca7360c3043ad50db2ea87f3";
const GOLD = "0x6aa03f42c5366e2664c887eb2e90844ca00b92f3";
const SEAPORT_15 = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC";
const SEAPORT_16 = "0x0000000000000068F116a894984e2DB1123eB395";
const CONDUIT_KEY = "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000";
const ZERO_ADDR = "0x" + "0".repeat(40);
const ZERO32 = "0x" + "0".repeat(64);
const HASH = "0x" + "d".repeat(64);
const TX = "0x" + "e".repeat(64);

const verify = vi.hoisted(() => ({ sig: [], owner: [] }));
vi.mock("viem", () => ({
  recoverMessageAddress: vi.fn(async () => "0x" + "a".repeat(40)),
  decodeAbiParameters: vi.fn(() => []),
  parseAbiParameters: vi.fn(() => []),
}));
vi.mock("../_lib/seaport-verify.js", async () => {
  const actual = await vi.importActual("../_lib/seaport-verify.js");
  return {
    ...actual,
    verifySeaportSignature: vi.fn(async (args) => { verify.sig.push(args); return { ok: true }; }),
    verifyNftOwnership: vi.fn(async (args) => { verify.owner.push(args); return { ok: true }; }),
    verifyBundleOwnership: vi.fn(async () => ({ ok: true })),
  };
});
vi.mock("../_lib/seaportHash.js", () => ({
  computeSeaportOrderHash: vi.fn(() => "0x" + "b".repeat(64)),
  isValidSeaportOrderHash: vi.fn(() => true),
}));
vi.mock("../_lib/push.js", () => ({ sendPushToWallet: vi.fn(async () => {}) }));

// One stored row the cancel and fill paths read, and every write and filter.
const db = vi.hoisted(() => ({ row: null, inserted: [], filters: [] }));
function makeChain() {
  const chain = {
    insert: vi.fn((row) => { db.inserted.push(row); return chain; }),
    update: vi.fn(() => chain),
    select: vi.fn((_cols, opts) => { chain._isCount = opts?.head === true; return chain; }),
    eq: vi.fn(() => chain), gt: vi.fn(() => chain), gte: vi.fn(() => chain),
    in: vi.fn((col, vals) => { db.filters.push(["in", col, vals]); return chain; }),
    not: vi.fn((col, op, vals) => { db.filters.push(["not", col, op, vals]); return chain; }),
    order: vi.fn(() => chain), limit: vi.fn(() => chain),
    single: vi.fn(async () => ({ data: db.row, error: null })),
    maybeSingle: vi.fn(async () => ({ data: db.row, error: null })),
    then: (resolve) => resolve(chain._isCount
      ? { data: null, error: null, count: 0 }
      : { data: [{ order_hash: HASH }], error: null, count: 0 }),
  };
  return chain;
}
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: () => makeChain() })),
}));

const PRICE = 20_000_000_000_000_000n; // 0.02 ETH
const FEE = (PRICE * 50n) / 10000n;
const eth = (amount, recipient) => ({
  itemType: 0, token: ZERO_ADDR, identifierOrCriteria: "0",
  startAmount: amount.toString(), endAmount: amount.toString(), recipient,
});

function listing(token, feeRecipient, tokenIds = [7]) {
  const now = Math.floor(Date.now() / 1000);
  return {
    offerer: SELLER, zone: ZERO_ADDR, zoneHash: ZERO32, orderType: 0, conduitKey: CONDUIT_KEY,
    startTime: String(now), endTime: String(now + 86400), salt: "0x1",
    totalOriginalConsiderationItems: 2,
    offer: tokenIds.map((id) => ({ itemType: 2, token, identifierOrCriteria: String(id), startAmount: "1", endAmount: "1" })),
    consideration: [eth(PRICE - FEE, SELLER), eth(FEE, feeRecipient)],
  };
}

function makeRes() {
  const out = { status: null, json: null };
  const res = {
    setHeader: vi.fn(() => res),
    status: (c) => { out.status = c; return res; },
    json: (p) => { out.json = p; return res; },
    end: vi.fn(),
  };
  return { res, out };
}

let handler;
async function post(body) {
  const { res, out } = makeRes();
  await handler({ method: "POST", headers: { origin: "https://memetics.finance" }, query: {}, body }, res);
  return out;
}
const create = (parameters, protocol_address, action = "create") => post({
  action,
  order: {
    parameters,
    signature: "0x" + "c".repeat(130),
    seaportSignature: "0x" + "c".repeat(130),
    seaportOrderHash: "0x" + "b".repeat(64),
    seaportCounter: "0",
    ...(protocol_address === undefined ? {} : { protocol_address }),
  },
});
const now = () => Math.floor(Date.now() / 1000);

beforeEach(async () => {
  vi.resetModules();
  db.row = null;
  db.inserted = [];
  db.filters = [];
  verify.sig = [];
  verify.owner = [];
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = "service-role";
  process.env.NODE_ENV = "test";
  process.env.BUNDLE_LISTING_ENABLED = "true";
  delete process.env.ALCHEMY_API_KEY;
  handler = (await import("../orderbook.js")).default;
});

describe("a Bojungle or a Seed is listed on Base", () => {
  it.each([["Bojungles", BOJ], ["Seeds", SEEDS]])("%s: a listing paying 0.5% to the Base treasury Safe is stored, checked on Base", async (_l, token) => {
    const out = await create(listing(token, BASE_SAFE), SEAPORT_16);
    expect(out.status).toBe(201);
    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0].contract_address).toBe(token);
    expect(db.inserted[0].protocol_address).toBe(SEAPORT_16);
    expect(verify.sig[0].chainId).toBe(8453);
    expect(verify.owner[0].chainId).toBe(8453);
  });

  it("refuses a Base listing that pays the fee to the Ethereum fee Safe, which has no code on Base", async () => {
    const out = await create(listing(BOJ, ETH_SAFE), SEAPORT_16);
    expect(out.status).toBe(400);
    expect(out.json.error).toMatch(/venue fee/i);
    expect(db.inserted).toHaveLength(0);
  });

  it.each([["Seaport 1.5", SEAPORT_15], ["no protocol address", undefined], ["an unknown contract", "0x" + "9".repeat(40)]])("refuses a Base listing naming %s: it is signed for Seaport 1.6", async (_l, protocol) => {
    const out = await create(listing(BOJ, BASE_SAFE), protocol);
    expect(out.status).toBe(400);
    expect(out.json.error).toBe("Unsupported protocol address");
    expect(db.inserted).toHaveLength(0);
  });

  it("refuses a Base bundle: bundles stay Ethereum only", async () => {
    const out = await create(listing(BOJ, BASE_SAFE, [7, 8]), SEAPORT_16, "create-bundle");
    expect(out.status).toBe(403);
    expect(db.inserted).toHaveLength(0);
  });
});

describe("Ethereum listings keep their rules", () => {
  it("an Ethereum listing paying the Ethereum fee Safe is stored, checked on chain 1, at Seaport 1.5", async () => {
    const out = await create(listing(GOLD, ETH_SAFE), SEAPORT_15);
    expect(out.status).toBe(201);
    expect(db.inserted[0].protocol_address).toBe(SEAPORT_15);
    expect(verify.sig[0].chainId).toBe(1);
  });

  it("an Ethereum listing with no protocol address still defaults to Seaport 1.5", async () => {
    const out = await create(listing(GOLD, ETH_SAFE), undefined);
    expect(out.status).toBe(201);
    expect(db.inserted[0].protocol_address).toBe(SEAPORT_15);
  });

  it("an Ethereum listing paying the Base treasury instead is refused", async () => {
    const out = await create(listing(GOLD, BASE_SAFE), SEAPORT_15);
    expect(out.status).toBe(400);
    expect(out.json.error).toMatch(/venue fee/i);
  });
});

describe("the listings feed serves the Base collections", () => {
  it.each([BOJ, SEEDS, GOLD])("GET query for %s answers 200", async (contract) => {
    const { res, out } = makeRes();
    await handler({ method: "GET", headers: {}, query: { action: "query", contract } }, res);
    expect(out.status).toBe(200);
  });
});

describe("a cancel is held to the order's own chain", () => {
  const cancel = (chainId) => post({ action: "cancel", orderHash: HASH, signature: "0x" + "c".repeat(130), chainId, timestamp: now() });

  it("a Base order is cancelled with chain 8453", async () => {
    db.row = { maker: SELLER, status: "active", contract_address: BOJ };
    expect((await cancel(8453)).json).toEqual({ success: true });
  });

  it("a Base order signed as chain 1 is refused", async () => {
    db.row = { maker: SELLER, status: "active", contract_address: BOJ };
    const out = await cancel(1);
    expect(out.status).toBe(400);
    expect(out.json.error).toMatch(/another chain/);
  });

  it("an Ethereum order signed as chain 8453 is refused, and chain 1 still cancels it", async () => {
    db.row = { maker: SELLER, status: "active", contract_address: GOLD };
    expect((await cancel(8453)).status).toBe(400);
    expect((await cancel(1)).json).toEqual({ success: true });
  });

  it("a chain the book does not trade on is refused before any read", async () => {
    db.row = { maker: SELLER, status: "active", contract_address: BOJ };
    expect((await cancel(137)).status).toBe(400);
  });
});

describe("cancel-all clears one chain: a counter bump on one Seaport leaves the other chain's orders live", () => {
  const cancelAll = (chainId) => post({ action: "cancel-all", maker: SELLER, signature: "0x" + "c".repeat(130), chainId, timestamp: now() });

  it("chain 8453 clears only the Base collections' rows", async () => {
    const out = await cancelAll(8453);
    expect(out.json).toEqual({ success: true, cancelled: 1 });
    expect(db.filters).toEqual([["in", "contract_address", [BOJ, SEEDS]]]);
  });

  it("chain 1 clears every row but the Base ones", async () => {
    const out = await cancelAll(1);
    expect(out.json).toEqual({ success: true, cancelled: 1 });
    expect(db.filters).toEqual([["not", "contract_address", "in", `(${BOJ},${SEEDS})`]]);
  });

  it("another chain is refused", async () => {
    expect((await cancelAll(137)).status).toBe(400);
    expect(db.filters).toEqual([]);
  });
});

describe("a fill is verified on the order's own chain", () => {
  let fetchMock;
  beforeEach(() => {
    process.env.ALCHEMY_API_KEY = "test-key";
    fetchMock = vi.fn(async () => ({
      ok: true, status: 200, headers: { get: () => null },
      body: null,
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }),
    }));
    globalThis.fetch = fetchMock;
  });
  const fill = (chainId) => post({ action: "fill", orderHash: HASH, txHash: TX, signature: "0x" + "c".repeat(130), chainId, timestamp: now() });

  it("a Base order's receipt is read on Base", async () => {
    db.row = { seaport_order_hash: "0x" + "b".repeat(64), contract_address: SEEDS };
    const out = await fill(8453);
    expect(out.status).toBe(400); // receipt null: "not found on-chain"
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/base-mainnet\.g\.alchemy\.com\//);
  });

  it("an Ethereum order's receipt is still read on Ethereum", async () => {
    db.row = { seaport_order_hash: "0x" + "b".repeat(64), contract_address: GOLD };
    await fill(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/eth-mainnet\.g\.alchemy\.com\//);
  });

  it("a Base order's fill signed as chain 1 is refused before any read", async () => {
    db.row = { seaport_order_hash: "0x" + "b".repeat(64), contract_address: BOJ };
    const out = await fill(1);
    expect(out.status).toBe(400);
    expect(out.json.error).toMatch(/another chain/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
