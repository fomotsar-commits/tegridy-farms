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

// Chat holder gate is stubbed so these cases stay about the proxy's own
// ordering and forwarding. Its real behaviour (fail-closed on RPC outage,
// unknown slug, zero balance) is pinned in holder-gate.test.js. Default is
// "allow" so every pre-existing case keeps its exact upstream-fetch count;
// individual cases below override it.
const assertChatHolderMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("../_lib/holder-gate.js", () => ({
  assertChatHolder: assertChatHolderMock,
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
    assertChatHolderMock.mockClear();
    assertChatHolderMock.mockResolvedValue({ ok: true });
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

  // --- RPC path (F714): the wallet-injection invariant is the security boundary
  // for toggle_like / toggle_reaction. Pin it so a future refactor of the RPC
  // branch can't silently drop the override or the allowlist. ---

  it("RPC injects the JWT wallet, OVERRIDING a client-supplied wallet", async () => {
    const { req, res, statusSpy } = makeReqRes({
      method: "RPC",
      fn: "toggle_reaction",
      // Attacker tries to act as WALLET_B; the proxy must overwrite it with the
      // JWT-verified WALLET_A before forwarding to PostgREST.
      args: { msg_id: "11111111-1111-1111-1111-111111111111", emoji: "🔥", wallet: WALLET_B },
    });
    await handler(req, res);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/rest/v1/rpc/toggle_reaction");
    const forwarded = JSON.parse(opts.body);
    expect(forwarded.wallet).toBe(WALLET_A); // injected, NOT WALLET_B
    expect(statusSpy).toHaveBeenCalledWith(200);
  });

  it("rejects an un-allowlisted RPC function BEFORE upstream fetch", async () => {
    const { req, res, statusSpy, jsonSpy } = makeReqRes({
      method: "RPC",
      fn: "delete_all_messages", // not in ALLOWED_RPCS
      args: {},
    });
    await handler(req, res);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Invalid function" });
  });

  // --- Holder gate: the server-side half of the "HOLDER EXCLUSIVE" claim the
  // chat UI renders (CommunityChat.jsx:925-932). Pre-fix the proxy authenticated
  // (which wallet) but never authorized (does it hold the collection), so any
  // free SIWE signature could post into a holder-only room. ---

  it("a denied holder check blocks the INSERT BEFORE upstream fetch", async () => {
    assertChatHolderMock.mockResolvedValue({
      ok: false, status: 403, error: "Holders only — this room requires an NFT from this collection",
    });
    const { req, res, statusSpy, jsonSpy } = makeReqRes({
      table: "messages",
      method: "INSERT",
      body: { author: WALLET_A, text: "gm", slug: "nakamigos" },
    });
    await handler(req, res);
    // The assertion that proves the row never reached PostgREST.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith({
      error: "Holders only — this room requires an NFT from this collection",
    });
  });

  it("propagates the gate's 503 (RPC outage) instead of writing the row", async () => {
    assertChatHolderMock.mockResolvedValue({
      ok: false, status: 503, error: "Holder check temporarily unavailable",
    });
    const { req, res, statusSpy } = makeReqRes({
      table: "messages",
      method: "INSERT",
      body: { author: WALLET_A, text: "gm", slug: "nakamigos" },
    });
    await handler(req, res);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statusSpy).toHaveBeenCalledWith(503);
  });

  it("an allowed holder check still reaches upstream, with the verified wallet", async () => {
    const { req, res, statusSpy } = makeReqRes({
      table: "messages",
      method: "INSERT",
      body: { author: WALLET_A, text: "gm", slug: "nakamigos" },
    });
    await handler(req, res);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(statusSpy).toHaveBeenCalledWith(200);
    // The gate is handed the JWT-verified wallet, never a client-supplied one.
    expect(assertChatHolderMock).toHaveBeenCalledWith(WALLET_A, expect.anything());
  });

  it("does NOT holder-gate DMs, profiles or the like/reaction RPCs", async () => {
    // Gating these would silently break working features that never claimed
    // holder-exclusivity. A denial here would be visible as a blocked fetch.
    assertChatHolderMock.mockResolvedValue({ ok: false, status: 403, error: "nope" });

    const dm = makeReqRes({
      table: "dm_messages",
      method: "INSERT",
      body: {
        sender: WALLET_A, recipient: WALLET_B,
        channel_key: `${WALLET_A}_${WALLET_B}`, text: "hey",
      },
    });
    await handler(dm.req, dm.res);
    expect(dm.statusSpy).toHaveBeenCalledWith(200);

    const profile = makeReqRes({
      table: "user_profiles", method: "UPSERT",
      body: { wallet: WALLET_A, display_name: "me" },
    });
    await handler(profile.req, profile.res);
    expect(profile.statusSpy).toHaveBeenCalledWith(200);

    const rpc = makeReqRes({
      method: "RPC", fn: "toggle_like",
      args: { msg_id: "11111111-1111-1111-1111-111111111111" },
    });
    await handler(rpc.req, rpc.res);
    expect(rpc.statusSpy).toHaveBeenCalledWith(200);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(assertChatHolderMock).not.toHaveBeenCalled();
  });

  it("401 on an RPC call with no cookie (auth gate still applies)", async () => {
    const { req, res, statusSpy, jsonSpy } = makeReqRes(
      { method: "RPC", fn: "toggle_like", args: { msg_id: "x" } },
      "", // no cookie
    );
    await handler(req, res);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Not authenticated" });
  });
});
