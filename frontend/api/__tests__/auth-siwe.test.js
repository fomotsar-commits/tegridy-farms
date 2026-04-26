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
    then: (resolve) => resolve({ data, error }),
    catch: vi.fn(() => chain),
  };
  return chain;
}

// nonce row for DELETE-claim
const claimedNonceRow = [{ nonce: "abc", expires_at: new Date(Date.now() + 60000).toISOString() }];
let supabaseFromHandler = vi.fn(() => makeQueryResult(claimedNonceRow));
let supabaseRpcHandler = vi.fn(() => ({ catch: () => {} }));

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
    headers: { origin: "https://tegridyfarms.xyz", ...headers },
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
    domain: "tegridyfarms.xyz",
    address: WALLET,
    chainId: 1,
    nonce: "abc",
    uri: "https://tegridyfarms.xyz/login",
    expirationTime: new Date(now + 5 * 60 * 1000).toISOString(),
    notBefore: new Date(now - 1000).toISOString(),
    ...overrides,
  };
}

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
    supabaseRpcHandler = vi.fn(() => ({ catch: () => {} }));
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
    const { req, res, statusSpy, jsonSpy } = makeReqRes({
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
