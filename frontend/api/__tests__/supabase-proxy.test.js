// AUDIT API-M8 integration test: verifies the proxy runs validation BEFORE
// forwarding to PostgREST, and rejects bad payloads without making a single
// upstream call.

import { describe, it, expect, beforeEach, vi } from "vitest";

const WALLET_A = "0x" + "a".repeat(40);
const WALLET_B = "0x" + "b".repeat(40);

// Stub jose.jwtVerify so we don't need a real SIWE_JWT_SECRET to run tests.
// The stub returns a fixed wallet claim, identical to what a real decode
// would yield for WALLET_A.
vi.mock("jose", () => ({
  jwtVerify: vi.fn(async () => ({ payload: { wallet: WALLET_A } })),
}));

// Rate-limiter is pass-through in tests (no Upstash env vars set).
vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
}));

// Global fetch stub — each test asserts whether it was called.
const fetchMock = vi.fn(async () => ({
  status: 200,
  text: async () => JSON.stringify({ ok: true }),
}));
globalThis.fetch = fetchMock;

// Env has to be set BEFORE the handler is imported (it reads JWT_SECRET at
// module-init). Use beforeEach to reset counts; the handler is imported
// dynamically per test to pick up env mutations.
process.env.SUPABASE_JWT_SECRET = "test-secret-for-vitest-only-not-real";
process.env.VITE_SUPABASE_URL = "https://test.supabase.co";
process.env.VITE_SUPABASE_ANON_KEY = "test-anon-key";

// Helper to build a minimal req/res pair.
function makeReqRes(body, cookie = "siwe_jwt=fake-jwt") {
  const req = {
    method: "POST",
    headers: { cookie },
    body,
  };
  const statusSpy = vi.fn();
  const jsonSpy = vi.fn();
  const res = {
    status: (code) => { statusSpy(code); return res; },
    json: (payload) => { jsonSpy(payload); return res; },
    setHeader: vi.fn(),
    end: vi.fn(),
  };
  return { req, res, statusSpy, jsonSpy };
}

describe("supabase-proxy — validation integration", () => {
  let handler;

  beforeEach(async () => {
    fetchMock.mockClear();
    // Fresh import each test so module state can't leak across tests.
    vi.resetModules();
    handler = (await import("../supabase-proxy.js")).default;
  });

  it("happy path: valid message passes validation and hits upstream", async () => {
    const { req, res, statusSpy, jsonSpy } = makeReqRes({
      table: "messages",
      method: "INSERT",
      body: { author: WALLET_A, text: "gm", slug: "nakamigos" },
    });
    await handler(req, res);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(jsonSpy).toHaveBeenCalled();
  });

  it("rejects oversize text BEFORE upstream fetch", async () => {
    const { req, res, statusSpy, jsonSpy } = makeReqRes({
      table: "messages",
      method: "INSERT",
      body: { author: WALLET_A, text: "x".repeat(281), slug: "nakamigos" },
    });
    await handler(req, res);
    // Critical assertion: NO upstream call on validation failure.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Invalid payload shape" });
  });

  it("rejects unknown field BEFORE upstream fetch", async () => {
    const { req, res, statusSpy, jsonSpy } = makeReqRes({
      table: "messages",
      method: "INSERT",
      body: { author: WALLET_A, text: "hi", slug: "x", is_admin: true },
    });
    await handler(req, res);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Invalid payload shape" });
  });

  it("rejects author-mismatch BEFORE upstream fetch", async () => {
    const { req, res, statusSpy, jsonSpy } = makeReqRes({
      table: "messages",
      method: "INSERT",
      body: { author: WALLET_B, text: "hi", slug: "x" },
    });
    await handler(req, res);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "author mismatch" });
  });

  it("rejects wallet-mismatch on profile write BEFORE upstream fetch", async () => {
    const { req, res, statusSpy, jsonSpy } = makeReqRes({
      table: "user_profiles",
      method: "UPSERT",
      body: { wallet: WALLET_B, display_name: "evil" },
    });
    await handler(req, res);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "wallet mismatch" });
  });

  it("DELETE without body is not blocked by validation", async () => {
    const { req, res, statusSpy } = makeReqRes({
      table: "user_favorites",
      method: "DELETE",
      match: { wallet: WALLET_A, token_id: "42" },
    });
    await handler(req, res);
    // DELETE still hits upstream — validation doesn't run.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(statusSpy).toHaveBeenCalledWith(200);
  });

  it("401 when no cookie is present", async () => {
    const { req, res, statusSpy, jsonSpy } = makeReqRes(
      { table: "messages", method: "INSERT", body: {} },
      "", // no cookie
    );
    await handler(req, res);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Not authenticated" });
  });

  it("400 on invalid table", async () => {
    const { req, res, statusSpy } = makeReqRes({
      table: "evil_table",
      method: "INSERT",
      body: {},
    });
    await handler(req, res);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statusSpy).toHaveBeenCalledWith(400);
  });

  it("rejects wallet-mismatch on batch user_favorites BEFORE upstream fetch", async () => {
    const { req, res, statusSpy, jsonSpy } = makeReqRes({
      table: "user_favorites",
      method: "UPSERT",
      body: [
        { wallet: WALLET_A, token_id: "1" },
        { wallet: WALLET_B, token_id: "2" }, // impersonation attempt
      ],
    });
    await handler(req, res);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "wallet mismatch" });
  });
});
