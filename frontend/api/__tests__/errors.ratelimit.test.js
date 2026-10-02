// api/errors.js against the REAL ratelimit.js, with only Upstash's network faked.
//
// errors.test.js mocks the limiter module and checks the call shape. This file checks
// the behaviour that shape produces: one IP is capped, other IPs are not, and the
// aggregate breaker sheds a flood that no single IP could cause.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@upstash/redis", () => ({ Redis: class FakeRedis {} }));

// A sliding window collapsed to a counter: enough to tell "capped" from "not capped",
// which is the only thing asserted here.
const counts = new Map();
vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: class FakeRatelimit {
    static slidingWindow(n, window) { return { n, window }; }
    constructor({ limiter, prefix }) { this.n = limiter.n; this.prefix = prefix; }
    async limit(key, opts) {
      const k = `${this.prefix}:${key}`;
      const used = (counts.get(k) || 0) + (opts?.rate ?? 1);
      counts.set(k, used);
      return { success: used <= this.n, limit: this.n, remaining: Math.max(0, this.n - used), reset: Date.now() + 60_000 };
    }
  },
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }),
}));

const ORIGIN = "https://memetics.finance";
const body = () => ({
  consent: "granted",
  errors: [{ message: "boom", timestamp: Date.now() - 1000, url: "https://memetics.finance/" }],
});
function makeRes() {
  const s = { headers: {}, code: null };
  s.res = {
    headersSent: false,
    setHeader: (k, v) => { s.headers[String(k).toLowerCase()] = v; return s.res; },
    status: (c) => { s.code = c; return s.res; },
    json: () => s.res,
    end: () => s.res,
  };
  return s;
}
async function post(handler, ip) {
  const s = makeRes();
  await handler({ method: "POST", body: body(), headers: { origin: ORIGIN, "x-real-ip": ip } }, s.res);
  return s;
}

let handler;
beforeEach(async () => {
  counts.clear();
  vi.resetModules();
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = "service-role";
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = "upstash-token";
  vi.spyOn(console, "error").mockImplementation(() => {});
  handler = (await import("../errors.js")).default;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

describe("errors: rate limits, with the real limiter", () => {
  it("caps one IP at 30 a minute and leaves the next IP alone", async () => {
    for (let i = 0; i < 30; i++) expect((await post(handler, "198.51.100.1")).code).toBe(200);
    const capped = await post(handler, "198.51.100.1");
    expect(capped.code).toBe(429);
    expect(Number(capped.headers["retry-after"])).toBeGreaterThan(0);
    expect((await post(handler, "198.51.100.2")).code).toBe(200);
  });

  it("sheds a flood spread across many IPs once the aggregate passes 600 a minute", async () => {
    // Every session erroring at once after a bad deploy: each IP under its own cap.
    const codes = [];
    for (let i = 0; i < 601; i++) codes.push((await post(handler, `10.0.${i >> 8}.${i & 255}`)).code);
    expect(codes.slice(0, 600).every((c) => c === 200)).toBe(true);
    expect(codes[600]).toBe(503);
  });
});
