// ?resource=venue-tvl: what our pools hold on every chain, for the home page. The rules under
// test are the ones a visitor relies on: only SOL, USDC, BAYLA and ETH add dollars (so a pile
// of worthless pools adds nothing), a range pool's own price is never trusted, a chain that
// cannot be read is named and left out instead of counted as zero, and a good answer is
// cached so a visitor costs the chains nothing.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { base58 } from "@scure/base";
import { EVM_CHAINS } from "../../../scripts/lib/venue-volume-chain.mjs";
import { POOL_DISCRIMINATOR_B58, POOL_STATE_LEN } from "../pool-index.js";
import { RANGE_PROGRAM_ADDRESS } from "../../../src/lib/solana/clmm/programId.ts";
import { ACCOUNT_POOL_STATE, POOL_STATE_LEN as RANGE_LEN_TS, POOL_STATE_OFFSETS } from "../../../src/lib/solana/clmm/program.ts";

vi.mock("../ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

const { handleVenueTvl, readVenueTvl, __resetVenueTvl, RANGE_PROGRAM, RANGE_POOL_LEN, RANGE_OFFSETS, SOLANA_PROGRAMS } = await import("../venueTvl.js");

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BAYLA = "7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const key = (n) => base58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 7)));
const JUNK = key(1);
const MEME = key(2);
const [CP, RANGE] = SOLANA_PROGRAMS;
const NOW = Date.parse("2026-10-25T02:00:00Z");

/** A fake world: Solana pools and vaults, EVM pairs, and two price quotes. */
function world() {
  const w = { pools: { [CP.program]: [], [RANGE.program]: [] }, vaults: new Map(), pairs: {}, sol: 100, eth: 2000, down: new Set(), calls: [] };
  let n = 10;
  w.pool = (layout, [mint0, amount0], [mint1, amount1]) => {
    const d = Buffer.alloc(layout.size);
    Buffer.from(base58.decode(POOL_DISCRIMINATOR_B58)).copy(d, 0);
    const vault0 = key(n++);
    const vault1 = key(n++);
    for (const [at, k] of [[layout.mint0, mint0], [layout.mint1, mint1], [layout.vault0, vault0], [layout.vault1, vault1]]) Buffer.from(base58.decode(k)).copy(d, at);
    w.pools[layout.program].push({ pubkey: key(n++), data: d });
    const dec = (m) => (m === SOL ? 9 : 6);
    w.vaults.set(vault0, { owner: mint0 === BAYLA ? TOKEN22 : TOKEN, mint: mint0, amount: BigInt(Math.round(amount0 * 10 ** dec(mint0))), decimals: dec(mint0) });
    w.vaults.set(vault1, { owner: mint1 === BAYLA ? TOKEN22 : TOKEN, mint: mint1, amount: BigInt(Math.round(amount1 * 10 ** dec(mint1))), decimals: dec(mint1) });
    return { vault0, vault1 };
  };
  const json = (body) => new Response(JSON.stringify(body), { status: 200 });
  const word = (v) => BigInt(v).toString(16).padStart(64, "0");
  const chainOf = new Map(Object.entries(EVM_CHAINS).flatMap(([name, c]) => c.rpcs.map((u) => [u, name])));
  w.fetchImpl = vi.fn(async (url, init = {}) => {
    const u = String(url);
    if (u.includes("coinbase.com")) return json({ data: { amount: String(u.includes("SOL") ? w.sol : w.eth) } });
    if (u.includes("coingecko.com")) return json(u.includes("solana") ? { solana: { usd: w.sol } } : { ethereum: { usd: w.eth } });
    const body = JSON.parse(init.body);
    w.calls.push(body.method);
    if (u === "https://sol.test") {
      if (w.down.has("solana")) return new Response("busy", { status: 503 });
      if (body.method === "getProgramAccounts") {
        const [program, { dataSlice, filters }] = body.params;
        expect(filters).toContainEqual({ memcmp: { offset: 0, bytes: POOL_DISCRIMINATOR_B58 } });
        const size = filters.find((f) => f.dataSize).dataSize;
        return json({
          result: w.pools[program]
            .filter((p) => p.data.length === size)
            .map((p) => ({ pubkey: p.pubkey, account: { data: [p.data.subarray(dataSlice.offset, dataSlice.offset + dataSlice.length).toString("base64"), "base64"] } })),
        });
      }
      if (body.method === "getMultipleAccounts") {
        return json({
          result: {
            value: body.params[0].map((k) => {
              const v = w.vaults.get(k);
              return v ? { owner: v.owner, data: { parsed: { info: { mint: v.mint, tokenAmount: { amount: String(v.amount), decimals: v.decimals } } } } } : null;
            }),
          },
        });
      }
    }
    const chain = chainOf.get(u);
    if (chain && body.method === "eth_call") {
      if (w.down.has(chain)) return new Response("busy", { status: 503 });
      const { to, data } = body.params[0];
      const c = EVM_CHAINS[chain];
      const pairs = w.pairs[chain] ?? [];
      if (to === c.factory && data === "0x574f2ba3") return json({ result: "0x" + word(pairs.length) });
      if (to === c.factory && data.startsWith("0x1e3dd18b")) return json({ result: "0x" + word(BigInt(pairs[Number("0x" + data.slice(10))].address)) });
      const pair = pairs.find((p) => p.address === to);
      if (pair && data === "0x0dfe1681") return json({ result: "0x" + word(BigInt(pair.t0)) });
      if (pair && data === "0xd21220a7") return json({ result: "0x" + word(BigInt(pair.t1)) });
      if (pair && data === "0x0902f1ac") return json({ result: "0x" + word(pair.r0) + word(pair.r1) + word(0) });
    }
    return new Response("not found", { status: 404 });
  });
  return w;
}
const pair = (address, t0, t1, r0, r1) => ({ address, t0, t1, r0, r1 });
const chain = (body, name) => body.chains.find((c) => c.chain === name);

beforeEach(() => {
  __resetVenueTvl();
  process.env.SOLANA_RPC_URL = "https://sol.test";
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.SOLANA_RPC_URL;
  vi.restoreAllMocks();
});

describe("the range-pool program, as copied from src/lib/solana/clmm", () => {
  it("is the deployed program, with its PoolState size, mints, vaults and discriminator", () => {
    expect(RANGE_PROGRAM).toBe(RANGE_PROGRAM_ADDRESS);
    expect(RANGE_POOL_LEN).toBe(RANGE_LEN_TS);
    expect(RANGE_OFFSETS).toEqual({
      tokenMint0: POOL_STATE_OFFSETS.tokenMint0,
      tokenMint1: POOL_STATE_OFFSETS.tokenMint1,
      tokenVault0: POOL_STATE_OFFSETS.tokenVault0,
      tokenVault1: POOL_STATE_OFFSETS.tokenVault1,
    });
    // One discriminator filter serves both programs: both name the account PoolState.
    expect(base58.encode(ACCOUNT_POOL_STATE)).toBe(POOL_DISCRIMINATOR_B58);
    expect(CP.size).toBe(POOL_STATE_LEN);
  });
});

describe("Solana: only SOL, USDC and BAYLA add dollars", () => {
  it("values a pool at twice its top coin, and BAYLA at its price in our deepest BAYLA/SOL pool", async () => {
    const w = world();
    w.pool(CP, [SOL, 2], [MEME, 1_000_000]); // 2 SOL: $400
    w.pool(CP, [USDC, 50], [MEME, 9_000]); // 50 USDC: $100
    w.pool(CP, [SOL, 10], [BAYLA, 1_000]); // the deepest BAYLA/SOL: BAYLA = $1; the pool itself $2,000
    w.pool(CP, [SOL, 1], [BAYLA, 10]); // a shallow one quoting BAYLA at $10, never used for its price
    w.pool(CP, [BAYLA, 30], [MEME, 5]); // 30 BAYLA: $60
    const body = await readVenueTvl({ fetchImpl: w.fetchImpl, now: NOW });
    expect(chain(body, "solana")).toEqual({ chain: "solana", read: true, usd: 2760, pools: 5, unvalued: 0 });
  });

  it("adds nothing for a pool that holds no coin, and does not read its vaults", async () => {
    const w = world();
    const junk = w.pool(CP, [JUNK, 1e12], [MEME, 1e12]);
    w.pool(CP, [SOL, 1], [MEME, 5]);
    const body = await readVenueTvl({ fetchImpl: w.fetchImpl, now: NOW });
    expect(chain(body, "solana")).toMatchObject({ read: true, usd: 200, pools: 1 });
    const asked = w.fetchImpl.mock.calls.filter(([, i]) => i?.body?.includes("getMultipleAccounts")).flatMap(([, i]) => JSON.parse(i.body).params[0]);
    expect(asked).not.toContain(junk.vault0);
    expect(asked).not.toContain(junk.vault1);
  });

  it("counts a range pool's coins only, never its other side at the pool's own price", async () => {
    const w = world();
    w.pool(RANGE, [SOL, 3], [JUNK, 1e9]); // 3 SOL: $300, whatever the junk is "worth"
    w.pool(RANGE, [SOL, 1], [USDC, 40]); // both sides coins: $140
    const body = await readVenueTvl({ fetchImpl: w.fetchImpl, now: NOW });
    expect(chain(body, "solana")).toMatchObject({ read: true, usd: 440, pools: 2 });
  });

  it("leaves out the pools BAYLA would value when no pool gives BAYLA a price, and says so", async () => {
    const w = world();
    w.pool(CP, [SOL, 1], [MEME, 5]);
    w.pool(CP, [BAYLA, 30], [MEME, 5]);
    const body = await readVenueTvl({ fetchImpl: w.fetchImpl, now: NOW });
    expect(chain(body, "solana")).toMatchObject({ read: true, usd: 200, pools: 1, unvalued: 1 });
    expect(body.state).toBe("partial");
  });

  it("reads a vault that does not hold its coin as unread, never as a number", async () => {
    const w = world();
    const { vault0 } = w.pool(CP, [SOL, 1], [MEME, 5]);
    w.vaults.set(vault0, { ...w.vaults.get(vault0), mint: JUNK });
    const body = await readVenueTvl({ fetchImpl: w.fetchImpl, now: NOW });
    expect(chain(body, "solana")).toEqual({ chain: "solana", read: false });
    w.vaults.set(vault0, { ...w.vaults.get(vault0), mint: SOL, owner: TOKEN22 });
    __resetVenueTvl();
    expect(chain(await readVenueTvl({ fetchImpl: w.fetchImpl, now: NOW }), "solana")).toEqual({ chain: "solana", read: false });
  });
});

describe("Ethereum, Base and Robinhood: our factory's pairs, at twice their WETH", () => {
  it("values a pair at twice its WETH, on either side, and a pair with no WETH at nothing", async () => {
    const w = world();
    const weth = EVM_CHAINS.base.weth.toLowerCase();
    w.pairs.base = [
      pair("0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000c1", weth, 10n ** 24n, 5n * 10n ** 17n), // 0.5 WETH: $2,000
      pair("0x00000000000000000000000000000000000000a2", weth, "0x00000000000000000000000000000000000000c2", 10n ** 17n, 10n ** 30n), // 0.1 WETH: $400
      pair("0x00000000000000000000000000000000000000a3", "0x00000000000000000000000000000000000000c3", "0x00000000000000000000000000000000000000c4", 10n ** 30n, 10n ** 30n),
    ];
    const body = await readVenueTvl({ fetchImpl: w.fetchImpl, now: NOW });
    expect(chain(body, "base")).toEqual({ chain: "base", read: true, usd: 2400, pools: 2, unvalued: 0 });
    expect(chain(body, "robinhood")).toMatchObject({ read: true, usd: 0, pools: 0 });
  });
});

describe("the total: every chain, or it says which it is missing", () => {
  it("sums the chains and is current when every chain was read", async () => {
    const w = world();
    w.pool(CP, [SOL, 2], [MEME, 1]);
    w.pairs.ethereum = [pair("0x00000000000000000000000000000000000000e1", "0x00000000000000000000000000000000000000f1", EVM_CHAINS.ethereum.weth.toLowerCase(), 1n, 10n ** 17n)];
    const body = await readVenueTvl({ fetchImpl: w.fetchImpl, now: NOW });
    expect(body).toMatchObject({ state: "current", usd: 800, readAt: new Date(NOW).toISOString() });
    expect(body.chains.map((c) => c.chain)).toEqual(["solana", "ethereum", "base", "robinhood"]);
  });

  it("is partial when a chain cannot be read: that chain is named, with no number", async () => {
    const w = world();
    w.pool(CP, [SOL, 2], [MEME, 1]);
    w.down.add("base");
    const body = await readVenueTvl({ fetchImpl: w.fetchImpl, now: NOW });
    expect(body).toMatchObject({ state: "partial", usd: 400 });
    expect(chain(body, "base")).toEqual({ chain: "base", read: false });
  });

  it("is unread, with no number at all, when no chain could be read", async () => {
    const w = world();
    for (const c of ["solana", "ethereum", "base", "robinhood"]) w.down.add(c);
    expect(await readVenueTvl({ fetchImpl: w.fetchImpl, now: NOW })).toEqual({ state: "unread" });
  });

  it("reads Solana as unread, not zero, when the SOL price cannot be read", async () => {
    const w = world();
    w.pool(CP, [SOL, 2], [MEME, 1]);
    w.sol = 0;
    const body = await readVenueTvl({ fetchImpl: w.fetchImpl, now: NOW });
    expect(chain(body, "solana")).toEqual({ chain: "solana", read: false });
  });
});

function makeReq(origin = "https://tegridyfarms.vercel.app") {
  return { method: "GET", query: { resource: "venue-tvl" }, headers: { origin } };
}
function makeRes() {
  const headers = {};
  const out = { status: 0, body: undefined, headers };
  const res = {
    setHeader: (k, v) => ((headers[k] = v), res),
    status: (c) => ((out.status = c), res),
    json: (b) => ((out.body = b), res),
    end: () => res,
  };
  return { res, out };
}

describe("handleVenueTvl", () => {
  it("serves a whole answer with a minute's edge cache, and reads the chains once a minute", async () => {
    const w = world();
    w.pool(CP, [SOL, 2], [MEME, 1]);
    const first = makeRes();
    await handleVenueTvl(makeReq(), first.res, { fetchImpl: w.fetchImpl, nowMs: NOW });
    expect(first.out.status).toBe(200);
    expect(first.out.body).toMatchObject({ state: "current", usd: 400 });
    expect(first.out.headers["Cache-Control"]).toMatch(/s-maxage=60/);
    const reads = w.calls.length;
    const again = makeRes();
    await handleVenueTvl(makeReq(), again.res, { fetchImpl: w.fetchImpl, nowMs: NOW + 59_000 });
    expect(again.out.body).toEqual(first.out.body);
    expect(w.calls.length).toBe(reads);
    await handleVenueTvl(makeReq(), makeRes().res, { fetchImpl: w.fetchImpl, nowMs: NOW + 61_000 });
    expect(w.calls.length).toBeGreaterThan(reads);
  });

  it("caches a partial answer for 15 seconds only, and an unread one is a 502 with no number", async () => {
    const w = world();
    w.down.add("base");
    const partial = makeRes();
    await handleVenueTvl(makeReq(), partial.res, { fetchImpl: w.fetchImpl, nowMs: NOW });
    expect(partial.out.body.state).toBe("partial");
    expect(partial.out.headers["Cache-Control"]).toMatch(/s-maxage=15$/);
    __resetVenueTvl();
    for (const c of ["solana", "ethereum", "robinhood"]) w.down.add(c);
    const unread = makeRes();
    await handleVenueTvl(makeReq(), unread.res, { fetchImpl: w.fetchImpl, nowMs: NOW });
    expect(unread.out.status).toBe(502);
    expect(unread.out.body).toEqual({ state: "unread" });
  });

  it("refuses another site's page in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const w = world();
    const { res, out } = makeRes();
    await handleVenueTvl(makeReq("https://evil.example"), res, { fetchImpl: w.fetchImpl, nowMs: NOW });
    expect(out.status).toBe(403);
    expect(w.fetchImpl).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
