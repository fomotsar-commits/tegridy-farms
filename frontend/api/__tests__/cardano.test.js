// The Cardano chain reader (api/cardano.js + _lib/cardano-ops.js): only named reads, strict
// params, the upstream request built server-side, the key never reflected.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildKoiosRequest, CARDANO_OPS, MINSWAP_V2_AUTHEN_POLICY, MINSWAP_V2_POOL_SCRIPT, POLICY_COINS_ROWS } from "../_lib/cardano-ops.js";
import { POLICY_READ_ROWS } from "../../src/lib/cardano/chain";
import { MINSWAP_V2 } from "../../src/lib/cardano/minswapV2";

vi.mock("../_lib/ratelimit.js", () => ({ checkRateLimit: vi.fn(async () => true), checkGlobalLimit: vi.fn(async () => true) }));

function makeReq({ method = "GET", query = {}, headers = {} } = {}) {
  return { method, query, headers: { "sec-fetch-site": "same-origin", ...headers } };
}

function makeRes() {
  const headers = {};
  const out = { status: null, json: null, sent: null };
  const res = {
    setHeader: (k, v) => {
      headers[k] = v;
      return res;
    },
    status: (c) => {
      out.status = c;
      return res;
    },
    json: (p) => {
      out.json = p;
      return res;
    },
    send: (p) => {
      out.sent = p;
      return res;
    },
    end: vi.fn(),
  };
  return { res, out, headers };
}

function upstream(body, status = 200) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, body: null, text: async () => body }));
}

const LP = "e66195788208dcd363edb600eaf2331019e3599baba645d81d61ef060c82d861";
const TX = "73a22d3ed91deb5bf614434ef72745b296171d4515baf49bfb33755590b1499f";
const POLICY = "279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f";
const FP = "asset108xu02ckwrfc8qs9d97mgyh4kn8gdu9w8f5sxk";

describe("cardano-ops", () => {
  it("pins the same Minswap V2 script and policy as the browser library", () => {
    expect(MINSWAP_V2_POOL_SCRIPT).toBe(MINSWAP_V2.poolScriptHash);
    expect(MINSWAP_V2_AUTHEN_POLICY).toBe(MINSWAP_V2.authenPolicy);
  });

  it("knows only its named reads", () => {
    expect(Object.keys(CARDANO_OPS).sort()).toEqual(["asset", "credtxs", "fingerprint", "params", "policy", "pool", "tip", "tx", "txstatus", "utxo"]);
    expect(buildKoiosRequest("submittx", {}, "")).toEqual({ error: 404, message: "Unknown Cardano read" });
    expect(buildKoiosRequest("constructor", {}, "")).toEqual({ error: 404, message: "Unknown Cardano read" });
    expect(buildKoiosRequest("__proto__", {}, "")).toEqual({ error: 404, message: "Unknown Cardano read" });
  });

  it("builds the pool read itself: Minswap's pool script, Minswap's policy, the caller's LP name only", () => {
    const r = buildKoiosRequest("pool", { lp: LP }, "");
    expect(r.url).toBe(`https://api.koios.rest/api/v1/asset_utxos?payment_cred=eq.${MINSWAP_V2_POOL_SCRIPT}`);
    expect(JSON.parse(r.init.body)).toEqual({ _asset_list: [[MINSWAP_V2_AUTHEN_POLICY, LP]], _extended: true });
  });

  it("builds a pasted policy id's and asset1… id's reads itself, the caller's id the only text in them", () => {
    const policy = buildKoiosRequest("policy", { policy: POLICY }, "");
    expect(policy.url).toBe(
      `https://api.koios.rest/api/v1/policy_asset_info?_asset_policy=${POLICY}&select=asset_name,asset_name_ascii,total_supply,token_registry_metadata->ticker&order=asset_name.asc&limit=51`,
    );
    expect(policy.init.method).toBe("GET");
    expect(buildKoiosRequest("fingerprint", { fp: FP }, "").url).toBe(`https://api.koios.rest/api/v1/asset_list?fingerprint=eq.${FP}&select=policy_id,asset_name,fingerprint`);
    // The browser knows the cap, to tell a whole list from a cut one.
    expect(POLICY_COINS_ROWS).toBe(POLICY_READ_ROWS);
  });

  it("refuses every malformed param, so no caller text reaches the upstream", () => {
    for (const [op, q] of [
      ["pool", { lp: "ab" }],
      ["pool", { lp: `${LP}&payment_cred=neq.x` }],
      ["asset", { policy: "zz", name: "" }],
      ["asset", { policy: "ab".repeat(28), name: "abc" }],
      ["txstatus", { tx: "x" }],
      ["utxo", { ref: `${TX}#-1` }],
      ["utxo", { ref: TX }],
      ["credtxs", { cred: "ab".repeat(28), after: "1e9" }],
      ["tx", { tx: `${TX}0` }],
      ["policy", { policy: `${POLICY}&select=*` }],
      ["policy", { policy: POLICY.toUpperCase() }],
      ["fingerprint", { fp: `${FP}&policy_id=neq.x` }],
      ["fingerprint", { fp: "asset1" + "b".repeat(38) }],
      ["fingerprint", { fp: FP.slice(0, -1) }],
    ]) {
      expect(buildKoiosRequest(op, q, "")).toEqual({ error: 400, message: "Bad parameters" });
    }
  });

  it("refuses a param the read does not take, or one repeated, so a junk query cannot miss the edge cache", () => {
    for (const [op, q] of [
      ["tip", { x: "1" }],
      ["params", { v: "2" }],
      ["asset", { policy: "ab".repeat(28), name: "", bust: "1" }],
      ["asset", { policy: ["ab".repeat(28), "cd".repeat(28)], name: "" }],
      ["pool", { lp: LP, lp2: LP }],
      ["tx", { tx: TX, _inputs: "false" }],
    ]) {
      expect(buildKoiosRequest(op, q, "")).toEqual({ error: 400, message: "Bad parameters" });
    }
    // The reads as the browser sends them still pass.
    expect(buildKoiosRequest("tip", {}, "").url).toMatch(/\/tip$/);
    expect(buildKoiosRequest("asset", { policy: "ab".repeat(28), name: "" }, "").url).toMatch(/\/asset_info$/);
  });

  it("asks for a wallet's history oldest first, so the fill (a few blocks after the order) is in the first rows", () => {
    expect(buildKoiosRequest("credtxs", { cred: "ab".repeat(28), after: "5" }, "").url).toContain("order=block_height.asc");
  });

  it("caches only what is the same for everyone", () => {
    expect(buildKoiosRequest("params", {}, "").cache).toMatch(/^public/);
    expect(buildKoiosRequest("tip", {}, "").cache).toMatch(/^public/);
    expect(buildKoiosRequest("policy", { policy: POLICY }, "").cache).toMatch(/^public/);
    expect(buildKoiosRequest("fingerprint", { fp: FP }, "").cache).toMatch(/^public/);
    for (const [op, q] of [
      ["pool", { lp: LP }],
      ["txstatus", { tx: TX }],
      ["utxo", { ref: `${TX}#0` }],
      ["credtxs", { cred: "ab".repeat(28), after: "5" }],
      ["tx", { tx: TX }],
    ]) {
      expect(buildKoiosRequest(op, q, "").cache).toBe("private, no-store");
    }
  });

  it("sends the key upstream as a bearer token", () => {
    expect(buildKoiosRequest("tip", {}, "k3y").init.headers.Authorization).toBe("Bearer k3y");
    expect(buildKoiosRequest("tip", {}, undefined).init.headers.Authorization).toBeUndefined();
  });
});

describe("api/cardano", () => {
  let handler;
  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = "test";
    handler = (await import("../cardano.js")).default;
  });
  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.VERCEL_ENV;
    delete process.env.KOIOS_API_KEY;
  });

  it("answers a named read with the upstream JSON and its cache rule", async () => {
    globalThis.fetch = upstream('[{"block_no":1}]');
    const { res, out, headers } = makeRes();
    await handler(makeReq({ query: { op: "tip" } }), res);
    expect(out.status).toBe(200);
    expect(out.sent).toBe('[{"block_no":1}]');
    expect(headers["Cache-Control"]).toMatch(/^public/);
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("refuses a POST, a foreign origin on production, and an unknown read", async () => {
    globalThis.fetch = upstream("[]");
    let r = makeRes();
    await handler(makeReq({ method: "POST", query: { op: "tip" } }), r.res);
    expect(r.out.status).toBe(405);
    process.env.VERCEL_ENV = "production";
    r = makeRes();
    await handler(makeReq({ query: { op: "tip" }, headers: { origin: "https://evil.example" } }), r.res);
    expect(r.out.status).toBe(403);
    delete process.env.VERCEL_ENV;
    r = makeRes();
    await handler(makeReq({ query: { op: "submittx" } }), r.res);
    expect(r.out.status).toBe(404);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("says busy on an upstream 429 and hides every other upstream failure behind a 502", async () => {
    globalThis.fetch = upstream("slow down", 429);
    let r = makeRes();
    await handler(makeReq({ query: { op: "tip" } }), r.res);
    expect(r.out.status).toBe(429);
    globalThis.fetch = upstream("<html>oops</html>", 500);
    r = makeRes();
    await handler(makeReq({ query: { op: "tip" } }), r.res);
    expect(r.out.status).toBe(502);
    globalThis.fetch = upstream("<html>not json</html>", 200);
    r = makeRes();
    await handler(makeReq({ query: { op: "tip" } }), r.res);
    expect(r.out.status).toBe(502);
    globalThis.fetch = vi.fn(async () => {
      throw new Error("down");
    });
    r = makeRes();
    await handler(makeReq({ query: { op: "tip" } }), r.res);
    expect(r.out.status).toBe(502);
  });

  it("never caches an empty answer, which may be an indexer that has not caught up", async () => {
    globalThis.fetch = upstream("[]");
    const { res, headers } = makeRes();
    await handler(makeReq({ query: { op: "asset", policy: "ab".repeat(28), name: "" } }), res);
    expect(headers["Cache-Control"]).toBe("private, no-store");
  });

  it("stops at the site-wide cap before any upstream read", async () => {
    const rl = await import("../_lib/ratelimit.js");
    rl.checkGlobalLimit.mockImplementationOnce(async (r) => {
      r.status(503).json({ error: "Service temporarily unavailable" });
      return false;
    });
    globalThis.fetch = upstream("[]");
    const { res, out } = makeRes();
    await handler(makeReq({ query: { op: "tip" } }), res);
    expect(out.status).toBe(503);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("keeps a daily cap per caller and one for the site under the key's 50,000-a-day quota", async () => {
    const rl = await import("../_lib/ratelimit.js");
    rl.checkRateLimit.mockClear();
    rl.checkGlobalLimit.mockClear();
    globalThis.fetch = upstream("[{}]");
    const { res } = makeRes();
    await handler(makeReq({ query: { op: "tip" } }), res);
    expect(rl.checkRateLimit).toHaveBeenCalledWith(expect.anything(), expect.anything(), { limit: 6000, windowSec: 86_400, identifier: "cardano-day" });
    expect(rl.checkGlobalLimit).toHaveBeenCalledWith(expect.anything(), { limit: 45_000, windowSec: 86_400, identifier: "cardano-day" });
    // A day's cap that is spent stops the read before Koios is asked.
    rl.checkGlobalLimit.mockImplementationOnce(async () => true).mockImplementationOnce(async (r) => {
      r.status(503).json({ error: "Service temporarily unavailable" });
      return false;
    });
    globalThis.fetch = upstream("[{}]");
    const second = makeRes();
    await handler(makeReq({ query: { op: "tip" } }), second.res);
    expect(second.out.status).toBe(503);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("never reflects the key", async () => {
    process.env.KOIOS_API_KEY = "s3cret";
    globalThis.fetch = upstream("[]");
    const { res, out, headers } = makeRes();
    await handler(makeReq({ query: { op: "tip" } }), res);
    expect(JSON.stringify([out, headers])).not.toContain("s3cret");
    expect(globalThis.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer s3cret");
  });

  describe("a slow pool read", () => {
    const POOL_ROWS = '[{"tx_hash":"aa"}]';
    const poolReq = () => makeReq({ query: { op: "pool", lp: LP } });
    const timedOut = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    afterEach(() => vi.restoreAllMocks());

    it("is asked once more, with a longer wait, and the visitor gets the pool", async () => {
      const timeouts = vi.spyOn(AbortSignal, "timeout");
      globalThis.fetch = vi.fn().mockRejectedValueOnce(timedOut()).mockImplementationOnce(upstream(POOL_ROWS));
      const { res, out } = makeRes();
      await handler(poolReq(), res);
      expect(out.status).toBe(200);
      expect(out.sent).toBe(POOL_ROWS);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(timeouts.mock.calls.map((c) => c[0])).toEqual([10_000, 15_000]);
    });

    it("is asked once more when Koios's gateway fails, never a third time", async () => {
      globalThis.fetch = vi.fn().mockImplementationOnce(upstream("<html>504</html>", 504)).mockImplementationOnce(upstream(POOL_ROWS));
      let r = makeRes();
      await handler(poolReq(), r.res);
      expect(r.out.status).toBe(200);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      globalThis.fetch = vi.fn().mockRejectedValueOnce(timedOut()).mockRejectedValueOnce(timedOut()).mockImplementationOnce(upstream(POOL_ROWS));
      r = makeRes();
      await handler(poolReq(), r.res);
      expect(r.out.status).toBe(502);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      globalThis.fetch = vi.fn().mockImplementationOnce(upstream("<html>502</html>", 502)).mockImplementationOnce(upstream("<html>502</html>", 502));
      r = makeRes();
      await handler(poolReq(), r.res);
      expect(r.out.status).toBe(502);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it("is never asked again after a 429, and no other read is asked twice", async () => {
      globalThis.fetch = vi.fn().mockImplementationOnce(upstream("slow down", 429)).mockImplementationOnce(upstream(POOL_ROWS));
      let r = makeRes();
      await handler(poolReq(), r.res);
      expect(r.out.status).toBe(429);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      globalThis.fetch = vi.fn().mockRejectedValueOnce(timedOut()).mockImplementationOnce(upstream("[{}]"));
      r = makeRes();
      await handler(makeReq({ query: { op: "asset", policy: "ab".repeat(28), name: "" } }), r.res);
      expect(r.out.status).toBe(502);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("counts the second ask against the caller's daily cap and the site's, and a spent cap stops it", async () => {
      const rl = await import("../_lib/ratelimit.js");
      const daily = { limit: 45_000, windowSec: 86_400, identifier: "cardano-day" };
      const callerDaily = { limit: 6000, windowSec: 86_400, identifier: "cardano-day" };
      rl.checkGlobalLimit.mockClear();
      rl.checkRateLimit.mockClear();
      globalThis.fetch = vi.fn().mockRejectedValueOnce(timedOut()).mockImplementationOnce(upstream(POOL_ROWS));
      let r = makeRes();
      await handler(poolReq(), r.res);
      expect(rl.checkGlobalLimit.mock.calls.filter((c) => c[1].identifier === "cardano-day")).toEqual([
        [expect.anything(), daily],
        [expect.anything(), daily],
      ]);
      expect(rl.checkRateLimit.mock.calls.filter((c) => c[2].identifier === "cardano-day")).toEqual([
        [expect.anything(), expect.anything(), callerDaily],
        [expect.anything(), expect.anything(), callerDaily],
      ]);
      // The caller's day spent by the second ask: it is not sent.
      rl.checkRateLimit
        .mockImplementationOnce(async () => true)
        .mockImplementationOnce(async () => true)
        .mockImplementationOnce(async (_req, res) => {
          res.status(429).json({ error: "Too many requests" });
          return false;
        });
      globalThis.fetch = vi.fn().mockRejectedValueOnce(timedOut()).mockImplementationOnce(upstream(POOL_ROWS));
      r = makeRes();
      await handler(poolReq(), r.res);
      expect(r.out.status).toBe(429);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      // The minute's cap and the day's pass for the first ask; the day's is spent by the second.
      rl.checkGlobalLimit
        .mockImplementationOnce(async () => true)
        .mockImplementationOnce(async () => true)
        .mockImplementationOnce(async (res) => {
          res.status(503).json({ error: "Service temporarily unavailable" });
          return false;
        });
      globalThis.fetch = vi.fn().mockRejectedValueOnce(timedOut()).mockImplementationOnce(upstream(POOL_ROWS));
      r = makeRes();
      await handler(poolReq(), r.res);
      expect(r.out.status).toBe(503);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("has room for both asks before Vercel stops the function", async () => {
      const { ATTEMPT_TIMEOUTS_MS } = await import("../cardano.js");
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const vercel = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8"));
      const room = vercel.functions["api/cardano.js"].maxDuration * 1000;
      expect(room).toBeGreaterThanOrEqual(ATTEMPT_TIMEOUTS_MS.reduce((a, b) => a + b, 0) + 3_000);
      expect(buildKoiosRequest("pool", { lp: LP }, "").retry).toBe(true);
      expect(Object.keys(CARDANO_OPS).filter((op) => CARDANO_OPS[op].retry)).toEqual(["pool"]);
    });
  });
});
