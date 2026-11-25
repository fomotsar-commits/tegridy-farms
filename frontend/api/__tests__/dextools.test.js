// @vitest-environment node
//
// The DexTools adapter (api/_lib/dextools.js, ?resource=dextools behind /api/dextools/:endpoint):
// held to real mainnet transactions in our BAYLA/SOL pool. create.json is the transaction that
// opened it (slot 453,025,316, 2026-10-02): our program's `initialize`, which logs no event; the
// vaults after it hold 1 SOL and 219,749.259037 BAYLA, the same amounts its two inner
// TransferChecked instructions carry. The swap, deposit and withdrawal are the GeckoTerminal
// adapter's fixtures (2026-11-07). Numbers asserted were read from the chain's own bytes.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VENUE_PROGRAM, __reset, decimal, decodePool, eventsIn, feeBpsOf } from "../_lib/geckoterminal.js";
import { EVENTS_PER_TXN, OPEN_TAGS, dexToolsEventsIn, dexToolsEventsOf, handleDexTools, openedPools, openings } from "../_lib/dextools.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (dir, name) => JSON.parse(readFileSync(join(here, "__fixtures__", dir, name), "utf8"));
const createTx = read("dextools", "create.json");
const swapTx = read("geckoterminal", "swap.json");
const depositTx = read("geckoterminal", "deposit.json");
const withdrawTx = read("geckoterminal", "withdraw.json");
const accounts = read("geckoterminal", "accounts.json");
const POOL = "ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4";
const SOL = "So11111111111111111111111111111111111111112";
const BAYLA = "7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump";
const OPENER = "Upmhw8i6RSLXoj4yGzq9ZYLXb4UzZMRm7BSX8BxCdEd";
const PAYER = "27t671aWXQvfUk6WugfLFEKkaXbJmT5yxpmrydEkjjo7";
const sig = (tx) => tx.transaction.signatures[0];

const pool = decodePool(POOL, accounts.pool.data);
pool.feeBps = feeBpsOf(accounts.config.data, pool.creatorFeeOn);
const pools = new Map([[POOL, pool]]);

describe("a pool's opening, read from the instruction (our program logs no event for it)", () => {
  it("knows cp-swap's two opening instructions by Anchor's tags", () => {
    expect([...OPEN_TAGS]).toEqual(["afaf6d1f0d989bed", "3f37fe4131b25979"]);
    expect(createTx.meta.logMessages.some((l) => l.startsWith("Program data: "))).toBe(false);
    expect(openings(createTx)).toHaveLength(1);
    expect(openings(swapTx)).toEqual([]);
    expect(openedPools(createTx, pools)).toEqual([pool]);
    expect(openedPools(createTx, new Map())).toEqual([]);
  });
  it("a creation, then a join of what the pool opened with: 1 SOL and 219,749.259037 BAYLA", () => {
    const events = dexToolsEventsOf(createTx, pools, 5);
    const head = { block: { blockNumber: 453025316, blockTimestamp: 1791055083 }, txnId: sig(createTx), txnIndex: 5, maker: OPENER, pairId: POOL };
    expect(events).toEqual([
      { ...head, eventType: "creation", eventIndex: 5000 },
      { ...head, eventType: "join", amount0: "1", amount1: "219749.259037", reserves: { asset0: "1", asset1: "219749.259037" }, eventIndex: 5001 },
    ]);
  });
  it("when the same transaction then trades in the pool, the opening is the vaults that trade started from, not the vaults after it", () => {
    const swapLines = swapTx.meta.logMessages.filter((l) => l.startsWith("Program data: "));
    const both = { ...createTx, meta: { ...createTx.meta, logMessages: [...createTx.meta.logMessages, ...swapLines] } };
    // The swap's own log line: input (SOL) vault at byte 40, output (BAYLA) vault at byte 48.
    const d = Buffer.from(swapLines[0].slice("Program data: ".length), "base64");
    const sol = d.readBigUInt64LE(40);
    const bayla = d.readBigUInt64LE(48);
    const [creation, opening] = dexToolsEventsOf(both, pools, 0);
    expect(creation.eventType).toBe("creation");
    expect(sol).not.toBe(1_000_000_000n); // not the vaults after the opening
    expect(opening).toMatchObject({ eventType: "join", amount0: decimal(sol, 9), amount1: decimal(bayla, 6) });
  });
});

describe("events in DexTools' shape", () => {
  it("a swap keeps what moved and the vaults after, drops GeckoTerminal's price and fee fields, and numbers itself within the block", () => {
    const [e, ...rest] = dexToolsEventsOf(swapTx, pools, 7);
    expect(rest).toHaveLength(0);
    expect(e).toEqual({
      block: { blockNumber: 466405061, blockTimestamp: 1794031517 }, txnId: sig(swapTx), txnIndex: 7, eventIndex: 7000, maker: PAYER, pairId: POOL,
      eventType: "swap", asset0In: "0.1", asset1Out: "17214.837765", reserves: { asset0: "76.654231321", asset1: "13310312.704235" },
    });
  });
  it("eventIndex is unique in the block: two events of one transaction, and transactions apart", () => {
    const twice = { ...swapTx, meta: { ...swapTx.meta, logMessages: [...swapTx.meta.logMessages, ...swapTx.meta.logMessages] } };
    expect(dexToolsEventsOf(twice, pools, 2).map((e) => e.eventIndex)).toEqual([2000, 2001]);
    expect(dexToolsEventsOf(swapTx, pools, 3)[0].eventIndex).toBe(3 * EVENTS_PER_TXN);
  });
  it("a deposit is a join and a withdrawal an exit; a failed transaction has none", () => {
    expect(dexToolsEventsOf(depositTx, pools, 0)[0]).toMatchObject({ eventType: "join", amount0: "0.049676064", amount1: "8626.776509", reserves: { asset0: "76.703907385", asset1: "13318939.480744" } });
    expect(dexToolsEventsOf(withdrawTx, pools, 3)[0]).toMatchObject({ eventType: "exit", eventIndex: 3000, amount0: "0.48299538", amount1: "83877.281549" });
    expect(dexToolsEventsOf({ ...createTx, meta: { ...createTx.meta, err: { InstructionError: [14, "Custom"] } } }, pools, 0)).toEqual([]);
  });
});

/** A chain that answers from the fixtures. `poolLists` is what getProgramAccounts answers, call by call (the last repeats). */
function chain({ tip = 466_420_000, txs = [createTx, swapTx, depositTx, withdrawTx], poolLists = [[POOL]], skipped = [] } = {}) {
  const bySig = new Map(txs.map((t) => [sig(t), t]));
  const calls = [];
  let lists = 0;
  const rpc = vi.fn(async (method, params) => {
    calls.push(method);
    if (method === "getProgramAccounts") {
      const ids = poolLists[Math.min(lists++, poolLists.length - 1)];
      return ids.map((id) => ({ pubkey: id, account: { data: [accounts.pool.data, "base64"], owner: VENUE_PROGRAM } }));
    }
    if (method === "getMultipleAccounts") return { value: params[0].map((k) => (k === accounts.config.address ? { data: [accounts.config.data, "base64"] } : null)) };
    if (method === "getSlot") return tip;
    if (method === "getBlockTime") {
      if (skipped.includes(params[0])) throw new Error(`getBlockTime: {"code":-32007,"message":"Slot ${params[0]} was skipped, or missing due to ledger jump to recent snapshot"}`);
      return 1_794_000_000 + (params[0] % 1000);
    }
    if (method === "getSignaturesForAddress") {
      const list = [...bySig.values()].sort((a, b) => b.slot - a.slot).map((t) => ({ signature: sig(t), slot: t.slot, blockTime: t.blockTime, err: null }));
      const before = params[1]?.before;
      const from = before ? list.findIndex((s) => s.signature === before) + 1 : 0;
      return list.slice(from, from + (params[1]?.limit ?? 1000));
    }
    if (method === "getTransaction") return bySig.get(params[0]) ?? null;
    if (method === "getBlock") return { signatures: ["other1", "other2", ...[...bySig.values()].filter((t) => t.slot === params[0]).map(sig)] };
    if (method === "getAccountInfo") {
      const k = params[0];
      if (k === SOL) return { value: { owner: accounts.mint0.owner, data: [accounts.mint0.data, "base64"] } };
      if (k === BAYLA) return { value: { owner: accounts.mint1.owner, data: [accounts.mint1.data, "base64"] } };
      return { value: null };
    }
    throw new Error(`unexpected ${method}`);
  });
  return { rpc, calls, pgas: () => calls.filter((m) => m === "getProgramAccounts").length };
}
const req = (endpoint, query = {}, headers = {}) => ({ method: "GET", query: { resource: "dextools", endpoint, ...query }, headers });
function res() {
  const r = { statusCode: null, body: null, headers: {} };
  r.setHeader = (h, v) => { r.headers[h] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.body = p; return r; };
  return r;
}
const allow = async () => true;
const call = async (c, endpoint, query) => {
  const r = res();
  await handleDexTools(req(endpoint, query), r, { rpc: c.rpc, checkRateLimit: allow });
  return r;
};

describe("a pool opened since the pool list was read is not lost (both adapters)", () => {
  beforeEach(() => __reset());

  it("DexTools: the list read before the pool opened is read again, and the opening and its trades come through", async () => {
    const c = chain({ txs: [createTx, swapTx], poolLists: [[], [POOL]] });
    expect(await dexToolsEventsIn(c.rpc, 1, 2)).toEqual([]); // the list is read: no pools yet
    const events = await dexToolsEventsIn(c.rpc, 453025316, 466405061);
    expect(events.map((e) => e.eventType)).toEqual(["creation", "join", "swap"]);
    expect(c.pgas()).toBe(2);
  });
  it("GeckoTerminal: the same, for a pool's first trade", async () => {
    const c = chain({ txs: [swapTx], poolLists: [[], [POOL]] });
    expect(await eventsIn(c.rpc, 1, 2)).toEqual([]);
    expect((await eventsIn(c.rpc, 466405061, 466405061)).map((e) => e.eventType)).toEqual(["swap"]);
    expect(c.pgas()).toBe(2);
  });
  it("another program's pool in an event line costs one extra read, then is remembered", async () => {
    const c = chain({ txs: [swapTx], poolLists: [[]] });
    for (let i = 0; i < 3; i++) expect(await eventsIn(c.rpc, 466405061, 466405061)).toEqual([]);
    expect(c.pgas()).toBe(2);
  });
});

describe("the endpoints", () => {
  beforeEach(() => __reset());

  it("/latest-block: the newest finalized slot with a time, never cached", async () => {
    const r = await call(chain({ tip: 466_420_000 }), "latest-block");
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ block: { blockNumber: 466_420_000, blockTimestamp: 1_794_000_000 } });
    expect(r.headers["Cache-Control"]).toBe("no-store");
  });

  it("/block: a slot's time; a skipped slot or one past the tip is 404; no number is 400 in DexTools' shape", async () => {
    const c = chain({ tip: 466_420_000, skipped: [466_419_000] });
    const ok = await call(c, "block", { number: "466405061" });
    expect(ok.body).toEqual({ block: { blockNumber: 466405061, blockTimestamp: 1_794_000_061 } });
    expect(ok.headers["Cache-Control"]).toBe("s-maxage=86400");
    expect((await call(c, "block", { number: "466419000" })).body).toEqual({ code: "404", message: "Block not found" });
    expect((await call(c, "block", { number: "466420001" })).statusCode).toBe(404);
    const none = await call(c, "block", { timestamp: "1794000000" });
    expect(none.statusCode).toBe(400);
    expect(none.body).toMatchObject({ code: "400", message: "Invalid parameters", issues: [{ param: "number", code: "required" }] });
  });

  it("/pair: the pool's coins in its order, opened by its first transaction, made by our program", async () => {
    const r = await call(chain(), "pair", { id: POOL });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ pair: { id: POOL, asset0Id: SOL, asset1Id: BAYLA, createdAtBlockNumber: 453025316, createdAtBlockTimestamp: 1791055083, createdAtTxnId: sig(createTx), factoryAddress: VENUE_PROGRAM } });
    expect((await call(chain(), "pair", { id: PAYER })).body).toEqual({ code: "404", message: "Pair not found" });
    expect((await call(chain(), "pair", { id: "nope" })).body).toMatchObject({ code: "400", issues: [{ param: "id", code: "invalid" }] });
  });

  it("/asset: id, name, symbol and supply, nothing DexTools has no field for", async () => {
    const r = await call(chain(), "asset", { id: BAYLA });
    expect(r.body.asset).toEqual({ id: BAYLA, name: expect.any(String), symbol: expect.stringMatching(/BAYLA/i), totalSupply: "985081282.555694" });
    expect((await call(chain(), "asset", { id: SOL })).body.asset).toEqual({ id: SOL, name: "Wrapped SOL", symbol: "SOL" });
    expect((await call(chain(), "asset", { id: PAYER })).statusCode).toBe(404);
  });

  it("/events: the opening, then every trade, in block order, inclusive of both ends", async () => {
    const opened = await call(chain(), "events", { fromBlock: "453025316", toBlock: "453025316" });
    expect(opened.statusCode).toBe(200);
    expect(opened.body.events.map((e) => [e.eventType, e.block.blockNumber, e.eventIndex])).toEqual([["creation", 453025316, 2000], ["join", 453025316, 2001]]);
    const r = await call(chain(), "events", { fromBlock: "466405061", toBlock: "466405274" });
    expect(r.body.events.map((e) => [e.eventType, e.block.blockNumber, e.eventIndex])).toEqual([["swap", 466405061, 2000], ["join", 466405274, 2000]]);
    expect(r.headers["Cache-Control"]).toBe("s-maxage=86400");
    expect((await call(chain(), "events", { fromBlock: "1", toBlock: "100" })).body).toEqual({ events: [] });
  });

  it("/events: bad slots and a range too wide are 400 with an issue each; too many transactions says to ask for less", async () => {
    const c = chain();
    expect((await call(c, "events", {})).body.issues.map((i) => [i.param, i.code])).toEqual([["fromBlock", "required"], ["toBlock", "required"]]);
    expect((await call(c, "events", { fromBlock: "10", toBlock: "5" })).body.issues).toEqual([expect.objectContaining({ param: "toBlock", code: "range" })]);
    expect((await call(c, "events", { fromBlock: "1", toBlock: "60000" })).statusCode).toBe(400);
    const many = chain({ txs: Array.from({ length: 61 }, (_, i) => ({ ...swapTx, slot: 466405061 + i, transaction: { ...swapTx.transaction, signatures: [`sig${i}`] } })) });
    const r = await call(many, "events", { fromBlock: "466405061", toBlock: "466405200" });
    expect(r.statusCode).toBe(400);
    expect(r.body.issues[0].message).toMatch(/smaller range/);
  });

  it("/exchange: our program, by its address only; /asset/holders says why it is not served", async () => {
    expect((await call(chain(), "exchange", { id: VENUE_PROGRAM })).body).toEqual({ exchange: { factoryAddress: VENUE_PROGRAM, name: "Memetics Finance", logoURL: "https://memetics.finance/apple-touch-icon.png" } });
    expect((await call(chain(), "exchange", { id: POOL })).statusCode).toBe(404);
    const holders = await call(chain(), "asset-holders", { id: BAYLA });
    expect(holders.statusCode).toBe(404);
    expect(holders.body.message).toMatch(/not served/);
  });

  it("errors in DexTools' shape: a refused rate is 429, a chain that cannot be read is 500 with no detail, GET only, real names only", async () => {
    const limited = res();
    await handleDexTools(req("latest-block"), limited, { rpc: chain().rpc, checkRateLimit: async (_q, r) => { r.status(429).json({ error: "Too many requests" }); return false; } });
    expect(limited.statusCode).toBe(429);
    expect(limited.body).toEqual({ code: "429", message: "Rate limit occured handling request" });
    const down = res();
    await handleDexTools(req("latest-block"), down, { rpc: vi.fn(async () => { throw new Error("https://user:secret@rpc.example/ down"); }), checkRateLimit: allow });
    expect(down.statusCode).toBe(500);
    expect(JSON.stringify(down.body)).not.toMatch(/secret/);
    const post = res();
    await handleDexTools({ ...req("latest-block"), method: "POST" }, post, { rpc: chain().rpc, checkRateLimit: allow });
    expect(post.body).toEqual({ code: "405", message: "Method not allowed" });
    expect((await call(chain(), "blocks")).body.code).toBe("404");
  });
});

describe("the route", () => {
  it("vercel.json sends /api/dextools/asset/holders, then /api/dextools/:endpoint, to the catchall, before the page catch-all; the branch sits above the provider line", () => {
    const rewrites = JSON.parse(readFileSync(join(here, "..", "..", "vercel.json"), "utf8")).rewrites;
    const holders = rewrites.findIndex((r) => r.source === "/api/dextools/asset/holders");
    const any = rewrites.findIndex((r) => r.source === "/api/dextools/:endpoint");
    expect(rewrites[holders]?.destination).toBe("/api/aggregator?resource=dextools&endpoint=asset-holders");
    expect(rewrites[any]?.destination).toBe("/api/aggregator?resource=dextools&endpoint=:endpoint");
    expect(holders).toBeLessThan(any);
    expect(any).toBeLessThan(rewrites.findIndex((r) => r.source === "/((?!api/).*)"));
    const src = readFileSync(join(here, "..", "aggregator.js"), "utf8");
    expect(src.indexOf('req.query.resource === "dextools"')).toBeGreaterThan(0);
    expect(src.indexOf('req.query.resource === "dextools"')).toBeLessThan(src.indexOf("const provider = req.query.provider"));
  });
});
