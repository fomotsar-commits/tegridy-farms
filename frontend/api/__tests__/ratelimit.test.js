// AUDIT 2026-07-25: tests for the global circuit-breaker (checkGlobalLimit).
//
// Per-IP limits (checkRateLimit) can't stop a DISTRIBUTED flood — many IPs each
// under the per-IP cap — from burning metered upstream. checkGlobalLimit adds a
// single shared per-identifier bucket that sheds load with 503 once aggregate
// traffic exceeds the ceiling. These tests pin THAT invariant.
//
// With no UPSTASH_* env configured (the test default), checkGlobalLimit runs its
// deterministic in-memory degraded path — no network, no Redis. Each test uses a
// UNIQUE identifier so the module-level in-memory bucket map never bleeds state
// between tests (the buckets are keyed by `${identifier}-global:global`).

import { describe, it, expect } from "vitest";
import { checkGlobalLimit } from "../_lib/ratelimit.js";

function makeRes() {
  const state = { headers: {}, statusCode: null, jsonBody: null };
  const res = {
    setHeader: (k, v) => { state.headers[k] = v; return res; },
    status: (c) => { state.statusCode = c; return res; },
    json: (p) => { state.jsonBody = p; return res; },
  };
  return { res, state };
}

describe("checkGlobalLimit (global circuit-breaker)", () => {
  it("allows calls up to the limit, then sheds the next with 503 + Retry-After", async () => {
    const opts = { limit: 3, windowSec: 60, identifier: "test-allow-then-shed" };

    for (let i = 0; i < 3; i++) {
      const { res, state } = makeRes();
      expect(await checkGlobalLimit(res, opts)).toBe(true);
      expect(state.statusCode).toBeNull();
    }

    const { res, state } = makeRes();
    expect(await checkGlobalLimit(res, opts)).toBe(false);
    expect(state.statusCode).toBe(503);
    expect(state.jsonBody).toEqual({ error: "Service temporarily unavailable" });
    expect(Number(state.headers["Retry-After"])).toBeGreaterThanOrEqual(1);
  });

  it("uses ONE shared bucket regardless of caller — the distributed-flood shape", async () => {
    // limit=2, three DIFFERENT callers each calling once: the 3rd still sheds,
    // because there is no per-IP split — every caller counts toward one bucket.
    const opts = { limit: 2, windowSec: 60, identifier: "test-shared-bucket" };
    expect(await checkGlobalLimit(makeRes().res, opts)).toBe(true);
    expect(await checkGlobalLimit(makeRes().res, opts)).toBe(true);
    const { res, state } = makeRes();
    expect(await checkGlobalLimit(res, opts)).toBe(false);
    expect(state.statusCode).toBe(503);
  });

  it("keeps independent buckets per identifier", async () => {
    const a = { limit: 1, windowSec: 60, identifier: "test-iso-a" };
    const b = { limit: 1, windowSec: 60, identifier: "test-iso-b" };
    expect(await checkGlobalLimit(makeRes().res, a)).toBe(true);   // a: 1/1
    expect(await checkGlobalLimit(makeRes().res, b)).toBe(true);   // b independent, 1/1
    expect(await checkGlobalLimit(makeRes().res, a)).toBe(false);  // a over → shed
  });

  it("sets no status or Retry-After on the success path", async () => {
    const { res, state } = makeRes();
    expect(await checkGlobalLimit(res, {
      limit: 5, windowSec: 60, identifier: "test-success-noheaders",
    })).toBe(true);
    expect(state.statusCode).toBeNull();
    expect(state.headers["Retry-After"]).toBeUndefined();
  });
});
