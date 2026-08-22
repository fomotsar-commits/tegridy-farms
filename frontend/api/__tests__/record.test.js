// The birth-record route.
//
// The tests that matter most here are NOT about the JSON — they are about the two ways
// this route ships silently broken: swallowed by the SPA fallback (200 HTML forever), and
// caching a partial record (honest for one request, a lie for the next 300 seconds).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toFunctionSelector } from "viem";

vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

import { handleRecord, resolveTarget } from "../_lib/record.js";
import { buildBirthRecord } from "../_lib/record-core.js";
import { SELECTORS, ASSET_DATA_WORDS, AIRLOCK, DOPPLER_ERC20_V1_IMPL } from "../_lib/record-evm.js";
import { decodeAbiString, decodeUint, decodeAddress, decodeUint8, wordAt } from "../_lib/abi-decode.js";
import { decodeMintAccount } from "../_lib/record-solana.js";

const FE = process.cwd();
const CA = "0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca";

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

// ── ABI helpers for building fake returns ────────────────────────────────
const word = (hex) => hex.replace(/^0x/, "").padStart(64, "0");
const uintWord = (n) => word(BigInt(n).toString(16));
const addrWord = (a) => word(a.replace(/^0x/, ""));
function stringReturn(s) {
  const bytes = Buffer.from(s, "utf8").toString("hex");
  const len = Buffer.from(s, "utf8").length;
  return "0x" + uintWord(32) + uintWord(len) + bytes.padEnd(Math.ceil(len / 32) * 64, "0");
}
/** A Solady LibClone runtime pointing at `impl` — the layout Doppler actually deploys. */
const soladyClone = (impl) =>
  "0x3d3d3d3d363d3d37363d73" + impl.replace(/^0x/, "") + "5af43d3d93803e602a57fd5bf3";

function assetDataReturn(overrides = {}) {
  const words = new Array(10).fill(uintWord(0));
  words[ASSET_DATA_WORDS.poolInitializer] = addrWord(
    overrides.poolInitializer ?? "0x1111111111111111111111111111111111111111",
  );
  return "0x" + words.join("");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the routing contract — the SPA fallback would otherwise eat this route", () => {
  const vercel = JSON.parse(readFileSync(join(FE, "vercel.json"), "utf8"));

  /**
   * Turn a Vercel `source` into a regex the way the platform does, near enough.
   *
   * Splits on `:param` / `:param*` tokens and escapes EVERY regex metacharacter in the
   * literal segments — including backslashes. Escaping only `.` (the obvious one) leaves
   * a partial sanitizer, which is both a CodeQL high and a real correctness hole: an
   * unescaped metacharacter in a future `source` would silently widen this matcher and
   * make the SPA-fallback ordering test pass when it should fail.
   */
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

  it("a record URL matches the record rewrite BEFORE the SPA fallback", () => {
    const url = `/record/ethereum/${CA}.json`;
    const idx = vercel.rewrites.findIndex((r) => sourceToRegex(r.source).test(url));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(vercel.rewrites[idx].destination).toContain("resource=record");
    const spaIdx = vercel.rewrites.findIndex((r) => r.destination === "/index.html");
    expect(spaIdx).toBeGreaterThanOrEqual(0);
    // ORDER IS THE WHOLE TEST. First match wins; below the fallback it never runs.
    expect(idx).toBeLessThan(spaIdx);
  });

  it("the rewrite forwards BOTH path segments", () => {
    const r = vercel.rewrites.find((x) => x.source === "/record/:chain/:ca.json");
    expect(r).toBeTruthy();
    expect(r.destination).toContain("chain=:chain");
    expect(r.destination).toContain("ca=:ca");
  });

  it("a malformed /record/ path still reaches the function, so IT owns the 404", () => {
    // Without this catch-all, /record/ethereum/0xabc (no .json) falls through to the SPA
    // shell and answers 200 with HTML.
    for (const url of ["/record/", "/record/ethereum", "/record/ethereum/0xabc"]) {
      const idx = vercel.rewrites.findIndex((r) => sourceToRegex(r.source).test(url));
      const spaIdx = vercel.rewrites.findIndex((r) => r.destination === "/index.html");
      expect(idx, `${url} fell through to the SPA shell`).toBeLessThan(spaIdx);
      expect(vercel.rewrites[idx].destination).toContain("resource=record");
    }
  });

  it("the record path is NOT in middleware's matcher — a bot UA must not get the OG stub", () => {
    const mw = readFileSync(join(FE, "middleware.js"), "utf8");
    expect(mw).not.toContain("/record");
  });

  it("record responses are marked cross-origin readable", () => {
    const block = vercel.headers.find((h) => h.source === "/record/(.*)");
    expect(block).toBeTruthy();
    expect(block.headers).toContainEqual({ key: "Cross-Origin-Resource-Policy", value: "cross-origin" });
    // ACAO must come from code, never here — two values are rejected by browsers.
    expect(block.headers.some((h) => h.key === "Access-Control-Allow-Origin")).toBe(false);
  });
});

describe("dispatch position in the aggregator catchall", () => {
  it("the record branch sits ABOVE `const provider`", () => {
    const src = readFileSync(join(FE, "api", "aggregator.js"), "utf8");
    const branch = src.indexOf('req.query.resource === "record"');
    const provider = src.indexOf("const provider = req.query.provider");
    expect(branch).toBeGreaterThan(-1);
    expect(provider).toBeGreaterThan(-1);
    // A ?resource= call carries no provider, so a branch below this line never runs.
    expect(branch).toBeLessThan(provider);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("selectors are DERIVED, not typed", () => {
  it("every selector matches its signature", () => {
    // A hand-typed selector that does not exist on the target does not throw — a
    // contract with a fallback returns 0x, which decodes to null, which looks like a
    // plausible `unread`. Only re-derivation catches that. Two functions already shipped
    // dead in this repo exactly this way.
    expect(SELECTORS.name).toBe(toFunctionSelector("name()"));
    expect(SELECTORS.symbol).toBe(toFunctionSelector("symbol()"));
    expect(SELECTORS.totalSupply).toBe(toFunctionSelector("totalSupply()"));
    expect(SELECTORS.owner).toBe(toFunctionSelector("owner()"));
    expect(SELECTORS.decimals).toBe(toFunctionSelector("decimals()"));
    expect(SELECTORS.vestedTotalAmount).toBe(toFunctionSelector("vestedTotalAmount()"));
    expect(SELECTORS.getAssetData).toBe(toFunctionSelector("getAssetData(address)"));
  });

  it("the literals in the source match the derived values", () => {
    const src = readFileSync(join(FE, "api", "_lib", "record-evm.js"), "utf8");
    for (const [name, sel] of Object.entries(SELECTORS)) {
      expect(src, `${name} literal missing from source`).toContain(sel);
    }
  });

  it("pins the Airlock and the Doppler template address", () => {
    expect(AIRLOCK).toBe("0xde3599a2ec440b296373a983c85c365da55d9dfa");
    expect(DOPPLER_ERC20_V1_IMPL).toBe("0xdb7b520bb5c3a2c5d4871198081911359f93be87");
  });

  it("uses poolInitializer as the absence discriminator, NOT integrator", () => {
    // A Doppler launch with no integrator is legitimate and one exists on mainnet.
    expect(ASSET_DATA_WORDS.poolInitializer).toBe(4);
    expect(ASSET_DATA_WORDS.integrator).toBe(9);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("decoders — unknown is null, never a zero value", () => {
  it("0x is null for every decoder, because a fallback answers 0x", () => {
    expect(decodeAbiString("0x").ok).toBe(false);
    expect(decodeUint("0x")).toBeNull();
    expect(decodeAddress("0x")).toBeNull();
    expect(decodeUint8("0x")).toBeNull();
  });

  it("decodes a real string return", () => {
    expect(decodeAbiString(stringReturn("Test Coin"))).toEqual({ ok: true, value: "Test Coin" });
  });

  it("decodes the legacy bytes32 form", () => {
    const b32 = "0x" + Buffer.from("MKR", "utf8").toString("hex").padEnd(64, "0");
    expect(decodeAbiString(b32)).toEqual({ ok: true, value: "MKR" });
  });

  it("refuses a non-canonical offset rather than following it into attacker bytes", () => {
    expect(decodeAbiString("0x" + uintWord(64) + uintWord(3) + "414243".padEnd(64, "0")).ok).toBe(false);
  });

  it("refuses a length that overruns the payload", () => {
    expect(decodeAbiString("0x" + uintWord(32) + uintWord(200) + "41".padEnd(64, "0")).ok).toBe(false);
  });

  it("refuses control characters and invalid UTF-8", () => {
    const withNul = "0x" + uintWord(32) + uintWord(4) + Buffer.from("AB C", "utf8").toString("hex").padEnd(64, "0");
    expect(decodeAbiString(withNul).ok).toBe(false);
    const badUtf8 = "0x" + uintWord(32) + uintWord(2) + "fffe".padEnd(64, "0");
    expect(decodeAbiString(badUtf8).ok).toBe(false);
  });

  it("refuses an address word that is not left-padded", () => {
    // A fallback returning 32 bytes of something else would otherwise yield a plausible
    // address made of its low 20 bytes.
    expect(decodeAddress("0x" + "ff".repeat(32))).toBeNull();
    expect(decodeAddress("0x" + addrWord(CA))).toBe(CA);
  });

  it("wordAt refuses to read past a truncated return", () => {
    expect(wordAt("0x" + uintWord(1), 3)).toBeNull();
    expect(wordAt("0x" + uintWord(1) + uintWord(2), 1)).toBe("0x" + uintWord(2));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the handler", () => {
  beforeEach(() => {
    delete process.env.ETHERSCAN_API_KEY;
  });

  /** Fake JSON-RPC: dispatch on method + calldata prefix. */
  function stubRpc(handlers) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body);
        const out = handlers(body.method, body.params);
        if (out === undefined) throw new Error("unexpected rpc call " + body.method);
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: out }) };
      }),
    );
  }

  /**
   * Like `stubRpc`, but also answers the Etherscan getLogs GET that `createLogFor` makes,
   * and `eth_getTransactionByHash`. `log` is `{ blockNumber, txHash }`, or
   * `{ truncated: true }` to simulate a full window with no match.
   */
  function stubBoth(rpcHandler, log) {
    const CREATOR = "0x" + "99".repeat(20);
    const logs = log.truncated
      ? Array.from({ length: 1000 }, () => ({
          data: "0x" + addrWord("0x" + "22".repeat(20)),
          blockNumber: "0x1",
          transactionHash: "0x" + "00".repeat(32),
        }))
      : [{ data: "0x" + addrWord(CA), blockNumber: log.blockNumber, transactionHash: log.txHash }];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        // Match on the parsed HOSTNAME, not a substring. `includes("api.etherscan.io")`
        // also matches `https://evil.test/?x=api.etherscan.io`, so a stub written that
        // way would answer for a host the code never meant to call — and the test would
        // still pass while proving nothing about which host was contacted.
        const host = typeof url === "string" ? new URL(url).hostname : "";
        if (host === "api.etherscan.io") {
          return { ok: true, status: 200, json: async () => ({ status: "1", result: logs }) };
        }
        const body = JSON.parse(init.body);
        if (body.method === "eth_getTransactionByHash") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ result: { from: CREATOR, hash: log.txHash } }),
          };
        }
        const out = rpcHandler(body.method, body.params);
        if (out === undefined) throw new Error("unexpected rpc call " + body.method);
        return { ok: true, status: 200, json: async () => ({ result: out }) };
      }),
    );
  }

  const healthyEvm = (over = {}) => (method, params) => {
    if (method === "eth_getCode") return over.code ?? soladyClone(DOPPLER_ERC20_V1_IMPL);
    if (method === "eth_call") {
      const { to, data } = params[0];
      if (to.toLowerCase() === AIRLOCK) return over.assetData ?? assetDataReturn();
      if (data.startsWith(SELECTORS.name)) return over.name ?? stringReturn("Test Coin");
      if (data.startsWith(SELECTORS.symbol)) return over.symbol ?? stringReturn("TEST");
      if (data.startsWith(SELECTORS.totalSupply)) return over.totalSupply ?? "0x" + uintWord(10n ** 24n);
      if (data.startsWith(SELECTORS.owner)) return over.owner ?? "0x" + addrWord("0x" + "11".repeat(20));
      if (data.startsWith(SELECTORS.decimals)) return over.decimals ?? "0x" + uintWord(18);
      if (data.startsWith(SELECTORS.vestedTotalAmount)) return over.vested ?? "0x" + uintWord(0);
    }
    return undefined;
  };

  it("serves a JSON record with the stamp and schema version", async () => {
    stubRpc(healthyEvm());
    const res = mockRes();
    await handleRecord(req({ chain: "ethereum", ca: CA }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.schema_version).toBe(1);
    expect(res.body.stamp).toBe("Every lock verifiable onchain.");
    expect(res.body.ca).toBe(CA);
    expect(res.headers["Content-Type"]).toMatch(/application\/json/);
  });

  it("presence gates everything: no code means 404 and NO eth_call is made", async () => {
    const calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u, init) => {
        const b = JSON.parse(init.body);
        calls.push(b.method);
        return { ok: true, status: 200, json: async () => ({ result: b.method === "eth_getCode" ? "0x" : null }) };
      }),
    );
    const res = mockRes();
    await handleRecord(req({ chain: "ethereum", ca: CA }), res);
    expect(res.statusCode).toBe(404);
    expect(calls).toEqual(["eth_getCode"]);
  });

  it("an unread name is null AND named in unread", async () => {
    stubRpc(healthyEvm({ name: "0x" }));
    const res = mockRes();
    await handleRecord(req({ chain: "ethereum", ca: CA }), res);
    expect(res.body.name).toBeNull();
    expect(res.body.unread).toContain("name");
  });

  it("unread carries RECORD field names, never Solidity method names", async () => {
    stubRpc(healthyEvm({ totalSupply: "0x" }));
    const res = mockRes();
    await handleRecord(req({ chain: "ethereum", ca: CA }), res);
    expect(res.body.total_supply).toBeNull();
    expect(res.body.unread).toContain("total_supply");
    expect(res.body.unread).not.toContain("totalSupply");
  });

  it("a failed vestedTotalAmount does NOT become a clean 100% public sale", async () => {
    // The dangerous one: public RPCs 429 routinely, and 0 bps would publish a
    // full-float plate for a token that may be 20% insider-held.
    stubRpc(healthyEvm({ vested: "0x" }));
    const res = mockRes();
    await handleRecord(req({ chain: "ethereum", ca: CA }), res);
    expect(res.body.unread).toContain("plates");
  });

  it("decimals come from the CHAIN, not from the rail's pinned 18", async () => {
    // A non-Doppler token with 6 decimals must publish 6. Publishing 18 would misprice
    // every plate on the record by 10^12.
    stubRpc(healthyEvm({ code: "0x6080", decimals: "0x" + uintWord(6) }));
    const res = mockRes();
    await handleRecord(req({ chain: "ethereum", ca: CA }), res);
    expect(res.body.decimals).toBe(6);
  });

  it("an unreadable decimals on a non-template token is null and unread, never 18", async () => {
    stubRpc(healthyEvm({ code: "0x6080", decimals: "0x" }));
    const res = mockRes();
    await handleRecord(req({ chain: "ethereum", ca: CA }), res);
    expect(res.body.decimals).toBeNull();
    expect(res.body.unread).toContain("decimals");
  });

  it("a template token whose decimals() disagrees with its provenance is a 409, not a guess", async () => {
    stubRpc(healthyEvm({ decimals: "0x" + uintWord(6) }));
    const res = mockRes();
    await handleRecord(req({ chain: "ethereum", ca: CA }), res);
    expect(res.statusCode).toBe(409);
  });

  it("never asserts a liquidity lock it did not read", async () => {
    stubRpc(healthyEvm());
    const res = mockRes();
    await handleRecord(req({ chain: "ethereum", ca: CA }), res);
    const lock = res.body.locks.find((l) => l.kind === "liquidity");
    expect(lock.note).not.toMatch(/not locked/i);
    expect(res.body.unread).toContain("locks.liquidity");
  });

  it("declares the fee instruction unread rather than publishing [] as 'no fees'", async () => {
    stubRpc(healthyEvm());
    const res = mockRes();
    await handleRecord(req({ chain: "ethereum", ca: CA }), res);
    expect(res.body.fee_instruction).toEqual([]);
    expect(res.body.unread).toContain("fee_instruction");
  });

  describe("caching a failure is the lie that lasts 300 seconds", () => {
    it("a degraded record is no-store", async () => {
      stubRpc(healthyEvm({ symbol: "0x" }));
      const res = mockRes();
      await handleRecord(req({ chain: "ethereum", ca: CA }), res);
      expect(res.headers["Cache-Control"]).toBe("no-store");
    });

    it("a structurally-complete record caches", async () => {
      // Everything read, INCLUDING birth provenance; only structural gaps
      // (fee_instruction, gate_decision_id, locks.liquidity) remain — those are permanent
      // properties of the rail, and caching them is correct.
      process.env.ETHERSCAN_API_KEY = "test-key";
      stubBoth(healthyEvm(), { blockNumber: "0x14856a8", txHash: "0x" + "ab".repeat(32) });
      const res = mockRes();
      await handleRecord(req({ chain: "ethereum", ca: CA }), res);
      expect(res.body.birth_block).toBe(0x14856a8);
      expect(res.body.unread).not.toContain("birth_block");
      expect(res.headers["Cache-Control"]).toContain("s-maxage=300");
    });

    it("an absent Etherscan key leaves birth provenance unread — and therefore uncached", async () => {
      // Not a transient failure but not structural either: the island must never be
      // served a cached record that omits the block its whole measurement anchors on.
      stubRpc(healthyEvm());
      const res = mockRes();
      await handleRecord(req({ chain: "ethereum", ca: CA }), res);
      expect(res.body.birth_block).toBeNull();
      expect(res.body.unread).toContain("birth_block");
      expect(res.headers["Cache-Control"]).toBe("no-store");
    });
  });

  describe("birth provenance is chain truth or nothing", () => {
    it("resolves the block and the create-tx sender", async () => {
      process.env.ETHERSCAN_API_KEY = "test-key";
      stubBoth(healthyEvm(), { blockNumber: "0x14856a8", txHash: "0x" + "cd".repeat(32) });
      const res = mockRes();
      await handleRecord(req({ chain: "ethereum", ca: CA }), res);
      expect(res.body.birth_block).toBe(0x14856a8);
      expect(res.body.birth_tx).toBe("0x" + "cd".repeat(32));
      expect(res.body.creator).toBe("0x" + "99".repeat(20));
    });

    it("a TRUNCATED enumeration window leaves it unread — never 'never launched'", async () => {
      // We did not find it. That is not proof it is not there, and publishing a null
      // birth_block without the unread entry would read as "this token has no birth".
      process.env.ETHERSCAN_API_KEY = "test-key";
      stubBoth(healthyEvm(), { truncated: true });
      const res = mockRes();
      await handleRecord(req({ chain: "ethereum", ca: CA }), res);
      expect(res.body.birth_block).toBeNull();
      expect(res.body.unread).toContain("birth_block");
    });
  });

  describe("input validation is the SSRF boundary", () => {
    it("rejects an array-valued query param (Vercel merges duplicates into arrays)", async () => {
      const res = mockRes();
      await handleRecord(req({ chain: "ethereum", ca: [CA, "0xEVIL"] }), res);
      expect(res.statusCode).toBe(400);
    });

    it("rejects a base58 address on the EVM rail and hex on the Solana rail", async () => {
      const a = mockRes();
      await handleRecord(req({ chain: "ethereum", ca: "So11111111111111111111111111111111111111112" }), a);
      expect(a.statusCode).toBe(400);
      const b = mockRes();
      await handleRecord(req({ chain: "solana", ca: CA }), b);
      expect(b.statusCode).toBe(400);
    });

    it("404s the base rail rather than answering with mainnet addresses", async () => {
      const res = mockRes();
      await handleRecord(req({ chain: "base", ca: CA }), res);
      expect(res.statusCode).toBe(404);
    });

    it("rejects an unknown chain and a non-GET", async () => {
      const a = mockRes();
      await handleRecord(req({ chain: "polygon", ca: CA }), a);
      expect(a.statusCode).toBe(400);
      const b = mockRes();
      await handleRecord(req({ chain: "ethereum", ca: CA }, "POST"), b);
      expect(b.statusCode).toBe(405);
    });
  });

  it("a dead RPC is a 502, never a record full of nulls", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    const res = mockRes();
    await handleRecord(req({ chain: "ethereum", ca: CA }), res);
    expect(res.statusCode).toBe(502);
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the Solana mint decoder", () => {
  function mintBuf({ decimals = 6, supply = 1000n, initialized = 1, mintAuth = 0, freezeAuth = 0 } = {}) {
    const b = Buffer.alloc(82);
    b.writeUInt32LE(mintAuth, 0);
    b.writeUInt32LE(Number(supply & 0xffffffffn), 36);
    b.writeUInt32LE(Number((supply >> 32n) & 0xffffffffn), 40);
    b[44] = decimals;
    b[45] = initialized;
    b.writeUInt32LE(freezeAuth, 46);
    return b;
  }

  it("reads decimals and supply from the fixed offsets", () => {
    const m = decodeMintAccount(mintBuf({ decimals: 9, supply: 123456789n }));
    expect(m.decimals).toBe(9);
    expect(m.supply).toBe(123456789n);
  });

  it("keeps u64 precision above 2^53", () => {
    const big = 10n ** 18n;
    expect(decodeMintAccount(mintBuf({ supply: big })).supply).toBe(big);
  });

  it("refuses an uninitialised or short account rather than reading it as zero supply", () => {
    expect(decodeMintAccount(mintBuf({ initialized: 0 }))).toBeNull();
    expect(decodeMintAccount(Buffer.alloc(40))).toBeNull();
    expect(decodeMintAccount(null)).toBeNull();
  });

  it("reports the mint authority, which is the rail's central promise", () => {
    expect(decodeMintAccount(mintBuf({ mintAuth: 0 })).mintAuthorityPresent).toBe(false);
    expect(decodeMintAccount(mintBuf({ mintAuth: 1 })).mintAuthorityPresent).toBe(true);
  });
});

describe("a token whose allocations cannot be enumerated publishes NO plates", () => {
  it("does not claim 100% float for an arbitrary non-template token", () => {
    // Verified live: USDC previously came back with a full-float plate alongside
    // `unread: ["plates"]`. The plate reads as "no insider allocation" — an assertion
    // about a token we just said we could not enumerate.
    const rec = buildBirthRecord({
      sheet: {
        schemaVersion: 1, token: CA, chainId: 1, name: "USD Coin", symbol: "USDC",
        totalSupply: 49481772146429344n, tokenFactory: null, templateCodehash: null,
        knownSafeTemplate: false, residualPowers: [],
        liquidity: { locked: false, locker: null, unlockAt: null, note: "" },
        feeConstitution: [], vesting: [], teamAllocationBps: 0, teamAllocationVestedBps: 0,
        tier: "none", gateChecks: [], observedAt: 1786104024,
      },
      chain: "ethereum", decimals: 6, liquidityReadable: false, unread: ["plates"],
    });
    expect(rec.plates).toEqual([]);
    expect(rec.unread).toContain("plates");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Regressions from the adversarial review. Each of these shipped, was
// reproduced against the real code, and is fixed here.
// ═══════════════════════════════════════════════════════════════════════════

describe("REGRESSION: bytes alone must not make an account a mint", () => {
  it("a 165-byte SPL TOKEN ACCOUNT is not decoded as a mint", () => {
    // `buf.length < 82` admitted every LONGER account. A token account's bytes 44/45
    // sit inside its owner pubkey, so one with byte45==1 and byte44<=18 decoded as a
    // "mint" and published bytes 36..44 of that pubkey as `total_supply`. An attacker
    // grinds such a keypair in seconds and mints a birth certificate with chosen
    // decimals and supply.
    const tokenAccount = Buffer.alloc(165);
    tokenAccount[44] = 9; // looks like decimals
    tokenAccount[45] = 1; // looks like is_initialized
    tokenAccount.writeUInt32LE(0xdeadbeef, 36); // looks like supply
    expect(decodeMintAccount(tokenAccount)).toBeNull();
  });

  it("an 82-byte account owned by the WRONG PROGRAM is refused", async () => {
    const mint = Buffer.alloc(82);
    mint[44] = 9;
    mint[45] = 1;
    mint.writeUInt32LE(0xdeadbeef, 36);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          result: {
            value: {
              // System Program — not a token program. Bytes alone cannot say "mint".
              owner: "11111111111111111111111111111111",
              data: [mint.toString("base64"), "base64"],
            },
          },
        }),
      })),
    );
    const res = mockRes();
    await handleRecord(req({ chain: "solana", ca: "So11111111111111111111111111111111111111112" }), res);
    expect(res.statusCode).toBe(404);
  });
});

describe("REGRESSION: a template token whose supply read failed must declare plates unread", () => {
  it("does not publish an empty allocation breakdown as authoritative", async () => {
    // `else if (!isDopplerTemplate)` left this case in NEITHER branch: no enumeration
    // happened and nothing said so, so a consumer testing `unread.includes('plates')`
    // read `plates: []` as "enumerated and empty".
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body);
        let result;
        if (body.method === "eth_getCode") result = soladyClone(DOPPLER_ERC20_V1_IMPL);
        else {
          const { to, data } = body.params[0];
          if (to.toLowerCase() === AIRLOCK) result = assetDataReturn();
          else if (data.startsWith(SELECTORS.name)) result = stringReturn("Test Coin");
          else if (data.startsWith(SELECTORS.symbol)) result = stringReturn("TEST");
          else if (data.startsWith(SELECTORS.totalSupply)) result = "0x"; // the failed read
          else if (data.startsWith(SELECTORS.owner)) result = "0x" + addrWord("0x" + "11".repeat(20));
          else if (data.startsWith(SELECTORS.decimals)) result = "0x" + uintWord(18);
          else result = "0x";
        }
        return { ok: true, status: 200, json: async () => ({ result }) };
      }),
    );
    const res = mockRes();
    await handleRecord(req({ chain: "ethereum", ca: CA }), res);
    expect(res.body.plates).toEqual([]);
    expect(res.body.unread).toContain("plates");
  });
});

describe("REGRESSION: no vested base unit may leak into the unlocked sale plate", () => {
  const supply = 10n ** 24n;
  const build = (vested) => {
    const bps = Number((vested * 10_000n) / supply);
    return buildBirthRecord({
      sheet: {
        schemaVersion: 1, token: CA, chainId: 1, name: "X", symbol: "X", totalSupply: supply,
        tokenFactory: null, templateCodehash: null, knownSafeTemplate: true, residualPowers: [],
        liquidity: { locked: false, locker: null, unlockAt: null, note: "" },
        feeConstitution: [], vesting: [], teamAllocationBps: bps, teamAllocationVestedBps: bps,
        tier: "none", gateChecks: [], observedAt: 1786104024,
      },
      chain: "ethereum", decimals: 18, liquidityReadable: false, vestedAmount: vested,
    });
  };

  it("publishes the EXACT vested amount, not a bps round-trip", () => {
    // 20.0009% truncates to 2000 bps; recomputing the amount from that lost 9e18 base
    // units of chain-provably vested supply INTO the unlocked public-sale plate.
    const vested = 200009n * 10n ** 18n;
    const r = build(vested);
    const locked = r.plates.filter((p) => p.locked).reduce((a, p) => a + BigInt(p.amount), 0n);
    expect(locked).toBe(vested);
  });

  it("a sub-one-basis-point premine still gets a locked plate", () => {
    // It truncated to 0 bps, the plate vanished, and the record published a single
    // 10000-bps unlocked "Public sale" — a fabricated full-float claim for a token with
    // a real premine.
    const vested = 10n ** 19n; // 0.001%
    const r = build(vested);
    const team = r.plates.find((p) => p.locked);
    expect(team).toBeTruthy();
    expect(BigInt(team.amount)).toBe(vested);
  });

  it("amounts always sum to supply and shares always sum to 10000", () => {
    for (const vested of [0n, 1n, 10n ** 19n, 200009n * 10n ** 18n, supply / 5n]) {
      const r = build(vested);
      if (r.plates.length === 0) continue;
      expect(r.plates.reduce((a, p) => a + BigInt(p.amount), 0n)).toBe(supply);
      expect(r.plates.reduce((a, p) => a + p.share_bps, 0)).toBe(10_000);
    }
  });
});

describe("the route survives however Vercel parses `:ca.json`", () => {
  const CHAIN = "ethereum";

  it("the intended parse", () => {
    expect(resolveTarget({ chain: CHAIN, ca: CA })).toEqual({ chain: CHAIN, ca: CA });
  });

  it("the param swallowing the extension", () => {
    // `.` is a prefix/delimiter character to path-to-regexp, not a plain literal, so
    // `:ca.json` may capture `0xabc.json`. path-to-regexp is not a dependency here, so
    // this parse is unobservable locally or in CI — only on a real deploy.
    expect(resolveTarget({ chain: CHAIN, ca: `${CA}.json` })).toEqual({ chain: CHAIN, ca: CA });
  });

  it("the pretty rewrite not matching at all, so the catch-all takes it", () => {
    expect(resolveTarget({ path: `${CHAIN}/${CA}.json` })).toEqual({ chain: CHAIN, ca: CA });
    expect(resolveTarget({ path: `${CHAIN}/${CA}` })).toEqual({ chain: CHAIN, ca: CA });
  });

  it("refuses an ARRAY param — Vercel merges the query string with the rewrite's", () => {
    // /record/ethereum/0xabc.json?ca=0xEVIL arrives as ca: [...]
    expect(resolveTarget({ chain: CHAIN, ca: [CA, "0xEVIL"] })).toEqual({ chain: null, ca: null });
    expect(resolveTarget({ chain: [CHAIN], ca: CA })).toEqual({ chain: null, ca: null });
  });

  it("refuses a path that is not exactly chain/ca", () => {
    for (const path of ["", "ethereum", "a/b/c", "/", "ethereum/"]) {
      expect(resolveTarget({ path }), path).toEqual({ chain: null, ca: null });
    }
    expect(resolveTarget({})).toEqual({ chain: null, ca: null });
    expect(resolveTarget(undefined)).toEqual({ chain: null, ca: null });
  });

  it("end to end: the catch-all shape serves a real record", async () => {
    stubRpcTop(DOPPLER_ERC20_V1_IMPL);
    const res = mockRes();
    await handleRecord(req({ path: `${CHAIN}/${CA}.json` }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.schema_version).toBe(1);
    expect(res.body.ca).toBe(CA);
  });
});

/** Minimal healthy-EVM stub usable at top level (the handler block has its own). */
function stubRpcTop(impl) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      let result;
      if (body.method === "eth_getCode") result = soladyClone(impl);
      else {
        const { to, data } = body.params[0];
        if (to.toLowerCase() === AIRLOCK) result = assetDataReturn();
        else if (data.startsWith(SELECTORS.name)) result = stringReturn("Test Coin");
        else if (data.startsWith(SELECTORS.symbol)) result = stringReturn("TEST");
        else if (data.startsWith(SELECTORS.totalSupply)) result = "0x" + uintWord(10n ** 24n);
        else if (data.startsWith(SELECTORS.owner)) result = "0x" + addrWord("0x" + "11".repeat(20));
        else if (data.startsWith(SELECTORS.decimals)) result = "0x" + uintWord(18);
        else result = "0x" + uintWord(0);
      }
      return { ok: true, status: 200, json: async () => ({ result }) };
    }),
  );
}
