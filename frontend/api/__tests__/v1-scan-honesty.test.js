// route=scan — a security API that answers "nothing found" when it could not
// look is worse than no API at all.
//
// The integrator's user sees a clean bill of health that nobody ever issued, and
// the venue's name is on it. So every refusal from this route carries `scanned:
// false` AND omits every result-shaped field — because a client that checks
// `body.distribution` before it checks `res.status` is not a hypothetical, it is
// the median client.
//
// The one refusal that is NOT an outage is 422: the upstream looked, and the
// address is not an ERC-20. That one says `scanned: true`, because it is an
// answer about the address rather than a failure of ours.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const TOKEN = "0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce";
const KEY = "mtk_" + "a".repeat(43);

/** Any field a caller could mistake for a result. None may appear on a refusal. */
const RESULT_SHAPED_FIELDS = ["distribution", "holders", "token", "provenance", "findings", "risk", "score"];

function makeReq(query = {}, headers = {}) {
  return {
    method: "GET",
    query: { route: "scan", chain: "ethereum", address: TOKEN, ...query },
    headers: { origin: "https://memetic.fun", "x-api-key": KEY, ...headers },
  };
}

function makeRes() {
  const headers = {};
  const statusSpy = vi.fn();
  const jsonSpy = vi.fn();
  const res = {
    setHeader: (k, v) => { headers[k] = String(v); return res; },
    status: (c) => { statusSpy(c); return res; },
    json: (p) => { jsonSpy(p); return res; },
    end: vi.fn(),
  };
  return { res, headers, statusSpy, jsonSpy };
}

function upstream(text, { ok = true, status = 200 } = {}) {
  return { ok, status, headers: { get: () => null }, body: null, text: async () => text };
}

const INFO = JSON.stringify({
  name: "Shiba Inu", symbol: "SHIB", decimals: "18",
  totalSupply: "999982329055168014311278372706779", holdersCount: 1678265,
});
const HOLDER = { address: "0xdead000000000000000042069420694206942069", rawBalance: "4103927478442409" };

let settled;

/** v1 with a key that verifies and meters cleanly — so what is under test is the
 *  scan route's own honesty, not the auth layer's (covered in apiAuth.test.js). */
async function loadWithAdmittedKey() {
  vi.resetModules();
  settled = [];
  vi.doMock("../_lib/ratelimit.js", () => ({
    checkRateLimit: vi.fn(async () => true),
    checkGlobalLimit: vi.fn(async () => true),
  }));
  vi.doMock("../_lib/apiAuth.js", async () => {
    const actual = await vi.importActual("../_lib/apiAuth.js");
    return {
      ...actual,
      admitKeyedCall: vi.fn(async () => ({
        admitted: true,
        keyed: true,
        keyId: "key-1",
        tier: { id: "free", label: "Free", rateLimitPerMinute: 10, includedCallsPerMonth: 1000 },
        settle: async (status) => { settled.push(status); },
      })),
    };
  });
  return (await import("../v1/index.js")).default;
}

/** getTokenInfo + eth_getCode answer; the holder leg is what each case varies. */
function serve(topResponse, { infoResponse = upstream(INFO) } = {}) {
  globalThis.fetch = vi.fn(async (url, opts) => {
    const u = String(url);
    if (u.includes("getTopTokenHolders")) return topResponse;
    if (u.includes("ethplorer")) return infoResponse;
    const calls = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => calls.map((c) => ({ id: c.id, result: "0x" })) };
  });
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  delete globalThis.fetch;
  vi.restoreAllMocks();
  vi.doUnmock("../_lib/apiAuth.js");
  vi.doUnmock("../_lib/ratelimit.js");
});

describe("an unreadable upstream is a 502 that cannot be read as a clean scan", () => {
  const unreadable = [
    ["a gateway HTML page under HTTP 200", upstream("<!doctype html><title>502 Bad Gateway</title>")],
    ["a 200 whose shape drifted", upstream(JSON.stringify({ ok: true }))],
    ["a `holders` that is not a list", upstream(JSON.stringify({ holders: { "0xabc": 1 } }))],
    ["a non-2xx", upstream("{}", { ok: false, status: 500 })],
  ];

  for (const [label, response] of unreadable) {
    it(`refuses on ${label}`, async () => {
      const handler = await loadWithAdmittedKey();
      serve(response);
      const { res, headers, statusSpy, jsonSpy } = makeRes();
      await handler(makeReq(), res);

      expect(statusSpy).toHaveBeenCalledWith(502);
      const body = jsonSpy.mock.calls[0][0];
      expect(body.scanned).toBe(false);
      expect(body.code).toBe("upstream_unavailable");
      // The words matter as much as the status: an integrator surfacing
      // `body.error` to a user must not be able to surface something reassuring.
      expect(body.error).toMatch(/NO SCAN WAS PERFORMED/);
      for (const field of RESULT_SHAPED_FIELDS) expect(body).not.toHaveProperty(field);
      expect(headers["Cache-Control"]).toBe("no-store");
      // OUR failure — refunded, not billed.
      expect(settled).toEqual([502]);
    });
  }

  it("refuses when the holder source has no key, and calls it a deployment gap", async () => {
    // Not 502: nothing is going to get better by retrying, and telling an
    // integrator "temporarily unavailable" about a permanently unconfigured
    // upstream is a retry loop that can never succeed.
    const handler = await loadWithAdmittedKey();
    serve(upstream(JSON.stringify({ error: { code: 1, message: "Invalid API key" } }), { ok: false, status: 403 }));
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(makeReq(), res);

    expect(statusSpy).toHaveBeenCalledWith(503);
    const body = jsonSpy.mock.calls[0][0];
    expect(body.code).toBe("source_not_configured");
    expect(body.scanned).toBe(false);
    for (const field of RESULT_SHAPED_FIELDS) expect(body).not.toHaveProperty(field);
  });

  it("does not turn a rate-limited getTokenInfo into a token with no supply", async () => {
    // The info leg carries the denominator every share divides by. An {error:{code}}
    // envelope is `typeof === "object"`, so a typeof check alone reads a throttled
    // read as "the explorer did not report a total" — and the enumerated top-N sum
    // then becomes the denominator, inflating every published share.
    const handler = await loadWithAdmittedKey();
    serve(upstream(JSON.stringify({ holders: [HOLDER] })), {
      infoResponse: upstream(JSON.stringify({ error: { code: 104, message: "rate limit" } })),
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(makeReq(), res);
    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(jsonSpy.mock.calls[0][0].scanned).toBe(false);
  });
});

describe("the refusal that is an answer", () => {
  it("says scanned:true on 422 — the upstream looked, and it is not a token", async () => {
    const handler = await loadWithAdmittedKey();
    serve(upstream(JSON.stringify({ error: { code: 150, message: "Address is not a token contract" } }), { ok: false, status: 400 }));
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(makeReq(), res);

    expect(statusSpy).toHaveBeenCalledWith(422);
    const body = jsonSpy.mock.calls[0][0];
    expect(body.code).toBe("not_a_token");
    expect(body.scanned).toBe(true);
    // Still no result fields — "not a token" is not a distribution.
    expect(body).not.toHaveProperty("distribution");
    // The caller's own answer, so it stays on their meter.
    expect(settled).toEqual([422]);
  });
});

describe("a real scan states what it read", () => {
  it("stamps provenance, coverage and computedAt", async () => {
    const handler = await loadWithAdmittedKey();
    serve(upstream(JSON.stringify({ holders: [HOLDER] })));
    const { res, headers, statusSpy, jsonSpy } = makeRes();
    await handler(makeReq(), res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    const body = jsonSpy.mock.calls[0][0];
    expect(body.scanned).toBe(true);
    expect(body.schema).toBe("tegridy.scan.erc20.v1");
    expect(body.provenance.source).toBe("ethplorer");
    expect(body.provenance.totalSupplyRead).toBe(true);
    // 1 holder enumerated against 1.6M reported: a sample, and it says so. A share
    // computed against a sample is a lower bound on concentration, and a consumer
    // can only know that if the response admits which it got.
    expect(body.provenance.coverage).toBe("top-n");
    expect(body.provenance.holdersEnumerated).toBe(1);
    expect(Number.isNaN(Date.parse(body.computedAt))).toBe(false);
    // Base-unit strings, never JSON numbers: a supply past 2^53 loses its low
    // digits on the way out and the loss is invisible at the far end.
    expect(typeof body.token.totalSupply).toBe("string");
    expect(typeof body.distribution.holders[0].balance).toBe("string");
    // Never cached: this is a paid, per-caller read and a shared edge copy would
    // serve one customer's scan to another as if it were fresh.
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(settled).toEqual([200]);
  });

  it("keeps a present-but-empty holder list as the real answer it is", async () => {
    const handler = await loadWithAdmittedKey();
    serve(upstream(JSON.stringify({ holders: [] })));
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(makeReq(), res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(jsonSpy.mock.calls[0][0].distribution.holders).toEqual([]);
  });

  it("refuses a chain it cannot scan rather than answering about the wrong one", async () => {
    const handler = await loadWithAdmittedKey();
    serve(upstream(JSON.stringify({ holders: [HOLDER] })));
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(makeReq({ chain: "solana" }), res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy.mock.calls[0][0].code).toBe("chain_not_supported");
    expect(jsonSpy.mock.calls[0][0].scanned).toBe(false);
  });
});

describe("the sold route is not reachable for free", () => {
  /** Real apiAuth this time — no key store, no meter, nothing configured. */
  async function loadBare(env = {}) {
    vi.resetModules();
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    Object.assign(process.env, env);
    vi.doMock("../_lib/ratelimit.js", () => ({
      checkRateLimit: vi.fn(async () => true),
      checkGlobalLimit: vi.fn(async () => true),
    }));
    return (await import("../v1/index.js")).default;
  }

  it("401s an anonymous caller instead of serving a degraded free scan", async () => {
    const handler = await loadBare();
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(makeReq({}, { "x-api-key": undefined }), res);
    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(jsonSpy.mock.calls[0][0].code).toBe("api_key_required");
  });

  it("503s — not 401s — a key it has no store to check against", async () => {
    // The whole point of the split. A deployment with no key store telling a
    // paying integrator "not recognised" sends them to re-read a key that was
    // always correct.
    const handler = await loadBare();
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(makeReq(), res);
    expect(statusSpy).toHaveBeenCalledWith(503);
    expect(jsonSpy.mock.calls[0][0].code).toBe("api_keys_not_configured");
  });

  it("leaves the free consumer route serving anonymously", async () => {
    // The keyed layer must not have quietly gated the browser scanner's own read.
    const handler = await loadBare();
    serve(upstream(JSON.stringify({ holders: [HOLDER] })));
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(
      { method: "GET", query: { route: "erc20scan", contract: TOKEN }, headers: { origin: "https://memetic.fun" } },
      res,
    );
    expect(statusSpy).not.toHaveBeenCalledWith(401);
    expect(jsonSpy.mock.calls[0][0].holders).toHaveLength(1);
  });
});

describe("route=status discloses configuration instead of implying it", () => {
  it("reports every surface as not_configured on a bare deployment", async () => {
    vi.resetModules();
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    vi.doMock("../_lib/ratelimit.js", () => ({
      checkRateLimit: vi.fn(async () => true),
      checkGlobalLimit: vi.fn(async () => true),
    }));
    const handler = (await import("../v1/index.js")).default;
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler({ method: "GET", query: { route: "status" }, headers: {} }, res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    const body = jsonSpy.mock.calls[0][0];
    expect(body.platform.keyVerification).toBe("not_configured");
    expect(body.platform.metering).toBe("not_configured");
    expect(body.billingEnabled).toBe(false);
    expect(body.pricingState).toBe("proposed");
    // The tier catalog travels with the status so the docs page cannot render a
    // price the limiter does not enforce.
    expect(body.tiers.map((t) => t.id)).toEqual(["free", "starter", "growth", "scale"]);
    // Surfaces the venue computes but does not sell are named, not omitted.
    expect(body.roadmap.map((r) => r.id)).toContain("deployer");
  });
});
