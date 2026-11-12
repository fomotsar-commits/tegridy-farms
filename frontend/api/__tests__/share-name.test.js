// @vitest-environment node
// The pool share name file built from chain, `/mint/:mint.json` for a share with no committed file.
//
// What matters most: the default answer stays byte for byte the file every unknown link got
// before; a share built here reads exactly like the committed files; a copy of a well-known
// coin is called a copy; and a read that failed is never the default file a wallet would keep.

import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { base58 } from "@scure/base";

vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

import { checkRateLimit } from "../_lib/ratelimit.js";
import {
  DEFAULT_BYTES,
  METAPLEX_PROGRAM,
  WELL_KNOWN_NAMES,
  claimedTicker,
  copiedWellKnownName,
  handleShareName,
  metaplexNames,
  pairOf,
  shareFile,
  token2022Names,
} from "../_lib/share-name.js";
import { CP_SWAP_PROGRAM, OFFSETS, POOL_STATE_LEN, QUOTE_COINS } from "../_lib/pool-index.js";
import { findProgramAddress } from "../_lib/launch-pins.js";
import { COINS, GENERIC_PICTURES, MINT_TOKENS, carriesOwnHash, metadataUri } from "../../scripts/lib/mint-identity.mjs";
import { WELL_KNOWN_NAMES as SITE_WELL_KNOWN, copiedWellKnownName as siteCopied, decodeMintAccount } from "../../src/lib/solana/lp/tokenSafety";
import { claimedTicker as siteClaimedTicker } from "../../src/lib/solana/lp/identity";
import { readPair } from "../../src/lib/solana/lp/quotes";

const FE = process.cwd();
const sha = (b) => createHash("sha256").update(b).digest("hex");
const committed = (mint) => readFileSync(join(FE, "public", "mint", `${mint}.json`), "utf8");
const SOL = COINS.SOL;
const USDC = COINS.USDC;
const randomMint = () => base58.encode(randomBytes(32));

function mockRes() {
  return {
    statusCode: 0,
    body: undefined,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    removeHeader(k) {
      delete this.headers[k];
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
    end() {
      return this;
    },
  };
}
const req = (query, method = "GET") => ({ method, headers: {}, query });

/** A Metaplex name record's bytes, as mpl-token-metadata lays them out (strings NUL-padded). */
function metaplexRecord(mint, name, symbol) {
  const s = (v, pad) => {
    const b = Buffer.alloc(pad);
    Buffer.from(v, "utf8").copy(b);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(pad);
    return Buffer.concat([len, b]);
  };
  return Buffer.concat([Buffer.from([4]), randomBytes(32), Buffer.from(base58.decode(mint)), s(name, 32), s(symbol, 10), s("https://x.test/a.json", 200), Buffer.alloc(40)]);
}

/** A Token-2022 mint carrying its own TokenMetadata extension. */
function token2022Mint(mint, name, symbol) {
  const s = (v) => {
    const b = Buffer.from(v, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length);
    return Buffer.concat([len, b]);
  };
  const base = Buffer.alloc(166);
  base[45] = 1;
  base[165] = 1;
  const value = Buffer.concat([randomBytes(32), Buffer.from(base58.decode(mint)), s(name), s(symbol), s("https://x.test/a.json"), Buffer.alloc(4)]);
  const tl = Buffer.alloc(4);
  tl.writeUInt16LE(19, 0);
  tl.writeUInt16LE(value.length, 2);
  return Buffer.concat([base, tl, value]);
}

const account = (owner, data) => ({ owner, data: [Buffer.from(data).toString("base64"), "base64"], lamports: 1, executable: false });

/**
 * A chain that answers the scan with `pools` (each { token0, token1 }) and the accounts in
 * `accounts` (address -> account or null). Every call it saw is in `.calls`.
 */
function chain({ pools = [], accounts = {}, fail = false } = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (fail) return { ok: false, status: 500, json: async () => ({}) };
    if (body.method === "getProgramAccounts") {
      const value = pools.map((p) => ({ pubkey: randomMint(), account: account(CP_SWAP_PROGRAM, Buffer.concat([Buffer.from(base58.decode(p.token0)), Buffer.from(base58.decode(p.token1))])) }));
      return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: value }) };
    }
    if (body.method === "getMultipleAccounts") {
      const value = body.params[0].map((a) => accounts[a] ?? null);
      return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value } }) };
    }
    throw new Error(`unexpected ${body.method}`);
  });
  vi.stubGlobal("fetch", fetchImpl);
  return { calls, fetchImpl };
}

const sorted = (a, b) => (Buffer.compare(Buffer.from(base58.decode(a)), Buffer.from(base58.decode(b))) < 0 ? { token0: a, token1: b } : { token0: b, token1: a });
const recordOf = (mint) => findProgramAddress([new TextEncoder().encode("metadata"), base58.decode(METAPLEX_PROGRAM), base58.decode(mint)], METAPLEX_PROGRAM);

async function ask(mint) {
  const res = mockRes();
  await handleShareName(req({ resource: "mint", mint }), res);
  return res;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the default answer is the file every unknown link got before", () => {
  it("is byte for byte public/mint/default.json", () => {
    expect(DEFAULT_BYTES).toBe(readFileSync(join(FE, "public", "mint", "default.json"), "utf8"));
  });

  it("each picture it may name is a file the site ships, named by the hash of its bytes", () => {
    for (const file of Object.values(GENERIC_PICTURES)) {
      const bytes = readFileSync(join(FE, "public", "mint", "img", file));
      expect(carriesOwnHash(file, sha(bytes)), file).toBe(true);
    }
  });

  it("a malformed link, and SOL's own (the owner pack's probe), answer it with nothing read", async () => {
    const { fetchImpl } = chain();
    for (const mint of ["not-an-address", "", undefined, SOL, COINS.BAYLA]) {
      const res = await ask(mint);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(DEFAULT_BYTES);
      expect(res.headers["Content-Type"]).toBe("application/json; charset=utf-8");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it("a mint that is no share of our pools answers it, briefly cached (a pool a moment old may not show yet)", async () => {
    const { calls } = chain({ pools: [] });
    const mint = randomMint();
    const res = await ask(mint);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(DEFAULT_BYTES);
    expect(res.headers["Cache-Control"]).toBe("public, max-age=60");
    // The scan only walks pool accounts of our program whose share mint is this one.
    expect(calls).toHaveLength(1);
    const [program, opts] = calls[0].params;
    expect(program).toBe(CP_SWAP_PROGRAM);
    expect(opts.filters).toEqual([
      { dataSize: POOL_STATE_LEN },
      { memcmp: { offset: 0, bytes: expect.any(String) } },
      { memcmp: { offset: OFFSETS.lpMint, bytes: mint } },
    ]);
    expect(opts.dataSlice).toEqual({ offset: OFFSETS.token0Mint, length: 64 });
    expect(OFFSETS.token1Mint).toBe(OFFSETS.token0Mint + 32);
  });

  it("a failed read is a 503 kept by nobody, never the default file", async () => {
    chain({ fail: true });
    const res = await ask(randomMint());
    expect(res.statusCode).toBe(503);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(res.body).not.toBe(DEFAULT_BYTES);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("a share built here reads like the committed files", () => {
  const shares = MINT_TOKENS.filter((t) => t.kind === "pool-share");
  const siteName = new Map([...Object.entries(COINS).map(([t, m]) => [m, t]), ...QUOTE_COINS.map((q) => [q.mint, q.symbol])]);

  it("for every committed share: the same name and words, the same symbol where it fits, the same picture where it is a shared one", () => {
    expect(shares.length).toBeGreaterThanOrEqual(23);
    for (const t of shares) {
      const [own, paired] = t.coins;
      const { token0, token1 } = sorted(own, paired);
      expect(pairOf(token0, token1), t.name).toEqual({ own, paired });
      const built = JSON.parse(shareFile({ own, paired }, siteName.get(own)));
      const file = JSON.parse(committed(t.mint));
      expect(built.name, t.name).toBe(file.name);
      expect(built.description, t.name).toBe(file.description);
      // A short form the owner picked (BIGB, BRAIN, ...) is not guessed: those stay MEM-LP here.
      if (built.symbol !== "MEM-LP") expect(built.symbol, t.name).toBe(file.symbol);
      if (Object.values(GENERIC_PICTURES).some((p) => file.image.endsWith(`/${p}`))) expect(built.image, t.name).toBe(file.image);
    }
  });

  it("answers a committed share's pool with that file's own bytes when the picture is a shared one (GRR/SOL)", async () => {
    const grr = MINT_TOKENS.find((t) => t.name === "GRR/SOL LP");
    chain({ pools: [sorted(COINS.GRR, SOL)] });
    const res = await ask(grr.mint);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(committed(grr.mint));
    expect(res.headers["Cache-Control"]).toBe("public, max-age=3600");
  });

  it("orders a pair as the site does (quotes.ts readPair), SOL/USDC reading SOL first", () => {
    const coins = [...QUOTE_COINS.map((q) => q.mint), randomMint()];
    for (const a of coins) {
      for (const b of coins) {
        if (a === b) continue;
        const { token0, token1 } = sorted(a, b);
        const site = readPair(token0, token1);
        const here = pairOf(token0, token1);
        if (!site) {
          expect(here).toBeNull();
          continue;
        }
        const special = new Set([a, b]).has(SOL) && new Set([a, b]).has(USDC);
        expect(here).toEqual(special ? { own: SOL, paired: USDC } : { own: site.tokenMint, paired: site.quote.mint });
      }
    }
    expect(pairOf(randomMint(), randomMint())).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("a coin the site does not name shows its own ticker, and a copy is called one", () => {
  it("the well-known names are the site's own list", () => {
    expect(WELL_KNOWN_NAMES.map((k) => ({ ...k, names: [...k.names] }))).toEqual(SITE_WELL_KNOWN.map((k) => ({ ...k, names: [...k.names] })));
  });

  it("calls a claim a copy exactly when the site's own check does", () => {
    const claims = ["SOY", "S0Y", "soy", "Wrapped SOL", "SoIana", "BAYLA Token", "BAYLA2", "TOWELI", "USD Coin", "PEPE", "GRR", "Tether", "BRAINLET", "RIZZ", "bobo", ""];
    for (const mint of [randomMint(), SOL, USDC, COINS.BAYLA, COINS.SOY, COINS.BOBO]) {
      for (const c of claims) expect(copiedWellKnownName(mint, [c])?.label ?? null, `${c} at ${mint}`).toBe(siteCopied(mint, [c])?.label ?? null);
    }
  });

  it("cleans a ticker as the site does", () => {
    const mint = randomMint();
    for (const s of ["PEPE", "pepe", "$WIF", "  spaced  out  ", "SOY", "‮LOOK", "ABCDEFGHIJKLMNOP", "", "​"]) {
      expect(claimedTicker(mint, s, [s]), JSON.stringify(s)).toBe(siteClaimedTicker(mint, s));
    }
  });

  it("names a Metaplex coin by its ticker, with its whole address, on the paired coin's picture", async () => {
    const coin = randomMint();
    const share = randomMint();
    chain({ pools: [sorted(coin, SOL)], accounts: { [coin]: account("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", Buffer.alloc(82, 0)), [recordOf(coin)]: account(METAPLEX_PROGRAM, metaplexRecord(coin, "Pepe", "PEPE")) } });
    const res = await ask(share);
    expect(JSON.parse(res.body)).toEqual({
      name: "PEPE/SOL LP",
      symbol: "PEPE-SOL",
      description: `A share of the PEPE/SOL pool on memetics.finance. Remove liquidity there and it comes back as PEPE (${coin}) and SOL. Do not burn it.`,
      image: `https://memetics.finance/mint/img/${GENERIC_PICTURES.sol}`,
    });
  });

  it("names a Token-2022 coin by its own extension's ticker", async () => {
    const coin = randomMint();
    chain({ pools: [sorted(coin, USDC)], accounts: { [coin]: account("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", token2022Mint(coin, "Twenty Two", "T22")) } });
    const file = JSON.parse((await ask(randomMint())).body);
    expect(file.name).toBe("T22/USDC LP");
    expect(file.symbol).toBe("T22-USDC");
    expect(file.image).toBe(`https://memetics.finance/mint/img/${GENERIC_PICTURES.usdc}`);
  });

  it("calls a copy of SOY at another address 'fake SOY', with the program's own symbol", async () => {
    const coin = randomMint();
    chain({ pools: [sorted(coin, COINS.BAYLA)], accounts: { [coin]: account("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", Buffer.alloc(82, 0)), [recordOf(coin)]: account(METAPLEX_PROGRAM, metaplexRecord(coin, "Soy", "SOY")) } });
    const file = JSON.parse((await ask(randomMint())).body);
    expect(file.name).toBe("fake SOY/BAYLA LP");
    expect(file.symbol).toBe("MEM-LP");
    expect(file.description).toContain(`fake SOY (${coin})`);
    expect(file.image).toBe(`https://memetics.finance/mint/img/${GENERIC_PICTURES.moonlight}`);
  });

  it("a ticker longer than Metaplex's 10 bytes keeps MEM-LP, and a coin with no ticker gets the default file", async () => {
    expect(JSON.parse(shareFile({ own: randomMint(), paired: SOL }, "LONGTICKER")).symbol).toBe("MEM-LP");
    const coin = randomMint();
    chain({ pools: [sorted(coin, SOL)], accounts: { [coin]: account("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", Buffer.alloc(82, 0)) } });
    expect((await ask(randomMint())).body).toBe(DEFAULT_BYTES);
  });

  it("decodes BAYLA's real mint as the site does (its Token-2022 extension)", () => {
    const j = JSON.parse(readFileSync(join(FE, "scripts", "solana-localnet", "golden", "bayla-mint.mainnet.json"), "utf8"));
    const data = Uint8Array.from(Buffer.from(j.account.data[0], "base64"));
    const site = decodeMintAccount(j.account.owner, data);
    expect(site.ok).toBe(true);
    const here = token2022Names(j.account.owner, data, j.pubkey);
    expect(here).toEqual(site.value.tokenMetadata ? { name: site.value.tokenMetadata.name, symbol: site.value.tokenMetadata.symbol } : null);
  });

  it("reads a Metaplex record only when Metaplex owns it and it names this mint", () => {
    const coin = randomMint();
    const rec = metaplexRecord(coin, "Pepe", "PEPE");
    expect(metaplexNames(METAPLEX_PROGRAM, rec, coin)).toEqual({ name: "Pepe", symbol: "PEPE" });
    expect(metaplexNames(CP_SWAP_PROGRAM, rec, coin)).toBeNull();
    expect(metaplexNames(METAPLEX_PROGRAM, rec, randomMint())).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the routing contract", () => {
  const vercel = JSON.parse(readFileSync(join(FE, "vercel.json"), "utf8"));
  const at = (pred) => vercel.rewrites.findIndex(pred);

  it("a share's link reaches the function, after the committed files and before the default and the SPA fallback", () => {
    const fn = at((r) => r.source === "/mint/:mint.json");
    expect(fn).toBeGreaterThanOrEqual(0);
    expect(vercel.rewrites[fn].destination).toBe("/api/aggregator?resource=mint&mint=:mint");
    expect(fn).toBeLessThan(at((r) => r.source === "/mint/(.*)"));
    expect(fn).toBeLessThan(at((r) => r.destination === "/index.html"));
    // The cross-origin headers every committed file gets apply to the same paths.
    const block = vercel.headers.find((h) => h.source === "/mint/(.*)");
    expect(block.headers).toContainEqual({ key: "Access-Control-Allow-Origin", value: "*" });
  });

  it("its branch sits above `const provider` in the catchall", () => {
    const src = readFileSync(join(FE, "api", "aggregator.js"), "utf8");
    const branch = src.indexOf('req.query.resource === "mint"');
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(src.indexOf("const provider = req.query.provider"));
  });

  it("the link is the one the pool program writes", () => {
    const lib = readFileSync(resolve(FE, "..", "solana", "tegridy-amm", "programs", "cp-swap", "src", "lib.rs"), "utf8");
    expect(lib).toMatch(/format!\("https:\/\/memetics\.finance\/mint\/\{\}\.json", lp_mint\.to_string\(\)\)/);
    expect(metadataUri("X")).toBe("https://memetics.finance/mint/X.json");
  });
});
