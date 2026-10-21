// @vitest-environment node
// The range position link, `/position/:id.json`.
//
// Every position NFT keeps this link forever, so the tests that matter most are about the
// ways it ships broken: swallowed by the SPA fallback (200 HTML forever), a link format that
// drifts from what the program writes, a layout that drifts from the program's, and a 404
// for a read that merely failed (a wallet keeps a 404).

import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

import {
  AMM_CONFIG,
  PERSONAL_POSITION,
  PLACEHOLDER_PROGRAM_ID,
  POOL_STATE,
  POSITION_IMAGE,
  POSITION_NAME,
  POSITION_SYMBOL,
  RANGE_PROGRAM_ID,
  base58,
  buildPositionMetadata,
  decodePool,
  decodePosition,
  decodeTradeFeeRate,
  feePercent,
  handlePosition,
  isAddress,
  priceAtTick,
  resolveId,
} from "../_lib/position.js";

const FE = process.cwd();
const CLMM = resolve(FE, "..", "solana", "tegridy-clmm", "programs", "amm", "src");
const rust = (rel) => readFileSync(join(CLMM, rel), "utf8");

function mockRes() {
  return {
    statusCode: 0,
    body: undefined,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    end() {
      return this;
    },
  };
}
const req = (query, method = "GET") => ({ method, headers: {}, query });

afterEach(() => {
  vi.unstubAllGlobals();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the routing contract: the SPA fallback would otherwise eat this route", () => {
  const vercel = JSON.parse(readFileSync(join(FE, "vercel.json"), "utf8"));
  function sourceToRegex(source) {
    if (/^\/\(\(\?!/.test(source)) return new RegExp("^" + source + "$");
    const body = source
      .split(/(:[A-Za-z_]+\*?)/)
      .map((part) => {
        if (/^:[A-Za-z_]+\*$/.test(part)) return "(.*)";
        if (/^:[A-Za-z_]+$/.test(part)) return "([^/]+?)";
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("");
    return new RegExp("^" + body + "$");
  }
  const first = (url) => vercel.rewrites.findIndex((r) => sourceToRegex(r.source).test(url));
  const spa = () => vercel.rewrites.findIndex((r) => r.destination === "/index.html");

  it("a position link, and any malformed /position/ path, reaches the function before the SPA fallback", () => {
    for (const url of ["/position/HmP3ZyJdbJmeYdCQEDdMr8eAeVw3hYm4KNCRtPgwhQ1g.json", "/position/", "/position/abc", "/position/a/b.json"]) {
      const idx = first(url);
      expect(idx, url).toBeGreaterThanOrEqual(0);
      expect(idx, `${url} fell through to the SPA shell`).toBeLessThan(spa());
      expect(vercel.rewrites[idx].destination).toContain("resource=position");
    }
    expect(vercel.rewrites.find((r) => r.source === "/position/:id.json").destination).toContain("id=:id");
  });

  it("is cross-origin readable, with CORS from code only, and its picture is too", () => {
    const block = vercel.headers.find((h) => h.source === "/position/(.*)");
    expect(block.headers).toContainEqual({ key: "Cross-Origin-Resource-Policy", value: "cross-origin" });
    expect(block.headers.some((h) => h.key === "Access-Control-Allow-Origin")).toBe(false);
    const art = vercel.headers.find((h) => h.source === new URL(POSITION_IMAGE).pathname);
    expect(art.headers).toContainEqual({ key: "Cross-Origin-Resource-Policy", value: "cross-origin" });
    // The picture is a real file the site ships.
    expect(readFileSync(join(FE, "public", new URL(POSITION_IMAGE).pathname)).length).toBeGreaterThan(1000);
  });

  it("is not in middleware's matcher, and its branch sits above `const provider` in the catchall", () => {
    expect(readFileSync(join(FE, "middleware.js"), "utf8")).not.toContain("/position");
    const src = readFileSync(join(FE, "api", "aggregator.js"), "utf8");
    const branch = src.indexOf('req.query.resource === "position"');
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(src.indexOf("const provider = req.query.provider"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("held to the program source", () => {
  it("the program id is the program's declare_id!", () => {
    const lib = rust("lib.rs");
    const declared = /#\[cfg\(not\(feature = "devnet"\)\)\]\s*declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/.exec(lib);
    expect(declared?.[1]).toBe(RANGE_PROGRAM_ID);
    expect(RANGE_PROGRAM_ID).toBe(PLACEHOLDER_PROGRAM_ID);
  });

  it("the NFT's name, symbol and link are what the program writes, keyed by the position's record", () => {
    const src = rust("instructions/open_position.rs");
    const fn = /fn get_metadata_data\(personal_position_id: Pubkey\)[\s\S]*?\n\}/.exec(src)[0];
    expect(fn).toContain(`String::from("${POSITION_NAME}")`);
    expect(fn).toContain(`String::from("${POSITION_SYMBOL}")`);
    expect(fn).toMatch(/"https:\/\/memetics\.finance\/position\/\{\}\.json",\s*personal_position_id\.to_string\(\)/);
    expect(src).toContain("get_metadata_data(personal_position.key())");
  });

  /** Offsets of the fields read here, recomputed from the Rust struct. */
  function offsets(file, struct, start) {
    const body = new RegExp(`pub struct ${struct}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(rust(file))[1].replace(/\/\/[^\n]*/g, "");
    const width = (t) => {
      const prim = { u8: 1, bool: 1, u16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, Pubkey: 32 };
      if (prim[t] !== undefined) return prim[t];
      const arr = /^\[(.+);\s*([A-Z_0-9]+)\s*\]$/.exec(t);
      const n = { REWARD_NUM: 3 }[arr?.[2]] ?? Number(arr?.[2]);
      if (arr && Number.isInteger(n)) return width(arr[1].trim()) * n;
      if (t === "RewardInfo") return 169;
      if (t === "PositionRewardInfo") return 24;
      if (t === "DynamicFeeInfo") return 80;
      throw new Error(`unhandled type ${t}`);
    };
    const out = {};
    let o = start;
    for (const f of body.matchAll(/pub\s+([a-z_0-9]+)\s*:\s*([^,]+),/g)) {
      out[f[1]] = o;
      o += width(f[2].trim());
    }
    return { ...out, total: o };
  }
  const disc = (name) => [...createHash("sha256").update(`account:${name}`).digest().subarray(0, 8)];

  it("PersonalPositionState, PoolState and AmmConfig layouts", () => {
    const pos = offsets("states/personal_position.rs", "PersonalPositionState", 8);
    expect([pos.pool_id, pos.tick_lower_index, pos.tick_upper_index, pos.liquidity, pos.total]).toEqual([
      PERSONAL_POSITION.poolId, PERSONAL_POSITION.tickLower, PERSONAL_POSITION.tickUpper, PERSONAL_POSITION.liquidity, PERSONAL_POSITION.len,
    ]);
    const pool = offsets("states/pool.rs", "PoolState", 8);
    expect([pool.amm_config, pool.token_mint_0, pool.token_mint_1, pool.mint_decimals_0, pool.mint_decimals_1, pool.tick_spacing, pool.total]).toEqual([
      POOL_STATE.ammConfig, POOL_STATE.mint0, POOL_STATE.mint1, POOL_STATE.decimals0, POOL_STATE.decimals1, POOL_STATE.tickSpacing, POOL_STATE.len,
    ]);
    const cfg = offsets("states/config.rs", "AmmConfig", 8);
    expect([cfg.trade_fee_rate, cfg.total]).toEqual([AMM_CONFIG.tradeFeeRate, AMM_CONFIG.len]);
    expect(PERSONAL_POSITION.disc).toEqual(disc("PersonalPositionState"));
    expect(POOL_STATE.disc).toEqual(disc("PoolState"));
    expect(AMM_CONFIG.disc).toEqual(disc("AmmConfig"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
const FIX = JSON.parse(readFileSync(join(FE, "api", "__tests__", "__fixtures__", "range-position-mainnet.json"), "utf8"));
const bytes = (gz) => Uint8Array.from(gunzipSync(Buffer.from(gz, "base64")));

describe("real accounts of the live range program whose layout the venue's copy shares", () => {
  const position = decodePosition(bytes(FIX.position.gz));
  const pool = decodePool(bytes(FIX.pool.gz));
  const fee = decodeTradeFeeRate(bytes(FIX.config.gz));

  it("decode, and agree with each other", () => {
    expect(position.poolId).toBe(FIX.pool.address);
    expect(pool.ammConfig).toBe(FIX.config.address);
    expect(position.tickLower).toBeLessThan(position.tickUpper);
    expect(Math.abs(position.tickLower % pool.tickSpacing)).toBe(0);
    expect(Math.abs(position.tickUpper % pool.tickSpacing)).toBe(0);
    expect(position.liquidity > 0n).toBe(true);
    expect(pool.mint0).toBe("So11111111111111111111111111111111111111112");
    expect([pool.decimals0, pool.decimals1, pool.tickSpacing, fee]).toEqual([9, 6, 120, 10000]);
  });

  it("make a document with the pool, the coins, the range in prices and the fee", () => {
    const doc = buildPositionMetadata({ id: FIX.position.address, position, pool, tradeFeeRate: fee });
    expect(doc.name).toBe(POSITION_NAME);
    expect(doc.symbol).toBe(POSITION_SYMBOL);
    expect(doc.image).toBe(POSITION_IMAGE);
    expect(doc.description).toContain("pool of SOL and 98kf…pump, from ");
    expect(doc.description).toContain("1% swap fee");
    expect(doc.description).toContain("outside it, it earns nothing");
    expect(doc.description).not.toMatch(/—/);
    const attr = Object.fromEntries(doc.attributes.map((a) => [a.trait_type, a.value]));
    expect(attr.Pool).toBe(FIX.pool.address);
    expect(attr["Lower tick"]).toBe(position.tickLower);
    expect(attr.Liquidity).toBe(position.liquidity.toString());
    expect(attr["Lowest price"]).toMatch(/^[0-9.e+-]+ 98kf…pump per SOL$/);
    expect(Number(attr["Lowest price"].split(" ")[0])).toBeLessThan(Number(attr["Highest price"].split(" ")[0]));
  });
});

describe("numbers are never written as zero", () => {
  it("a tiny price keeps its digits", () => {
    expect(priceAtTick(-400000, 9, 6)).toMatch(/e-/);
    expect(priceAtTick(-400000, 9, 6)).not.toBe("0");
    expect(priceAtTick(0, 6, 6)).toBe("1");
  });
  it("fees as exact percents", () => {
    expect([feePercent(10000), feePercent(2500), feePercent(100), feePercent(400000)]).toEqual(["1%", "0.25%", "0.01%", "40%"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("which link is asked for", () => {
  const id = FIX.position.address;
  it("takes the id from either rewrite, with or without .json", () => {
    expect(resolveId({ id })).toBe(id);
    expect(resolveId({ id: `${id}.json` })).toBe(id);
    expect(resolveId({ path: `${id}.json` })).toBe(id);
  });
  it("refuses arrays, extra segments and strings that are not 32-byte addresses", () => {
    expect(resolveId({ id: [id, id] })).toBeNull();
    expect(resolveId({ path: `a/${id}.json` })).toBeNull();
    expect(resolveId({ id: "0xabc" })).toBeNull();
    expect(resolveId({ id: "1111" })).toBeNull();
    expect(isAddress("11111111111111111111111111111111")).toBe(true);
    expect(base58(new Uint8Array(32))).toBe("11111111111111111111111111111111");
  });
});

describe("the handler", () => {
  const OURS = base58(randomBytes(32)); // a stand-in id for "our program, deployed"
  const id = FIX.position.address;
  /** An RPC that answers getMultipleAccounts from a table, as if `OURS` owned the recording. */
  function stubAccounts(table, { fail = false } = {}) {
    const fetch = vi.fn(async (_url, init) => {
      if (fail) return { ok: false, status: 502, json: async () => ({}) };
      const body = JSON.parse(init.body);
      expect(body.method).toBe("getMultipleAccounts");
      const value = body.params[0].map((a) => (table[a] ? { owner: table[a].owner, lamports: 1, data: [Buffer.from(table[a].data).toString("base64"), "base64"] } : null));
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value } }) };
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }
  const table = (owner = OURS) => ({
    [FIX.position.address]: { owner, data: bytes(FIX.position.gz) },
    [FIX.pool.address]: { owner, data: bytes(FIX.pool.gz) },
    [FIX.config.address]: { owner, data: bytes(FIX.config.gz) },
  });

  it("while the program id is the placeholder, every link is a 404, and the chain is not asked", async () => {
    const fetch = stubAccounts(table());
    const res = mockRes();
    await handlePosition(req({ id }), res);
    expect(res.statusCode).toBe(404);
    expect(res.headers["Content-Type"]).toContain("application/json");
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(fetch).not.toHaveBeenCalled();
    // It names the program it serves: a check against the deployed id sees the placeholder.
    expect(res.body.program).toBe(PLACEHOLDER_PROGRAM_ID);
  });

  it("a deployed program's position answers 200 JSON, publicly, with a short edge cache", async () => {
    stubAccounts(table());
    const res = mockRes();
    await handlePosition(req({ id: `${id}.json` }), res, { programId: OURS });
    expect(res.statusCode).toBe(200);
    expect(res.body.name).toBe(POSITION_NAME);
    expect(res.body.position).toBe(id);
    expect(res.headers["Cache-Control"]).toBe("s-maxage=60, stale-while-revalidate=600");
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("an address with no account is a 404 cached for seconds only: a position may be a moment old", async () => {
    stubAccounts({});
    const res = mockRes();
    await handlePosition(req({ id }), res, { programId: OURS });
    expect(res.statusCode).toBe(404);
    expect(res.headers["Cache-Control"]).toBe("s-maxage=15");
    // Exactly this body: the deploy pack's page asks a random address and checks both fields
    // before every fee-tier approval, so a link serving any other program is refused there.
    expect(res.body).toEqual({ error: "No range position at this address.", program: OURS });
  });

  it("an account another program owns is not a position here", async () => {
    stubAccounts(table("11111111111111111111111111111111"));
    const res = mockRes();
    await handlePosition(req({ id }), res, { programId: OURS });
    expect(res.statusCode).toBe(404);
    expect(res.body.program).toBe(OURS);
  });

  it("a failed read is a 503 that is never cached, and never a document with gaps", async () => {
    stubAccounts(table(), { fail: true });
    const res = mockRes();
    await handlePosition(req({ id }), res, { programId: OURS });
    expect(res.statusCode).toBe(503);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    const missingPool = table();
    delete missingPool[FIX.pool.address];
    stubAccounts(missingPool);
    const res2 = mockRes();
    await handlePosition(req({ id }), res2, { programId: OURS });
    expect(res2.statusCode).toBe(503);
  });

  it("refuses a malformed link, other methods, and answers a preflight", async () => {
    const bad = mockRes();
    await handlePosition(req({ id: "not-an-address" }), bad, { programId: OURS });
    expect(bad.statusCode).toBe(400);
    const post = mockRes();
    await handlePosition(req({ id }, "POST"), post, { programId: OURS });
    expect(post.statusCode).toBe(405);
    const pre = mockRes();
    await handlePosition(req({ id }, "OPTIONS"), pre, { programId: OURS });
    expect(pre.statusCode).toBe(200);
  });
});
