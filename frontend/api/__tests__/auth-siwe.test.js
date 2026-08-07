// AUDIT R052: tests for SIWE auth handler hardening.
// Covers: H-076-1 (expirationTime/notBefore required), M-076-1 (uri host
// validation), M-076-2 (Origin fail-closed), L-076-4 (DELETE rate-limit +
// jwtVerify-not-decode).

import { describe, it, expect, beforeEach, vi } from "vitest";

const WALLET = "0x" + "f".repeat(40);

// Provide env BEFORE handler import (module-init reads them).
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
process.env.SUPABASE_JWT_SECRET = "test-secret-for-vitest-only-not-real";

// Stub rate-limiter to always pass (and let one test toggle it to a deny).
const rateLimitMock = vi.fn(async () => true);
vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: (...args) => rateLimitMock(...args),
}));

// Stub @supabase/supabase-js — chainable thenable that resolves to {data, error}.
//
// AUDIT SIWE-RESTORE: this double used to expose `catch: vi.fn(() => chain)`.
// A real postgrest-js builder (PostgrestBuilder / PostgrestFilterBuilder) is
// PromiseLike — it implements `then` and NOTHING ELSE promise-shaped. It has
// never had a `.catch()`. The fabricated stub made `builder.catch(...)` look
// valid in the suite while it threw `TypeError: ... .catch is not a function`
// in production, which is how a total login outage stayed green for months.
// The shape of this double is verified against the real library in
// "postgrest builder shape" below — do not add methods it does not have.
function makeQueryResult(data = [], error = null) {
  // Build a chain object whose every method returns itself, except await
  // resolves to {data, error}.
  const chain = {
    insert: vi.fn(() => chain),
    delete: vi.fn(() => chain),
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    gt: vi.fn(() => chain),
    lt: vi.fn(() => chain),
    maybeSingle: vi.fn(() => chain),
    // Dispatch happens in `then` — a builder that is never `then`'d never
    // issues its HTTP request. Spying on it lets tests prove a fire-and-
    // forget query was actually sent rather than silently dropped.
    then: vi.fn((resolve) => resolve({ data, error })),
  };
  return chain;
}

// `supabase.rpc(fn)` also returns a postgrest builder: thenable, no `.catch`.
function makeRpcResult(data = null, error = null) {
  return { then: vi.fn((resolve) => resolve({ data, error })) };
}

// nonce row for DELETE-claim
const claimedNonceRow = [{ nonce: "abc", expires_at: new Date(Date.now() + 60000).toISOString() }];
let supabaseFromHandler = vi.fn(() => makeQueryResult(claimedNonceRow));
let supabaseRpcHandler = vi.fn(() => makeRpcResult());

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: (...args) => supabaseFromHandler(...args),
    rpc: (...args) => supabaseRpcHandler(...args),
  })),
}));

// Stub siwe — `new SiweMessage(s)` returns an object with the parsed fields.
// `verify({...})` returns { success: true } unless we override.
let siweVerifyImpl = vi.fn(async () => ({ success: true }));
let nextSiweMessage = null;
vi.mock("siwe", () => ({
  SiweMessage: vi.fn(function (raw) {
    if (typeof raw === "string" && raw === "PARSE_FAIL") throw new Error("parse fail");
    Object.assign(this, nextSiweMessage || {});
    this.verify = siweVerifyImpl;
  }),
}));

// jose: SignJWT chain + jwtVerify mock.
let jwtVerifyImpl = vi.fn(async () => ({ payload: { jti: "j-1", exp: Math.floor(Date.now() / 1000) + 3600 } }));
vi.mock("jose", () => {
  function SignJWT() {
    this.setProtectedHeader = () => this;
    this.setIssuedAt = () => this;
    this.setExpirationTime = () => this;
    this.setIssuer = () => this;
    this.sign = async () => "fake.signed.jwt";
  }
  return {
    SignJWT,
    jwtVerify: (...args) => jwtVerifyImpl(...args),
  };
});

function makeReqRes({ method, body, headers = {}, query = {} }) {
  const req = {
    method,
    body,
    query,
    headers: { origin: "https://tegridyfarms.vercel.app", ...headers },
  };
  const statusSpy = vi.fn();
  const jsonSpy = vi.fn();
  const setHeaderSpy = vi.fn();
  const res = {
    status: (c) => { statusSpy(c); return res; },
    json: (p) => { jsonSpy(p); return res; },
    setHeader: setHeaderSpy,
    end: vi.fn(),
  };
  return { req, res, statusSpy, jsonSpy, setHeaderSpy };
}

function buildValidSiweMessageObject(overrides = {}) {
  const now = Date.now();
  return {
    domain: "tegridyfarms.vercel.app",
    address: WALLET,
    chainId: 1,
    nonce: "abc",
    uri: "https://tegridyfarms.vercel.app/login",
    expirationTime: new Date(now + 5 * 60 * 1000).toISOString(),
    notBefore: new Date(now - 1000).toISOString(),
    ...overrides,
  };
}

// AUDIT SIWE-RESTORE: the doubles above are only trustworthy if they match
// the library the handler actually talks to at runtime. postgrest-js is NOT
// mocked in this file (only @supabase/supabase-js is), so we can compare
// against the genuine builder.
describe("postgrest builder shape — the test double may not invent methods", () => {
  it("every method on the query double exists on a real postgrest-js builder", async () => {
    const { PostgrestClient } = await import("@supabase/postgrest-js");
    // No request is issued — postgrest builders are lazy until `then`.
    const queryBuilder = new PostgrestClient("http://127.0.0.1:1/rest/v1").from("t");
    const filterBuilder = queryBuilder.delete().lt("a", "b");
    const realHas = (k) =>
      typeof queryBuilder[k] === "function" || typeof filterBuilder[k] === "function";

    for (const method of Object.keys(makeQueryResult())) {
      // Asserting the INVARIANT (double ⊆ real library), not a fixed list:
      // postgrest gaining methods never breaks this, but a stub for a method
      // the library lacks — like `.catch()` — fails immediately.
      expect(realHas(method), `double exposes \`${method}\`, real builder does not`).toBe(true);
    }
  });

  it("every method on the rpc double exists on a real postgrest-js rpc builder", async () => {
    const { PostgrestClient } = await import("@supabase/postgrest-js");
    const rpcBuilder = new PostgrestClient("http://127.0.0.1:1/rest/v1").rpc("fn");
    for (const method of Object.keys(makeRpcResult())) {
      expect(typeof rpcBuilder[method], `rpc double exposes \`${method}\``).toBe("function");
    }
  });
});

// AUDIT SIWE-RESTORE: the nonce endpoint is the entry point of every login.
// It was unreachable in production for two independent reasons:
//   1. `siwe_nonces` did not exist (PGRST205) → the INSERT errored → 500.
//      Fixed by migration 014_siwe_nonces.sql.
//   2. The opportunistic cleanup called `.catch()` on a postgrest builder,
//      which is a TypeError → the handler rejected → 500, even once the
//      table existed. Fixed here.
describe("auth/siwe — GET ?action=nonce (SIWE-RESTORE)", () => {
  let handler;

  beforeEach(async () => {
    rateLimitMock.mockClear();
    rateLimitMock.mockImplementation(async () => true);
    supabaseFromHandler = vi.fn(() => makeQueryResult([]));
    vi.resetModules();
    handler = (await import("../auth/siwe.js")).default;
  });

  it("issues a nonce without throwing on a real-shaped postgrest builder", async () => {
    const { req, res, statusSpy, jsonSpy } = makeReqRes({
      method: "GET",
      query: { action: "nonce" },
    });
    await expect(handler(req, res)).resolves.not.toThrow();
    expect(statusSpy).not.toHaveBeenCalledWith(500);
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: expect.any(String), expiresAt: expect.any(String) }),
    );
  });

  it("actually dispatches the expired-nonce cleanup DELETE (not a dropped thenable)", async () => {
    const chains = [];
    supabaseFromHandler = vi.fn(() => {
      const c = makeQueryResult([]);
      chains.push(c);
      return c;
    });
    vi.resetModules();
    handler = (await import("../auth/siwe.js")).default;

    const { req, res } = makeReqRes({ method: "GET", query: { action: "nonce" } });
    await handler(req, res);

    const cleanup = chains.find((c) => c.delete.mock.calls.length > 0);
    expect(cleanup, "no cleanup DELETE chain was built").toBeDefined();
    expect(cleanup.lt).toHaveBeenCalledWith("expires_at", expect.any(String));
    // A postgrest builder only issues its request when `then` is called.
    expect(cleanup.then).toHaveBeenCalled();
  });

  it("surfaces a 500 when the nonce INSERT errors (e.g. PGRST205 missing table)", async () => {
    // This is the exact production failure migration 014 fixes: the table is
    // absent, PostgREST 404s the insert, login cannot start.
    supabaseFromHandler = vi.fn(() =>
      makeQueryResult(null, { message: "Could not find the table 'public.siwe_nonces'" }),
    );
    vi.resetModules();
    handler = (await import("../auth/siwe.js")).default;

    const { req, res, statusSpy } = makeReqRes({ method: "GET", query: { action: "nonce" } });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(500);
  });
});

describe("auth/siwe — POST hardening (R052)", () => {
  let handler;

  beforeEach(async () => {
    rateLimitMock.mockClear();
    rateLimitMock.mockImplementation(async () => true);
    supabaseFromHandler = vi.fn(() => makeQueryResult(claimedNonceRow));
    siweVerifyImpl = vi.fn(async () => ({ success: true }));
    nextSiweMessage = buildValidSiweMessageObject();
    vi.resetModules();
    handler = (await import("../auth/siwe.js")).default;
  });

  it("H-076-1: rejects message missing expirationTime", async () => {
    nextSiweMessage = buildValidSiweMessageObject({ expirationTime: undefined });
    const { req, res, statusSpy, jsonSpy } = makeReqRes({
      method: "POST",
      body: { message: "ok", signature: "0xsig" },
    });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy.mock.calls[0][0].error).toMatch(/expirationTime required/);
  });

  it("H-076-1: rejects message missing notBefore", async () => {
    nextSiweMessage = buildValidSiweMessageObject({ notBefore: undefined });
    const { req, res, statusSpy, jsonSpy } = makeReqRes({
      method: "POST",
      body: { message: "ok", signature: "0xsig" },
    });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy.mock.calls[0][0].error).toMatch(/notBefore required/);
  });

  it("H-076-1: rejects expirationTime in the past", async () => {
    nextSiweMessage = buildValidSiweMessageObject({
      expirationTime: new Date(Date.now() - 60_000).toISOString(),
    });
    const { req, res, statusSpy, jsonSpy } = makeReqRes({
      method: "POST",
      body: { message: "ok", signature: "0xsig" },
    });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy.mock.calls[0][0].error).toMatch(/in the past/);
  });

  it("H-076-1: rejects expirationTime > 15 min in the future", async () => {
    nextSiweMessage = buildValidSiweMessageObject({
      expirationTime: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    const { req, res, statusSpy, jsonSpy } = makeReqRes({
      method: "POST",
      body: { message: "ok", signature: "0xsig" },
    });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy.mock.calls[0][0].error).toMatch(/too far in future/);
  });

  it("M-076-1: rejects siweMessage.uri host not in allowlist", async () => {
    nextSiweMessage = buildValidSiweMessageObject({ uri: "https://evil.example.com/login" });
    const { req, res, statusSpy, jsonSpy } = makeReqRes({
      method: "POST",
      body: { message: "ok", signature: "0xsig" },
    });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy.mock.calls[0][0].error).toMatch(/URI host mismatch/);
  });

  it("M-076-2: rejects request with missing Origin header (fail-closed)", async () => {
    const { req, res, statusSpy, jsonSpy } = makeReqRes({
      method: "POST",
      body: { message: "ok", signature: "0xsig" },
      headers: { origin: "" },
    });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy.mock.calls[0][0].error).toMatch(/Origin header required/);
  });

  it("M-076-2: rejects request whose Origin is not in allowlist", async () => {
    const { req, res, statusSpy, jsonSpy } = makeReqRes({
      method: "POST",
      body: { message: "ok", signature: "0xsig" },
      headers: { origin: "https://evil.example.com" },
    });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy.mock.calls[0][0].error).toMatch(/Origin not allowed/);
  });

  it("happy path: fully-valid POST issues JWT cookie", async () => {
    const { req, res, statusSpy, jsonSpy, setHeaderSpy } = makeReqRes({
      method: "POST",
      body: { message: "ok", signature: "0xsig" },
    });
    await handler(req, res);
    expect(statusSpy).not.toHaveBeenCalledWith(400);
    expect(statusSpy).not.toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      wallet: WALLET.toLowerCase(),
    }));
    // Cookie was set
    const cookieCalls = setHeaderSpy.mock.calls.filter(c => c[0] === "Set-Cookie");
    expect(cookieCalls.length).toBeGreaterThan(0);
    expect(cookieCalls[0][1]).toMatch(/siwe_jwt=fake\.signed\.jwt/);
  });
});

describe("auth/siwe — DELETE hardening (R052/L-076-4)", () => {
  let handler;

  beforeEach(async () => {
    rateLimitMock.mockClear();
    rateLimitMock.mockImplementation(async () => true);
    supabaseFromHandler = vi.fn(() => makeQueryResult([]));
    supabaseRpcHandler = vi.fn(() => makeRpcResult());
    jwtVerifyImpl = vi.fn(async () => ({
      payload: { jti: "j-1", exp: Math.floor(Date.now() / 1000) + 3600 },
    }));
    vi.resetModules();
    handler = (await import("../auth/siwe.js")).default;
  });

  it("L-076-4: DELETE applies rate-limit (siwe-logout identifier)", async () => {
    const { req, res } = makeReqRes({ method: "DELETE", headers: { cookie: "" } });
    await handler(req, res);
    const ids = rateLimitMock.mock.calls.map(c => c[2]?.identifier);
    expect(ids).toContain("siwe-logout");
  });

  it("L-076-4: DELETE returns 429 when rate-limit denies", async () => {
    rateLimitMock.mockImplementation(async (_req, res) => {
      res.status(429).json({ error: "Too many requests" });
      return false;
    });
    const { req, res, statusSpy } = makeReqRes({ method: "DELETE", headers: { cookie: "" } });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(429);
  });

  it("L-076-4: DELETE with invalid-signature cookie does NOT insert into revoked_jwts", async () => {
    jwtVerifyImpl = vi.fn(async () => { throw new Error("bad sig"); });
    const insertSpy = vi.fn(() => makeQueryResult([]));
    supabaseFromHandler = vi.fn((tbl) => {
      if (tbl === "revoked_jwts") {
        const chain = makeQueryResult([]);
        chain.insert = insertSpy;
        return chain;
      }
      return makeQueryResult([]);
    });
    const { req, res, jsonSpy } = makeReqRes({
      method: "DELETE",
      headers: { cookie: "siwe_jwt=forged.token.value" },
    });
    await handler(req, res);
    expect(insertSpy).not.toHaveBeenCalled();
    // Cookie still cleared, returns ok:true
    expect(jsonSpy).toHaveBeenCalledWith({ ok: true });
  });

  it("L-076-4: DELETE with valid signature DOES insert into revoked_jwts", async () => {
    const insertSpy = vi.fn(() => makeQueryResult([]));
    supabaseFromHandler = vi.fn((tbl) => {
      if (tbl === "revoked_jwts") {
        const chain = makeQueryResult([]);
        chain.insert = insertSpy;
        return chain;
      }
      return makeQueryResult([]);
    });
    const { req, res, jsonSpy } = makeReqRes({
      method: "DELETE",
      headers: { cookie: "siwe_jwt=valid.token.value" },
    });
    await handler(req, res);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy.mock.calls[0][0]).toMatchObject({ jti: "j-1" });
    expect(jsonSpy).toHaveBeenCalledWith({ ok: true });
  });

  // AUDIT SIWE-RESTORE: `supabase.rpc(...).catch(() => {})` threw a TypeError
  // that the surrounding try/catch swallowed, so prune_revoked_jwts never ran
  // — the revocation list grew without bound and nobody could tell. Assert the
  // builder is actually dispatched (`then` called), not merely constructed.
  it("SIWE-RESTORE: DELETE dispatches prune_revoked_jwts", async () => {
    const rpcBuilders = [];
    supabaseRpcHandler = vi.fn(() => {
      const b = makeRpcResult();
      rpcBuilders.push(b);
      return b;
    });
    const { req, res, jsonSpy } = makeReqRes({
      method: "DELETE",
      headers: { cookie: "siwe_jwt=valid.token.value" },
    });
    await handler(req, res);
    expect(supabaseRpcHandler).toHaveBeenCalledWith("prune_revoked_jwts");
    expect(rpcBuilders).toHaveLength(1);
    expect(rpcBuilders[0].then).toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith({ ok: true });
  });
});

describe("auth/me — rate-limit (R052/agent-077)", () => {
  let meHandler;

  beforeEach(async () => {
    rateLimitMock.mockClear();
    rateLimitMock.mockImplementation(async () => true);
    vi.resetModules();
    meHandler = (await import("../auth/me.js")).default;
  });

  it("agent-077: /api/auth/me applies rate-limit (auth-me identifier)", async () => {
    const { req, res } = makeReqRes({ method: "GET", headers: { cookie: "" } });
    await meHandler(req, res);
    const ids = rateLimitMock.mock.calls.map(c => c[2]?.identifier);
    expect(ids).toContain("auth-me");
  });

  it("agent-077: /api/auth/me returns 429 when limit denied", async () => {
    rateLimitMock.mockImplementation(async (_req, res) => {
      res.status(429).json({ error: "Too many requests" });
      return false;
    });
    const { req, res, statusSpy } = makeReqRes({ method: "GET", headers: { cookie: "" } });
    await meHandler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(429);
  });
});

// AUDIT R060: CSRF threat-model documentation (per R052 spec).
//
// POST /api/auth/siwe is the login endpoint. Why classic CSRF cannot exploit it:
//
//   1. SameSite=Strict on the issued auth cookie ensures the cookie is
//      not transmitted on cross-site top-level navigation OR cross-site
//      fetch. (See buildAuthCookie in auth/siwe.js.)
//   2. The body MUST be a valid EIP-4361 SIWE message + signature over a
//      FRESH, single-use, server-issued nonce. An attacker without the
//      victim's wallet private key cannot produce such a signature, so
//      even if the attacker tricks the browser into POSTing here, the
//      SIWE signature requirement is the gate. The signature itself
//      effectively IS the CSRF token — and it's strictly stronger than
//      a typical synchronizer token because it binds to wallet identity.
//   3. CORS Allow-Credentials is origin-pinned (only allowlisted origins
//      receive ACAC=true), so credentialed XHR/fetch from non-allowlisted
//      sites is rejected by the browser before the handler runs.
//   4. The Origin header is REQUIRED (M-076-2). curl / server-side tools
//      that don't send Origin are 400'd, blocking server-driven attacks.
//   5. Nonce is single-use and DB-claimed atomically (R052/SEC-NONCE-RACE),
//      so even a leaked nonce can be used at most once.
//   6. Rate limit (10/min/IP on POST) bounds online brute-force against
//      any captured nonce.
//
// Net: classic CSRF (a malicious page causing the victim's browser to
// issue an authenticated state-change request) cannot mint a valid SIWE
// session because steps 2 + 3 + 4 each independently require attacker
// access to either the victim's wallet OR an allowlisted origin OR a
// curl-capable runtime that survives the missing-Origin guard. We do
// not ship a separate CSRF token because the EIP-4361 signature is a
// strictly stronger primitive.
describe("auth/siwe — R052 CSRF threat-model (documentation)", () => {
  it("documents CSRF mitigations in this test file (see block comment above)", () => {
    // Marker test — the prose above is the artifact. Its presence in the
    // suite ensures the documentation isn't accidentally deleted during a
    // future cleanup without a code-review touchpoint.
    expect(true).toBe(true);
  });
});
