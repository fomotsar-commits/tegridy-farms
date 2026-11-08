// @vitest-environment node
//
// The GeckoTerminal adapter (api/_lib/geckoterminal.js, ?resource=gt behind /api/gt/:endpoint):
// held to real mainnet transactions in our BAYLA/SOL pool (one swap, one deposit, one
// withdrawal, 2026-11-07) and the pool's own accounts, read once and kept as fixtures. The
// numbers asserted were worked out by hand from the program's event bytes, not from the code.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DEX_KEY, MAX_TXS_PER_CALL, VENUE_PROGRAM, __reset, decimal, decodePool, eventsIn, eventsOf, feeBpsOf,
  handleGeckoTerminal, latestBlock, metaplexMetadata, metaplexPda, programEvents, ratio, signaturesIn, token2022Metadata,
} from "../_lib/geckoterminal.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "geckoterminal");
const read = (name) => JSON.parse(readFileSync(join(FIX, name), "utf8"));
const swapTx = read("swap.json");
const depositTx = read("deposit.json");
const withdrawTx = read("withdraw.json");
const accounts = read("accounts.json");
const POOL = "ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4";
const SOL = "So11111111111111111111111111111111111111112";
const BAYLA = "7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump";
const PAYER = "27t671aWXQvfUk6WugfLFEKkaXbJmT5yxpmrydEkjjo7";

const pool = decodePool(POOL, accounts.pool.data);
pool.feeBps = feeBpsOf(accounts.config.data, pool.creatorFeeOn);
const pools = new Map([[POOL, pool]]);

describe("numbers as GeckoTerminal reads them", () => {
  it("decimalizes base units exactly, dropping trailing zeros", () => {
    expect(decimal(100_000_000n, 9)).toBe("0.1");
    expect(decimal(17_214_837_765n, 6)).toBe("17214.837765");
    expect(decimal(0n, 6)).toBe("0");
    expect(decimal(5n, 9)).toBe("0.000000005");
    expect(decimal(12_000_000n, 6)).toBe("12");
  });
  it("divides base units of two coins into a price to 50 places, exactly", () => {
    // 17214.837765 BAYLA for 0.099 SOL: one SOL is 173887.2501515… BAYLA.
    const price = ratio(17_214_837_765n, 6, 99_000_000n, 9);
    expect(price.startsWith("173887.25015151515151515151515")).toBe(true);
    expect(price.split(".")[1]).toHaveLength(50);
    expect(ratio(1n, 0, 3n, 0)).toBe("0.33333333333333333333333333333333333333333333333333");
    expect(ratio(1n, 0, 0n, 0)).toBeNull();
  });
});

describe("the pool and its fee, from the chain's own bytes", () => {
  it("reads the BAYLA/SOL pool: SOL first with 9 decimals, BAYLA second with 6, the creator fee off", () => {
    expect(pool).toMatchObject({ mint0: SOL, mint1: BAYLA, decimals0: 9, decimals1: 6, creatorFeeOn: false, ammConfig: "CapqvAA9HvERTwzmE26xrtFhMaNcaXXoQUADpBWqWjKy" });
    expect(pool.vault0).toBe("4HjxickXVJ98vdosH9idfKfsombYrk2nNbWZETS8PjVN");
  });
  it("turns the config's 10,000 parts-per-million trade fee into 100 bps, and adds the creator fee only when a pool has it on", () => {
    expect(feeBpsOf(accounts.config.data, false)).toBe(100);
    const withCreator = Buffer.from(accounts.config.data, "base64");
    withCreator.writeBigUInt64LE(2_500n, 108);
    expect(feeBpsOf(withCreator, true)).toBe(125);
    expect(feeBpsOf(withCreator, false)).toBe(100);
  });
  it("refuses an account of the wrong size", () => {
    expect(() => decodePool(POOL, Buffer.alloc(100))).toThrow(/100 bytes/);
  });
});

describe("events, held to mainnet transactions", () => {
  it("a swap: what the pool received, the 1% kept from it, what the curve paid, the price of SOL in BAYLA, and both vaults after", () => {
    const [e, ...rest] = eventsOf(swapTx, pools, 7);
    expect(rest).toHaveLength(0);
    expect(e).toMatchObject({
      eventType: "swap", txnId: swapTx.transaction.signatures[0], txnIndex: 7, eventIndex: 0, maker: PAYER, pairId: POOL,
      block: { blockNumber: 466405061, blockTimestamp: 1794031517 },
      asset0In: "0.1", asset1Out: "17214.837765",
      reserves: { asset0: "76.654231321", asset1: "13310312.704235" },
      metadata: { fees0In: "0.001", fees1Out: "0" },
    });
    expect(e).not.toHaveProperty("asset1In");
    expect(e).not.toHaveProperty("asset0Out");
    expect(e.priceNative).toMatch(/^173887\.250151515151515151515151515151515151515151515/);
  });
  it("a deposit is a join and a withdrawal an exit, each with what moved and both vaults after", () => {
    const [join] = eventsOf(depositTx, pools, 0);
    expect(join).toMatchObject({ eventType: "join", maker: PAYER, pairId: POOL, amount0: "0.049676064", amount1: "8626.776509", reserves: { asset0: "76.703907385", asset1: "13318939.480744" }, block: { blockNumber: 466405274 } });
    const [exit] = eventsOf(withdrawTx, pools, 3);
    expect(exit).toMatchObject({ eventType: "exit", txnIndex: 3, amount0: "0.48299538", amount1: "83877.281549", reserves: { asset0: "76.220912005", asset1: "13235062.199195" } });
  });
  it("a failed transaction, an unknown pool, and other programs' event lines give nothing", () => {
    expect(eventsOf({ ...swapTx, meta: { ...swapTx.meta, err: { InstructionError: [0, "Custom"] } } }, pools, 0)).toEqual([]);
    expect(programEvents(swapTx, new Map())).toEqual([]);
    const foreign = { ...swapTx, meta: { ...swapTx.meta, logMessages: ["Program data: AAAAAAAAAAA=", "Program log: hello", ...swapTx.meta.logMessages] } };
    expect(eventsOf(foreign, pools, 0)).toHaveLength(1);
  });
  it("numbers events within a transaction in log order, after the transaction's own place in the block", () => {
    const twice = { ...swapTx, meta: { ...swapTx.meta, logMessages: [...swapTx.meta.logMessages, ...swapTx.meta.logMessages] } };
    expect(eventsOf(twice, pools, 5).map((e) => [e.txnIndex, e.eventIndex])).toEqual([[5, 0], [5, 1]]);
  });
});

describe("token names", () => {
  it("reads BAYLA's name and symbol from its Token-2022 metadata extension", () => {
    expect(token2022Metadata(Buffer.from(accounts.mint1.data, "base64"))).toMatchObject({ symbol: expect.stringMatching(/BAYLA/i), name: expect.any(String) });
  });
  it("reads a Metaplex metadata account, and derives its address without web3.js", () => {
    const name = Buffer.from("Groyper\0\0\0");
    const symbol = Buffer.from("GROYPER\0");
    const d = Buffer.alloc(65 + 4 + name.length + 4 + symbol.length + 10);
    d[0] = 4;
    d.writeUInt32LE(name.length, 65);
    name.copy(d, 69);
    d.writeUInt32LE(symbol.length, 69 + name.length);
    symbol.copy(d, 73 + name.length);
    expect(metaplexMetadata(d)).toEqual({ name: "Groyper", symbol: "GROYPER" });
    expect(metaplexMetadata(Buffer.alloc(10))).toBeNull();
    // Known on chain: BAYLA's Metaplex metadata PDA (metaplexPda is the same derivation the site's launcher uses).
    expect(metaplexPda(BAYLA)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
});

/** A chain that answers from the fixtures: one pool, its config, the three transactions in their slots. */
function chain({ tip = 466_420_000, txs = [swapTx, depositTx, withdrawTx], skipSlots = [] } = {}) {
  const bySig = new Map(txs.map((t) => [t.transaction.signatures[0], t]));
  const calls = [];
  const rpc = vi.fn(async (method, params) => {
    calls.push(method);
    if (method === "getProgramAccounts") return [{ pubkey: POOL, account: { data: [accounts.pool.data, "base64"], owner: VENUE_PROGRAM } }];
    if (method === "getMultipleAccounts") return { value: params[0].map((k) => (k === accounts.config.address ? { data: [accounts.config.data, "base64"] } : null)) };
    if (method === "getSlot") return tip;
    if (method === "getBlockTime") return skipSlots.includes(params[0]) ? null : 1_794_000_000 + (params[0] % 1000);
    if (method === "getSignaturesForAddress") {
      // Newest first, as the RPC lists them.
      const list = [...bySig.values()].sort((a, b) => b.slot - a.slot).map((t) => ({ signature: t.transaction.signatures[0], slot: t.slot, blockTime: t.blockTime, err: null }));
      const before = params[1]?.before;
      const from = before ? list.findIndex((s) => s.signature === before) + 1 : 0;
      return list.slice(from, from + (params[1]?.limit ?? 1000));
    }
    if (method === "getTransaction") return bySig.get(params[0]) ?? null;
    if (method === "getBlock") return { signatures: ["other1", "other2", ...[...bySig.values()].filter((t) => t.slot === params[0]).map((t) => t.transaction.signatures[0])] };
    if (method === "getAccountInfo") {
      const k = params[0];
      if (k === SOL) return { value: { owner: accounts.mint0.owner, data: [accounts.mint0.data, "base64"] } };
      if (k === BAYLA) return { value: { owner: accounts.mint1.owner, data: [accounts.mint1.data, "base64"] } };
      return { value: null };
    }
    throw new Error(`unexpected ${method}`);
  });
  return { rpc, calls };
}
const req = (endpoint, query = {}, headers = {}) => ({ method: "GET", query: { resource: "gt", endpoint, ...query }, headers });
function res() {
  const r = { statusCode: null, body: null, headers: {} };
  r.setHeader = (h, v) => { r.headers[h] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.body = p; return r; };
  return r;
}
const allow = async () => true;

describe("the four endpoints", () => {
  beforeEach(() => __reset());

  it("/latest-block: the newest finalized slot with a time, stepping back over a skipped slot, never cached", async () => {
    const c = chain({ tip: 466_420_000, skipSlots: [466_420_000] });
    const r = res();
    await handleGeckoTerminal(req("latest-block"), r, { rpc: c.rpc, checkRateLimit: allow });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ block: { blockNumber: 466_419_999, blockTimestamp: 1_794_000_999 } });
    expect(r.headers["Cache-Control"]).toBe("no-store");
    expect(await latestBlock(c.rpc)).toEqual({ blockNumber: 466_419_999, blockTimestamp: 1_794_000_999 });
  });

  it("/pair: the pool's two coins in the pool's order, its 100 bps fee, and when it opened", async () => {
    const c = chain();
    const r = res();
    await handleGeckoTerminal(req("pair", { id: POOL }), r, { rpc: c.rpc, checkRateLimit: allow });
    expect(r.statusCode).toBe(200);
    expect(r.body.pair).toEqual({ id: POOL, dexKey: DEX_KEY, asset0Id: SOL, asset1Id: BAYLA, feeBps: 100, createdAtBlockNumber: 466405061, createdAtBlockTimestamp: 1794031517, createdAtTxnId: swapTx.transaction.signatures[0] });
    const miss = res();
    await handleGeckoTerminal(req("pair", { id: PAYER }), miss, { rpc: c.rpc, checkRateLimit: allow });
    expect(miss.statusCode).toBe(404);
    const bad = res();
    await handleGeckoTerminal(req("pair", { id: "not-an-address" }), bad, { rpc: c.rpc, checkRateLimit: allow });
    expect(bad.statusCode).toBe(400);
  });

  it("/asset: decimals and supply from the mint, the name from its own metadata; SOL and USDC by name", async () => {
    const c = chain();
    const r = res();
    await handleGeckoTerminal(req("asset", { id: BAYLA }), r, { rpc: c.rpc, checkRateLimit: allow });
    expect(r.statusCode).toBe(200);
    expect(r.body.asset).toMatchObject({ id: BAYLA, decimals: 6, totalSupply: "985081282.555694", symbol: expect.stringMatching(/BAYLA/i) });
    const sol = res();
    await handleGeckoTerminal(req("asset", { id: SOL }), sol, { rpc: c.rpc, checkRateLimit: allow });
    expect(sol.body.asset).toMatchObject({ id: SOL, name: "Wrapped SOL", symbol: "SOL", decimals: 9, coinGeckoId: "wrapped-solana" });
    expect(sol.body.asset).not.toHaveProperty("totalSupply");
    const none = res();
    await handleGeckoTerminal(req("asset", { id: PAYER }), none, { rpc: c.rpc, checkRateLimit: allow });
    expect(none.statusCode).toBe(404);
  });

  it("/events: every event in the slots asked for, inclusive, in block order, with each transaction's place in its block", async () => {
    const c = chain();
    const r = res();
    await handleGeckoTerminal(req("events", { fromBlock: "466405061", toBlock: "466405274" }), r, { rpc: c.rpc, checkRateLimit: allow });
    expect(r.statusCode).toBe(200);
    expect(r.body.events.map((e) => [e.eventType, e.block.blockNumber, e.txnIndex, e.eventIndex])).toEqual([["swap", 466405061, 2, 0], ["join", 466405274, 2, 0]]);
    expect(r.headers["Cache-Control"]).toBe("s-maxage=86400");
    // The slots past toBlock are left out; a range that reaches the tip is not cached.
    const live = res();
    await handleGeckoTerminal(req("events", { fromBlock: "466411767", toBlock: "466419990" }), live, { rpc: c.rpc, checkRateLimit: allow });
    expect(live.body.events.map((e) => e.eventType)).toEqual(["exit"]);
    expect(live.headers["Cache-Control"]).toBe("no-store");
    const empty = res();
    await handleGeckoTerminal(req("events", { fromBlock: "1", toBlock: "100" }), empty, { rpc: c.rpc, checkRateLimit: allow });
    expect(empty.body).toEqual({ events: [] });
  });

  it("/events: walks the signature pages back only as far as fromBlock", async () => {
    const c = chain();
    expect((await signaturesIn(c.rpc, 466405274, 466411767)).map((s) => s.slot)).toEqual([466405274, 466411767]);
    expect(await eventsIn(c.rpc, 466405275, 466411766)).toEqual([]);
  });

  it("/events: refuses bad slots and a range too wide, and says when a chunk holds too many transactions", async () => {
    const c = chain();
    for (const q of [{ fromBlock: "x", toBlock: "5" }, { fromBlock: "10", toBlock: "5" }, { fromBlock: "1", toBlock: "60000" }, {}]) {
      const r = res();
      await handleGeckoTerminal(req("events", q), r, { rpc: c.rpc, checkRateLimit: allow });
      expect(r.statusCode).toBe(400);
    }
    const many = chain({ txs: Array.from({ length: MAX_TXS_PER_CALL + 1 }, (_, i) => ({ ...swapTx, slot: 466405061 + i, transaction: { ...swapTx.transaction, signatures: [`sig${i}`] } })) });
    const r = res();
    await handleGeckoTerminal(req("events", { fromBlock: "466405061", toBlock: "466405200" }), r, { rpc: many.rpc, checkRateLimit: allow });
    expect(r.statusCode).toBe(502);
    expect(r.body.error).toMatch(/smaller chunk/);
  });

  it("a chain that cannot be read is a 502 with no detail, so the indexer retries", async () => {
    const rpc = vi.fn(async () => { throw new Error("https://user:secret@rpc.example/ down"); });
    const r = res();
    await handleGeckoTerminal(req("latest-block"), r, { rpc, checkRateLimit: allow });
    expect(r.statusCode).toBe(502);
    expect(JSON.stringify(r.body)).not.toMatch(/secret/);
  });

  it("GET only, a real endpoint name only, and the origin gate: a server with no Origin passes, a strange site does not", async () => {
    const c = chain();
    const post = res();
    await handleGeckoTerminal({ ...req("latest-block"), method: "POST" }, post, { rpc: c.rpc, checkRateLimit: allow });
    expect(post.statusCode).toBe(405);
    const unknown = res();
    await handleGeckoTerminal(req("blocks"), unknown, { rpc: c.rpc, checkRateLimit: allow });
    expect(unknown.statusCode).toBe(404);
    // The gate fails closed only on a production-like deploy (aggregator-proxy.js isProdLikeEnv).
    const was = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = "production";
    try {
      const foreign = res();
      await handleGeckoTerminal(req("latest-block", {}, { origin: "https://evil.example" }), foreign, { rpc: c.rpc, checkRateLimit: allow });
      expect(foreign.statusCode).toBe(403);
      const indexer = res();
      await handleGeckoTerminal(req("latest-block"), indexer, { rpc: c.rpc, checkRateLimit: allow });
      expect(indexer.statusCode).toBe(200);
    } finally {
      if (was === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = was;
    }
    expect(c.calls.filter((m) => m !== "getSlot" && m !== "getBlockTime")).toEqual([]);
  });

  it("reads the pool list once a minute, not per call", async () => {
    const c = chain();
    for (const q of [{ fromBlock: "1", toBlock: "10" }, { fromBlock: "11", toBlock: "20" }]) await handleGeckoTerminal(req("events", q), res(), { rpc: c.rpc, checkRateLimit: allow });
    expect(c.calls.filter((m) => m === "getProgramAccounts")).toHaveLength(1);
  });
});

describe("the route", () => {
  it("vercel.json sends /api/gt/:endpoint to the catchall's gt resource, before the page catch-all; the catchall branch sits above the provider line", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const rewrites = JSON.parse(readFileSync(join(here, "..", "..", "vercel.json"), "utf8")).rewrites;
    const at = rewrites.findIndex((r) => r.source === "/api/gt/:endpoint");
    expect(rewrites[at]?.destination).toBe("/api/aggregator?resource=gt&endpoint=:endpoint");
    expect(at).toBeLessThan(rewrites.findIndex((r) => r.source === "/((?!api/).*)"));
    const src = readFileSync(join(here, "..", "aggregator.js"), "utf8");
    expect(src.indexOf('req.query.resource === "gt"')).toBeGreaterThan(0);
    expect(src.indexOf('req.query.resource === "gt"')).toBeLessThan(src.indexOf("const provider = req.query.provider"));
  });
});
