// apiAuth — the three refusals must never be confused with each other.
//
//   401  the CALLER's key is wrong        → they fix the key
//   429  the caller is over a limit       → they wait, and the reset says how long
//   503  WE cannot answer                 → the operator fixes the deployment
//
// Merging any two of these is the defect. A deployment with no key store that
// answers 401 sends a paying integrator to re-read a key that was always correct;
// a bad key that answers 503 sends the operator hunting an outage that is not
// happening. Both were the shape of the pre-existing surface, which advertised
// X-API-Key and read nothing.
//
// And the money-side mirror of the house honesty rule: a 5xx is OUR failure, so
// it is refunded from the caller's quota. Billing a customer for our outage is
// the same act as rendering an outage as a clean scan.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const GOOD_KEY = "mtk_" + "a".repeat(43);

// ── Supabase stub ────────────────────────────────────────────────────────
// Shapes only what apiAuth touches: .from().select().eq().maybeSingle().
let keyRow;
let keyLookupError;
let keyLookupThrows;

function makeSupabaseStub() {
  return {
    createClient: () => ({
      from: () => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          is: () => chain,
          order: () => chain,
          limit: () => chain,
          insert: () => chain,
          update: () => chain,
          single: async () => ({ data: keyRow, error: keyLookupError }),
          maybeSingle: async () => {
            if (keyLookupThrows) throw new Error("socket hang up");
            return { data: keyRow, error: keyLookupError };
          },
        };
        return chain;
      },
    }),
  };
}

// ── Upstash stubs ────────────────────────────────────────────────────────
let windowResult;
let limitThrows;
let incrValue;
let incrThrows;
const redisCalls = { incr: 0, decr: 0, expire: 0 };

function makeUpstashStubs() {
  return {
    ratelimit: {
      Ratelimit: class {
        constructor() {}
        async limit() {
          if (limitThrows) throw new Error("upstash down");
          return windowResult;
        }
        static slidingWindow() { return {}; }
      },
    },
    redis: {
      Redis: class {
        async incr() {
          redisCalls.incr += 1;
          if (incrThrows) throw new Error("upstash down");
          return incrValue;
        }
        async decr() { redisCalls.decr += 1; return incrValue - 1; }
        async expire() { redisCalls.expire += 1; return 1; }
      },
    },
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

function req(headers = {}) {
  return { method: "GET", query: {}, headers };
}

/** Load apiAuth with the stubs and env of this test. */
async function loadAuth({ store = true, redis = true } = {}) {
  vi.resetModules();
  const stubs = makeUpstashStubs();
  vi.doMock("@supabase/supabase-js", makeSupabaseStub);
  vi.doMock("@upstash/ratelimit", () => stubs.ratelimit);
  vi.doMock("@upstash/redis", () => stubs.redis);

  if (store) {
    process.env.SUPABASE_URL = "https://stub.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "service-key";
  } else {
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
  }
  if (redis) {
    process.env.UPSTASH_REDIS_REST_URL = "https://stub.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  } else {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
  return import("../_lib/apiAuth.js");
}

beforeEach(() => {
  keyRow = { id: "key-1", tier: "free", owner_wallet: "0x" + "1".repeat(40), revoked_at: null };
  keyLookupError = null;
  keyLookupThrows = false;
  windowResult = { success: true, limit: 10, remaining: 9, reset: Date.now() + 60_000 };
  limitThrows = false;
  incrValue = 1;
  incrThrows = false;
  redisCalls.incr = 0;
  redisCalls.decr = 0;
  redisCalls.expire = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("@supabase/supabase-js");
  vi.doUnmock("@upstash/ratelimit");
  vi.doUnmock("@upstash/redis");
});

describe("401 — the caller's key", () => {
  it("refuses an anonymous caller on a keyed route", async () => {
    const { admitKeyedCall } = await loadAuth();
    const { res, statusSpy, jsonSpy } = makeRes();
    const out = await admitKeyedCall(req(), res, { requireKey: true });
    expect(out).toBeNull();
    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(jsonSpy.mock.calls[0][0].code).toBe("api_key_required");
  });

  it("lets an anonymous caller through on an unkeyed route without touching the store", async () => {
    const { admitKeyedCall } = await loadAuth();
    const { res, statusSpy } = makeRes();
    const out = await admitKeyedCall(req(), res, { requireKey: false });
    expect(statusSpy).not.toHaveBeenCalled();
    expect(out.admitted).toBe(true);
    expect(out.keyed).toBe(false);
    // Nothing was metered, so there is nothing to refund.
    expect(redisCalls.incr).toBe(0);
  });

  it("rejects a key that does not exist", async () => {
    keyRow = null;
    const { admitKeyedCall } = await loadAuth();
    const { res, statusSpy, jsonSpy } = makeRes();
    await admitKeyedCall(req({ "x-api-key": GOOD_KEY }), res, { requireKey: true });
    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(jsonSpy.mock.calls[0][0].code).toBe("api_key_invalid");
  });

  it("gives a malformed key the SAME message as an unknown one", async () => {
    // Otherwise the endpoint is a free existence oracle: an attacker distinguishes
    // "well-formed but unknown" from "malformed" and learns the key space by shape.
    keyRow = null;
    const { admitKeyedCall } = await loadAuth();
    const a = makeRes();
    await admitKeyedCall(req({ "x-api-key": "not-a-key" }), a.res, { requireKey: true });
    const b = makeRes();
    await admitKeyedCall(req({ "x-api-key": GOOD_KEY }), b.res, { requireKey: true });
    expect(a.jsonSpy.mock.calls[0][0]).toEqual(b.jsonSpy.mock.calls[0][0]);
  });

  it("tells a revoked key that it was revoked", async () => {
    // Distinct from 'invalid' on purpose: the holder HAD a valid key, and "not
    // recognised" hides the one fact that explains the failure.
    keyRow.revoked_at = new Date().toISOString();
    const { admitKeyedCall } = await loadAuth();
    const { res, statusSpy, jsonSpy } = makeRes();
    await admitKeyedCall(req({ "x-api-key": GOOD_KEY }), res, { requireKey: true });
    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(jsonSpy.mock.calls[0][0].code).toBe("api_key_revoked");
  });

  it("reads a key from Authorization: Bearer as well as X-API-Key", async () => {
    const { extractPresentedKey } = await loadAuth();
    expect(extractPresentedKey(req({ authorization: `Bearer ${GOOD_KEY}` }))).toBe(GOOD_KEY);
    // A SIWE JWT in the same header is a different credential and must not be
    // mistaken for a key — that would turn "your session expired" into "your key
    // is invalid".
    expect(extractPresentedKey(req({ authorization: "Bearer eyJhbGciOi.x.y" }))).toBeNull();
  });

  it("never refuses a key with a 4xx when it could not check it", async () => {
    // The umbrella guard. Whatever goes wrong on OUR side, the caller must not be
    // told their credential is bad.
    const cases = [
      { name: "store unconfigured", setup: () => {}, opts: { store: false } },
      { name: "lookup errored", setup: () => { keyLookupError = { message: "PGRST timeout" }; }, opts: {} },
      { name: "lookup threw", setup: () => { keyLookupThrows = true; }, opts: {} },
      { name: "tier not in catalog", setup: () => { keyRow.tier = "platinum"; }, opts: {} },
    ];
    for (const c of cases) {
      keyRow = { id: "key-1", tier: "free", owner_wallet: "0x" + "1".repeat(40), revoked_at: null };
      keyLookupError = null;
      keyLookupThrows = false;
      c.setup();
      const { admitKeyedCall } = await loadAuth(c.opts);
      const { res, statusSpy, jsonSpy } = makeRes();
      await admitKeyedCall(req({ "x-api-key": GOOD_KEY }), res, { requireKey: true });
      expect(statusSpy, c.name).toHaveBeenCalledWith(503);
      expect(jsonSpy.mock.calls[0][0].code, c.name).not.toMatch(/invalid|revoked|required/);
    }
  });

  it("never caches a refusal", async () => {
    // A 503 held at the edge keeps refusing after the operator fixed the config.
    keyRow = null;
    const { admitKeyedCall } = await loadAuth();
    const { res, headers } = makeRes();
    await admitKeyedCall(req({ "x-api-key": GOOD_KEY }), res, { requireKey: true });
    expect(headers["Cache-Control"]).toBe("no-store");
  });
});

describe("503 — fail closed rather than serve unmetered", () => {
  it("refuses a valid key when no meter is configured", async () => {
    // ratelimit.js degrades to in-memory counting so a Redis blip cannot take the
    // free read surface down. The sold surface takes the opposite trade: an
    // in-memory monthly counter reset by every cold start is not a quota, and
    // serving against one is serving for free while claiming the call was metered.
    const { admitKeyedCall } = await loadAuth({ redis: false });
    const { res, statusSpy, jsonSpy } = makeRes();
    await admitKeyedCall(req({ "x-api-key": GOOD_KEY }), res, { requireKey: true });
    expect(statusSpy).toHaveBeenCalledWith(503);
    expect(jsonSpy.mock.calls[0][0].code).toBe("metering_not_configured");
  });

  it("refuses when the rate window cannot be read", async () => {
    limitThrows = true;
    const { admitKeyedCall } = await loadAuth();
    const { res, statusSpy, jsonSpy } = makeRes();
    await admitKeyedCall(req({ "x-api-key": GOOD_KEY }), res, { requireKey: true });
    expect(statusSpy).toHaveBeenCalledWith(503);
    expect(jsonSpy.mock.calls[0][0].code).toBe("metering_unavailable");
  });

  it("refuses when the quota counter cannot be incremented", async () => {
    incrThrows = true;
    const { admitKeyedCall } = await loadAuth();
    const { res, statusSpy, jsonSpy } = makeRes();
    await admitKeyedCall(req({ "x-api-key": GOOD_KEY }), res, { requireKey: true });
    expect(statusSpy).toHaveBeenCalledWith(503);
    expect(jsonSpy.mock.calls[0][0].code).toBe("metering_unavailable");
  });
});

describe("429 — a limit, with the reset that makes retry mechanical", () => {
  it("returns Retry-After and a reset the caller can act on", async () => {
    const resetAt = Date.now() + 30_000;
    windowResult = { success: false, limit: 10, remaining: 0, reset: resetAt };
    const { admitKeyedCall } = await loadAuth();
    const { res, headers, statusSpy, jsonSpy } = makeRes();
    await admitKeyedCall(req({ "x-api-key": GOOD_KEY }), res, { requireKey: true });

    expect(statusSpy).toHaveBeenCalledWith(429);
    const body = jsonSpy.mock.calls[0][0];
    expect(body.code).toBe("rate_limited");
    expect(body.resetAt).toBe(new Date(resetAt).toISOString());
    expect(Number(headers["Retry-After"])).toBeGreaterThan(0);
    expect(headers["X-RateLimit-Reset"]).toBe(String(Math.floor(resetAt / 1000)));
    // A rate-limited call was not served, so it is not counted against the quota.
    expect(redisCalls.incr).toBe(0);
  });

  it("hard-stops at the monthly quota and says why it is a hard stop", async () => {
    // The tier catalog publishes an overage rate for paid tiers, but nothing can
    // charge it while billing is off. Silently serving past the quota would give
    // the product away under a price list saying otherwise; silently 429ing without
    // saying so would look like a bug. The message carries the reason.
    const { admitKeyedCall, __resetApiAuthCaches } = await loadAuth();
    __resetApiAuthCaches();
    incrValue = 1001; // free tier includes 1000
    const { res, headers, statusSpy, jsonSpy } = makeRes();
    await admitKeyedCall(req({ "x-api-key": GOOD_KEY }), res, { requireKey: true });

    expect(statusSpy).toHaveBeenCalledWith(429);
    const body = jsonSpy.mock.calls[0][0];
    expect(body.code).toBe("quota_exhausted");
    expect(body.error).toMatch(/hard stop/i);
    expect(headers["X-API-Quota-Limit"]).toBe("1000");
    expect(headers["X-API-Quota-Used"]).toBe("1001");
    expect(new Date(body.resetAt).getUTCDate()).toBe(1);
  });
});

describe("metering — an outage is never billed", () => {
  it("admits a good key with the usage headers a customer can reconcile against", async () => {
    const { admitKeyedCall } = await loadAuth();
    const { res, headers, statusSpy } = makeRes();
    const out = await admitKeyedCall(req({ "x-api-key": GOOD_KEY }), res, { requireKey: true });
    expect(statusSpy).not.toHaveBeenCalled();
    expect(out.keyed).toBe(true);
    expect(out.tier.id).toBe("free");
    expect(headers["X-API-Tier"]).toBe("free");
    expect(headers["X-API-Quota-Used"]).toBe("1");
    expect(redisCalls.incr).toBe(1);
    expect(redisCalls.expire).toBe(1); // TTL armed once, on the first call of the period
  });

  it("refunds the call when we answer with a 5xx", async () => {
    const { admitKeyedCall } = await loadAuth();
    const { res } = makeRes();
    const out = await admitKeyedCall(req({ "x-api-key": GOOD_KEY }), res, { requireKey: true });
    await out.settle(502);
    expect(redisCalls.decr).toBe(1);
  });

  it("keeps the call when the answer was the caller's own 4xx", async () => {
    const { admitKeyedCall } = await loadAuth();
    const { res } = makeRes();
    const out = await admitKeyedCall(req({ "x-api-key": GOOD_KEY }), res, { requireKey: true });
    await out.settle(422);
    expect(redisCalls.decr).toBe(0);
  });
});

describe("issuance never sells anything", () => {
  it("refuses to mint a priced tier while billing is off", async () => {
    const { issueApiKey } = await loadAuth();
    const out = await issueApiKey({ ownerWallet: "0x" + "1".repeat(40), tierId: "growth" });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("tier_not_self_serve");
  });

  it("reports issuance as unconfigured rather than failing obscurely", async () => {
    const { issueApiKey } = await loadAuth({ store: false });
    const out = await issueApiKey({ ownerWallet: "0x" + "1".repeat(40) });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(503);
    expect(out.code).toBe("api_keys_not_configured");
  });
});

describe("apiPlatformStatus reports configuration, never a guess", () => {
  it("says not_configured for every surface an empty deployment lacks", async () => {
    const { apiPlatformStatus } = await loadAuth({ store: false, redis: false });
    const status = apiPlatformStatus();
    expect(status.keyVerification).toBe("not_configured");
    expect(status.keyIssuance).toBe("not_configured");
    expect(status.metering).toBe("not_configured");
    // Billing has no env var to set — it is a reviewed code constant, and it is off.
    expect(status.billing).toBe("not_configured");
  });

  it("says configured only once the store and the meter both exist", async () => {
    const { apiPlatformStatus } = await loadAuth();
    const status = apiPlatformStatus();
    expect(status.keyVerification).toBe("configured");
    expect(status.metering).toBe("configured");
  });
});
