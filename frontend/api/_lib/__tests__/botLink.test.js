// @vitest-environment node
//
// Node environment, deliberately: this suite signs real HS256 JWTs with `jose`
// rather than stubbing the verifier, and jsdom's `TextEncoder` produces a
// cross-realm Uint8Array that WebCrypto rejects. Same reason as alerts.test.js.
//
// Telegram link store (api/_lib/botLink.js) — server-side suite.
//
// TWO ASSERTIONS THIS FILE EXISTS FOR.
//
//   1. `telegram_links` ships as a migration FILE applied by hand. Until then
//      PostgREST answers 404/PGRST205, and the tempting thing to do with that is
//      answer `{ linked: false }`. That would tell a chat it is not linked when the
//      truth is that no chat could ever have been linked, and it would tell the bot
//      to keep minting codes that can never be claimed. The missing table gets its
//      own status, `code`, and operator step, and they are pinned below.
//
//   2. The bot's credential can begin, read and revoke — never bind. Binding needs
//      a wallet signature, which only the browser can produce. A bot-signed request
//      that reached `claim` would make this venue's bot exactly as dangerous as the
//      ones it was built not to be, so the boundary is tested from the outside:
//      every action name is fed to the bot path and only three of them work.
//
// The rest covers the gates in dispatch order (method → body cap → origin/signature
// → rate limit → config → auth → revocation) and the three filters that make a
// claim single-use.
//
// Mock/req/res conventions mirror api/_lib/__tests__/alerts.test.js.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SignJWT } from "jose";
import { createHmac } from "node:crypto";

vi.mock("../ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

// The JWT-revocation lookup, stubbed to "not revoked" so the PostgREST queue below
// holds only the calls each test is about. The revocation gate itself is covered by
// api/__tests__/supabase-proxy.test.js and alerts.test.js, which own that pattern —
// duplicating it here would test `jose` and `@supabase/supabase-js` a third time
// rather than testing this file.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  }),
}));

const { handleBotLink, canonicalBotBody, LINK_CODE_RE } = await import("../botLink.js");

const WALLET = "0x1111111111111111111111111111111111111111";
const CHAT_REF = "a".repeat(64);
const LINK_ID = "11111111-2222-4333-8444-555555555555";
const JWT_SECRET = "test-secret-that-is-long-enough-for-hs256-aaaaaaa";
const BOT_SECRET = "bot-secret-shared-with-the-service";

async function makeJwt(over = {}) {
  return new SignJWT({ wallet: WALLET, role: "authenticated", jti: "jti-1", ...over })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(WALLET)
    .setIssuer("supabase")
    .setAudience("authenticated")
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(JWT_SECRET));
}

function makeRes() {
  const state = { status: null, json: null, headers: {}, ended: false };
  const res = {
    setHeader: (k, v) => ((state.headers[k] = v), res),
    status: (c) => ((state.status = c), res),
    json: (p) => ((state.json = p), res),
    end: () => ((state.ended = true), res),
  };
  return { res, state };
}

/** A request the BOT would make: signed, no Origin, no cookie. */
function botReq(body, { secret = BOT_SECRET, skewMs = 0 } = {}) {
  const raw = canonicalBotBody(body);
  const timestamp = String(Math.floor((Date.now() + skewMs) / 1000));
  return {
    method: "POST",
    query: {},
    body,
    headers: {
      "x-bot-timestamp": timestamp,
      "x-bot-signature": createHmac("sha256", secret).update(`${timestamp}.${raw}`, "utf8").digest("hex"),
    },
  };
}

/** A request the BROWSER would make: origin-gated, SIWE cookie. */
function browserReq({ method = "GET", body, jwt } = {}) {
  return {
    method,
    query: {},
    body,
    headers: {
      origin: "https://memetic.fun",
      ...(jwt ? { cookie: `siwe_jwt=${jwt}` } : {}),
    },
  };
}

/** PostgREST's answer when the table has never been created. */
const PGRST205 = {
  ok: false,
  status: 404,
  body: null,
  text: async () => JSON.stringify({ code: "PGRST205", message: "Could not find the table in the schema cache" }),
};

const rows = (data, status = 200) => ({
  ok: status < 400,
  status,
  body: null,
  text: async () => JSON.stringify(data),
});

/** Every PostgREST call answers from this queue, in order. */
function stubPostgrest(...responses) {
  const calls = [];
  const fetchMock = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    return responses.shift() ?? rows([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://db.example.com";
  process.env.SUPABASE_ANON_KEY = "anon-key";
  process.env.SUPABASE_SERVICE_KEY = "service-key";
  process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
  process.env.BOT_LINK_SECRET = BOT_SECRET;
  delete process.env.NODE_ENV;
  delete process.env.VERCEL_ENV;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ─── 1. The missing table ────────────────────────────────────────────────────

describe("an unapplied migration is never an answer about a chat", () => {
  it("status answers 503 schema-missing, NOT linked:false", async () => {
    stubPostgrest(PGRST205);
    const { res, state } = makeRes();
    await handleBotLink(botReq({ action: "status", chatRef: CHAT_REF }), res);

    expect(state.status).toBe(503);
    expect(state.json.code).toBe("schema-missing");
    expect(state.json).not.toHaveProperty("linked");
    expect(state.json.operatorStep).toMatch(/020_telegram_links\.sql/);
  });

  it("begin answers 503 rather than handing out a code that can never be claimed", async () => {
    stubPostgrest(PGRST205);
    const { res, state } = makeRes();
    await handleBotLink(botReq({ action: "begin", chatRef: CHAT_REF }), res);

    expect(state.status).toBe(503);
    expect(state.json.code).toBe("schema-missing");
    expect(state.json).not.toHaveProperty("code:");
    expect(state.json.error).toMatch(/could ever be claimed/i);
  });

  it("revoke answers 503 rather than reporting a removal that did not happen", async () => {
    stubPostgrest(PGRST205);
    const { res, state } = makeRes();
    await handleBotLink(botReq({ action: "revoke", chatRef: CHAT_REF }), res);
    expect(state.status).toBe(503);
    expect(state.json).not.toHaveProperty("removed");
  });

  it("a deployment with no store configured says so instead of answering", async () => {
    delete process.env.SUPABASE_JWT_SECRET;
    const { res, state } = makeRes();
    await handleBotLink(botReq({ action: "status", chatRef: CHAT_REF }), res);
    expect(state.status).toBe(503);
    expect(state.json.code).toBe("not-configured");
    expect(state.json.error).toMatch(/Nothing here says your chat is unlinked/i);
  });
});

// ─── 2. The bot cannot bind ──────────────────────────────────────────────────

describe("the bot credential reaches three actions and no others", () => {
  for (const action of ["claim", "mine", "link", "bind", "revoke-mine", ""]) {
    it(`refuses "${action}" on the bot path`, async () => {
      stubPostgrest();
      const { res, state } = makeRes();
      await handleBotLink(botReq({ action, chatRef: CHAT_REF }), res);
      expect(state.status).toBe(400);
      expect(state.json.error).toBe("Unknown action.");
    });
  }

  it("a bot-signed claim cannot attach a wallet even with a valid signature", async () => {
    // The signed body carries only {action, chatRef}; `code` is not signed and is
    // not read on this path. The request dies at the action check above the store.
    stubPostgrest();
    const { res, state } = makeRes();
    const req = botReq({ action: "claim", chatRef: CHAT_REF });
    req.body.code = "ABCDEFGHJK";
    await handleBotLink(req, res);
    expect(state.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("the bot proves itself with an HMAC, not with an origin", () => {
  it("rejects a wrong signature without touching the store", async () => {
    stubPostgrest();
    const { res, state } = makeRes();
    await handleBotLink(botReq({ action: "status", chatRef: CHAT_REF }, { secret: "wrong" }), res);
    expect(state.status).toBe(401);
    expect(state.json.code).toBe("bad-signature");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a replayed signature outside the skew window", async () => {
    stubPostgrest();
    const { res, state } = makeRes();
    await handleBotLink(botReq({ action: "status", chatRef: CHAT_REF }, { skewMs: -600_000 }), res);
    expect(state.status).toBe(401);
    expect(state.json.code).toBe("stale");
  });

  it("says not-configured, not bad-signature, when the deployment holds no secret", async () => {
    // One needs an operator to set a variable and the bot must stop retrying; the
    // other is a compromise indicator. Collapsing them loses both signals.
    delete process.env.BOT_LINK_SECRET;
    stubPostgrest();
    const { res, state } = makeRes();
    await handleBotLink(botReq({ action: "status", chatRef: CHAT_REF }), res);
    expect(state.status).toBe(503);
    expect(state.json.code).toBe("not-configured");
  });

  it("refuses a raw Telegram id where a digest belongs", async () => {
    stubPostgrest();
    const { res, state } = makeRes();
    await handleBotLink(botReq({ action: "status", chatRef: "123456789" }), res);
    expect(state.status).toBe(400);
    expect(state.json.error).toMatch(/64-character lowercase hex/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ─── 3. Reads are pinned to one chat ─────────────────────────────────────────

describe("every bot read names exactly one chat", () => {
  it("status filters on the chat_ref and returns linked:false only after an answer", async () => {
    const calls = stubPostgrest(rows([]));
    const { res, state } = makeRes();
    await handleBotLink(botReq({ action: "status", chatRef: CHAT_REF }), res);

    expect(calls[0].url).toContain(`chat_ref=eq.${CHAT_REF}`);
    expect(calls[0].url).toContain("limit=1");
    expect(state.status).toBe(200);
    expect(state.json).toEqual({ linked: false });
  });

  it("returns the wallet when there is one", async () => {
    stubPostgrest(rows([{ wallet: WALLET, linked_at: "2026-08-01T00:00:00Z" }]));
    const { res, state } = makeRes();
    await handleBotLink(botReq({ action: "status", chatRef: CHAT_REF }), res);
    expect(state.json).toMatchObject({ linked: true, wallet: WALLET });
  });

  it("a store error is a 502, never linked:false", async () => {
    stubPostgrest(rows({ message: "boom" }, 500));
    const { res, state } = makeRes();
    await handleBotLink(botReq({ action: "status", chatRef: CHAT_REF }), res);
    expect(state.status).toBe(502);
    expect(state.json).not.toHaveProperty("linked");
  });
});

describe("begin", () => {
  it("refuses to mint over a live binding, and names the wallet that holds it", async () => {
    // Overwriting would silently detach the wallet that was there, and the user
    // finds out when their answers stop.
    stubPostgrest(rows([{ wallet: WALLET }]));
    const { res, state } = makeRes();
    await handleBotLink(botReq({ action: "begin", chatRef: CHAT_REF }), res);
    expect(state.status).toBe(409);
    expect(state.json.code).toBe("already-linked");
    expect(state.json.wallet).toBe(WALLET);
  });

  it("mints a code of the shape both sides validate, and echoes what was STORED", async () => {
    const calls = stubPostgrest(
      rows([]),
      rows([{ link_code: "ZZZZZZZZZZ", code_expires_at: "2026-08-01T00:10:00Z" }], 201),
    );
    const { res, state } = makeRes();
    await handleBotLink(botReq({ action: "begin", chatRef: CHAT_REF }), res);

    expect(state.status).toBe(201);
    // The row's value, not the one this process hoped to write — the user is about
    // to read it off a screen.
    expect(state.json.code).toBe("ZZZZZZZZZZ");
    const written = JSON.parse(calls[1].init.body);
    expect(written.link_code).toMatch(LINK_CODE_RE);
    expect(written.wallet).toBeNull();
    expect(written.linked_at).toBeNull();
    expect(calls[1].url).toContain("on_conflict=chat_ref");
  });

  it("does not report success on a code-collision 409", async () => {
    stubPostgrest(rows([]), rows({ message: "duplicate key" }, 409));
    const { res, state } = makeRes();
    await handleBotLink(botReq({ action: "begin", chatRef: CHAT_REF }), res);
    expect(state.status).toBe(409);
    expect(state.json.code).toBe("collision");
  });
});

describe("revoke", () => {
  it("says the binding is still in place when the delete failed", async () => {
    stubPostgrest(rows({ message: "boom" }, 500));
    const { res, state } = makeRes();
    await handleBotLink(botReq({ action: "revoke", chatRef: CHAT_REF }), res);
    expect(state.status).toBe(502);
    expect(state.json.error).toMatch(/still in place/i);
  });

  it("reports zero removals honestly rather than as a removal", async () => {
    stubPostgrest(rows([]));
    const { res, state } = makeRes();
    await handleBotLink(botReq({ action: "revoke", chatRef: CHAT_REF }), res);
    expect(state.json).toEqual({ removed: 0 });
  });
});

// ─── 4. The browser path ─────────────────────────────────────────────────────

describe("binding requires the wallet's own session", () => {
  it("rejects a browser call with no cookie", async () => {
    stubPostgrest();
    const { res, state } = makeRes();
    await handleBotLink(browserReq({ method: "POST", body: { action: "claim", code: "ABCDEFGHJK" } }), res);
    expect(state.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("claims with all three filters, so a code is single-use and cannot re-home a wallet", async () => {
    const jwt = await makeJwt();
    const calls = stubPostgrest(
      rows([]), // the per-wallet ceiling count
      rows([{ linked_at: "2026-08-01T00:00:00Z" }]), // the PATCH's returned representation
    );
    const { res, state } = makeRes();
    await handleBotLink(browserReq({ method: "POST", body: { action: "claim", code: "abcdefghjk" }, jwt }), res);

    expect(state.status).toBe(201);
    const patch = calls.find((c) => c.init?.method === "PATCH");
    expect(patch.url).toContain("link_code=eq.ABCDEFGHJK");
    expect(patch.url).toContain("code_expires_at=gt.");
    expect(patch.url).toContain("wallet=is.null");
    const written = JSON.parse(patch.init.body);
    expect(written.wallet).toBe(WALLET);
    expect(written.link_code).toBeNull();
    expect(written.code_expires_at).toBeNull();
  });

  it("gives one message for expired, spent and never-real, so it is not a guessing oracle", async () => {
    const jwt = await makeJwt();
    stubPostgrest(rows([]), rows([]));
    const { res, state } = makeRes();
    await handleBotLink(browserReq({ method: "POST", body: { action: "claim", code: "ABCDEFGHJK" }, jwt }), res);
    expect(state.status).toBe(404);
    expect(state.json.code).toBe("code-not-open");
  });

  it("rejects a malformed code before spending a query", async () => {
    const jwt = await makeJwt();
    stubPostgrest();
    const { res, state } = makeRes();
    await handleBotLink(browserReq({ method: "POST", body: { action: "claim", code: "nope" }, jwt }), res);
    expect(state.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never returns the chat digest to the owner", async () => {
    // Useless to them, and the one value that identifies a Telegram account.
    const jwt = await makeJwt();
    const calls = stubPostgrest(rows([{ id: LINK_ID, linked_at: "2026-08-01T00:00:00Z", chat_ref: CHAT_REF }]));
    const { res, state } = makeRes();
    await handleBotLink(browserReq({ jwt }), res);
    expect(calls[0].url).toContain("select=id,linked_at");
    expect(calls[0].url).not.toContain("chat_ref");
    expect(state.status).toBe(200);
  });

  it("a browser call from a foreign origin is refused", async () => {
    process.env.NODE_ENV = "production";
    stubPostgrest();
    const { res, state } = makeRes();
    const req = browserReq({});
    req.headers.origin = "https://evil.example";
    await handleBotLink(req, res);
    expect(state.status).toBe(403);
  });

  it("caps the body, so this endpoint is not a place to post a megabyte", async () => {
    stubPostgrest();
    const { res, state } = makeRes();
    await handleBotLink(browserReq({ method: "POST", body: { action: "claim", pad: "x".repeat(4000) } }), res);
    expect(state.status).toBe(413);
  });
});
