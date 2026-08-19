// @vitest-environment node
//
// Node environment, deliberately: this suite signs real HS256 JWTs with `jose`
// rather than stubbing the verifier, and jsdom's `TextEncoder` produces a
// cross-realm Uint8Array that WebCrypto rejects. Testing the real verify path is
// worth the directive — a stubbed verifier would let a broken auth gate pass.
//
// Alert-rule store (api/_lib/alerts.js) — server-side suite.
//
// THE ASSERTION THIS FILE EXISTS FOR: `alert_rules` ships as a migration FILE and
// is applied by an operator by hand. Until it is, PostgREST answers 404/PGRST205,
// and the only tempting thing to do with that is return `{ rules: [] }`. That
// would tell a user they have no alert rules when the truth is that no rule could
// ever have been saved — and it would tell them so on the exact deployment where
// they are least protected. So the missing table has its own status code, its own
// `code`, and its own operator step, and the tests below pin all three.
//
// The rest covers the gates in dispatch order (method → origin → rate limit →
// config → auth → revocation), the write validator, the per-wallet ceiling, and
// the `delivery` block, which is the only place the server can tell the browser
// something the browser cannot see: whether the PRIVATE VAPID half exists.
//
// Mock/req/res conventions mirror api/_lib/__tests__/heat.test.js.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SignJWT } from "jose";

vi.mock("../ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

const WALLET = "0x1111111111111111111111111111111111111111";
const SUBJECT = "0x420698cfdeddea6bc78d59bc17798113ad278f9d";
const RULE_ID = "11111111-2222-3333-4444-555555555555";
const JWT_SECRET = "test-secret-that-is-long-enough-for-hs256-aaaaaaa";

async function makeJwt(over = {}) {
  return new SignJWT({ wallet: WALLET, role: "authenticated", jti: "jti-1", ...over })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(WALLET)
    .setIssuer("supabase")
    .setAudience("authenticated")
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(JWT_SECRET));
}

function makeReq({ method = "GET", headers = {}, body = undefined, query = {} } = {}) {
  return {
    method,
    query,
    body,
    headers: { origin: "https://memetic.fun", ...headers },
  };
}

function makeRes() {
  const state = { status: null, json: null, headers: {}, ended: false };
  const res = {
    setHeader: (k, v) => {
      state.headers[k] = v;
      return res;
    },
    status: (c) => {
      state.status = c;
      return res;
    },
    json: (p) => {
      state.json = p;
      return res;
    },
    end: () => {
      state.ended = true;
      return res;
    },
  };
  return { res, state };
}

/** PostgREST's answer when the table has never been created. */
const SCHEMA_MISSING_BODY = JSON.stringify({
  code: "PGRST205",
  message: "Could not find the table 'public.alert_rules' in the schema cache",
});

function upstream(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    body: null,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

let handleAlerts;
let fetchMock;
let consoleErrorSpy;

async function load() {
  ({ handleAlerts } = await import("../alerts.js"));
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.NODE_ENV = "test";
  delete process.env.VERCEL_ENV;
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_ANON_KEY = "anon-key";
  process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
  delete process.env.SUPABASE_SERVICE_KEY;
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  fetchMock = vi.fn(async () => upstream(200, []));
  vi.stubGlobal("fetch", fetchMock);
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  await load();
});

afterEach(() => {
  vi.unstubAllGlobals();
  consoleErrorSpy?.mockRestore();
});

async function authedCookie() {
  return { cookie: `siwe_jwt=${await makeJwt()}` };
}

describe("a missing table is never an empty rule list", () => {
  it("GET answers 503 with code schema-missing, not 200 with []", async () => {
    fetchMock.mockResolvedValue(upstream(404, SCHEMA_MISSING_BODY));
    const { res, state } = makeRes();
    await handleAlerts(makeReq({ headers: await authedCookie() }), res);
    expect(state.status).toBe(503);
    expect(state.json.code).toBe("schema-missing");
    expect(state.json.rules).toBeUndefined();
  });

  it("says it is a missing migration, not an empty rule list, in those words", async () => {
    fetchMock.mockResolvedValue(upstream(404, SCHEMA_MISSING_BODY));
    const { res, state } = makeRes();
    await handleAlerts(makeReq({ headers: await authedCookie() }), res);
    expect(state.json.error).toMatch(/missing migration, not an empty rule list/i);
  });

  it("names the migration file the operator has to apply", async () => {
    fetchMock.mockResolvedValue(upstream(404, SCHEMA_MISSING_BODY));
    const { res, state } = makeRes();
    await handleAlerts(makeReq({ headers: await authedCookie() }), res);
    expect(state.json.operatorStep).toMatch(/016_alert_rules\.sql/);
  });

  it("a create against a missing table says the rule was NOT saved", async () => {
    fetchMock.mockResolvedValue(upstream(404, SCHEMA_MISSING_BODY));
    const { res, state } = makeRes();
    await handleAlerts(
      makeReq({
        method: "POST",
        headers: await authedCookie(),
        body: { action: "create", kind: "heat-tier", subject: SUBJECT },
      }),
      res,
    );
    expect(state.status).toBe(503);
    expect(state.json.code).toBe("schema-missing");
    expect(state.json.error).toMatch(/not saved/i);
  });

  it("detects the 42P01 spelling too", async () => {
    fetchMock.mockResolvedValue(upstream(400, JSON.stringify({ code: "42P01", message: "relation does not exist" })));
    const { res, state } = makeRes();
    await handleAlerts(makeReq({ headers: await authedCookie() }), res);
    expect(state.json.code).toBe("schema-missing");
  });
});

describe("an unconfigured deployment refuses to answer the question", () => {
  it("503 not-configured when Supabase env is absent", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    const { res, state } = makeRes();
    await handleAlerts(makeReq({ headers: await authedCookie() }), res);
    expect(state.status).toBe(503);
    expect(state.json.code).toBe("not-configured");
    expect(state.json.error).toMatch(/Nothing here says you have no rules/i);
  });

  it("names every variable the operator must set", async () => {
    delete process.env.SUPABASE_JWT_SECRET;
    const { res, state } = makeRes();
    await handleAlerts(makeReq({ headers: await authedCookie() }), res);
    for (const key of ["SUPABASE_URL", "SUPABASE_JWT_SECRET"]) {
      expect(state.json.operatorStep).toContain(key);
    }
  });

  it("not-configured is checked before auth — it is the more actionable fact", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    const { res, state } = makeRes();
    await handleAlerts(makeReq(), res); // no cookie at all
    expect(state.json.code).toBe("not-configured");
  });
});

describe("delivery is reported on every response, including failures", () => {
  it("reports no push and no worker when VAPID is unset", async () => {
    const { res, state } = makeRes();
    await handleAlerts(makeReq(), res);
    expect(state.json.delivery.pushConfigured).toBe(false);
    expect(state.json.delivery.backgroundWorker).toBe(false);
    expect(state.json.delivery.detail).toMatch(/no push can be sent/i);
  });

  it("a HALF-configured deployment still reports pushConfigured false", async () => {
    // The browser only sees VITE_VAPID_PUBLIC_KEY, so this is the exact shape that
    // would otherwise render as "push enabled" and deliver nothing.
    process.env.VAPID_PUBLIC_KEY = "pub";
    await load();
    const { res, state } = makeRes();
    await handleAlerts(makeReq(), res);
    expect(state.json.delivery.pushConfigured).toBe(false);
  });

  it("with both halves set it still reports no background worker", async () => {
    process.env.VAPID_PUBLIC_KEY = "pub";
    process.env.VAPID_PRIVATE_KEY = "priv";
    await load();
    const { res, state } = makeRes();
    await handleAlerts(makeReq(), res);
    expect(state.json.delivery.pushConfigured).toBe(true);
    expect(state.json.delivery.backgroundWorker).toBe(false);
    expect(state.json.delivery.detail).toMatch(/nothing runs on a schedule/i);
  });
});

describe("gates", () => {
  it("OPTIONS preflight answers 200 before anything else", async () => {
    const { res, state } = makeRes();
    await handleAlerts(makeReq({ method: "OPTIONS" }), res);
    expect(state.status).toBe(200);
    expect(state.ended).toBe(true);
  });

  it("rejects methods it does not implement", async () => {
    const { res, state } = makeRes();
    await handleAlerts(makeReq({ method: "PUT" }), res);
    expect(state.status).toBe(405);
  });

  it("enforces the origin in prod-like environments", async () => {
    process.env.NODE_ENV = "production";
    await load();
    const { res, state } = makeRes();
    await handleAlerts(makeReq({ headers: { origin: "https://evil.example" } }), res);
    expect(state.status).toBe(403);
  });

  it("401 without a SIWE cookie", async () => {
    const { res, state } = makeRes();
    await handleAlerts(makeReq(), res);
    expect(state.status).toBe(401);
  });

  it("401 on a JWT signed with the wrong secret", async () => {
    const bad = await new SignJWT({ wallet: WALLET, jti: "x" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("supabase")
      .setAudience("authenticated")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("a-different-secret-that-is-long-enough!!"));
    const { res, state } = makeRes();
    await handleAlerts(makeReq({ headers: { cookie: `siwe_jwt=${bad}` } }), res);
    expect(state.status).toBe(401);
  });

  it("fails closed in prod when a token carries no jti", async () => {
    process.env.NODE_ENV = "production";
    await load();
    const jwt = await new SignJWT({ wallet: WALLET })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("supabase")
      .setAudience("authenticated")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(JWT_SECRET));
    const { res, state } = makeRes();
    await handleAlerts(makeReq({ headers: { origin: "https://memetic.fun", cookie: `siwe_jwt=${jwt}` } }), res);
    expect(state.status).toBe(401);
  });

  it("fails closed in prod when the revocation store is unreachable", async () => {
    process.env.NODE_ENV = "production";
    await load();
    const { res, state } = makeRes();
    await handleAlerts(makeReq({ headers: { origin: "https://memetic.fun", ...(await authedCookie()) } }), res);
    expect(state.status).toBe(503);
    expect(state.json.error).toMatch(/Auth service not configured/i);
  });
});

describe("reads", () => {
  it("returns rules and forwards the caller's own JWT, never the service key", async () => {
    const row = { id: RULE_ID, kind: "heat-tier", subject: SUBJECT, threshold: null, enabled: true };
    fetchMock.mockResolvedValue(upstream(200, [row]));
    const headers = await authedCookie();
    const { res, state } = makeRes();
    await handleAlerts(makeReq({ headers }), res);
    expect(state.status).toBe(200);
    expect(state.json.rules).toEqual([row]);
    const sent = fetchMock.mock.calls[0][1];
    expect(sent.headers.Authorization).toBe(`Bearer ${headers.cookie.split("=")[1]}`);
  });

  it("marks the response no-store — a per-wallet list must not sit in a shared cache", async () => {
    fetchMock.mockResolvedValue(upstream(200, []));
    const { res, state } = makeRes();
    await handleAlerts(makeReq({ headers: await authedCookie() }), res);
    expect(state.headers["Cache-Control"]).toBe("no-store");
  });

  it("a non-array body is a 502, not an empty list", async () => {
    fetchMock.mockResolvedValue(upstream(200, { oops: true }));
    const { res, state } = makeRes();
    await handleAlerts(makeReq({ headers: await authedCookie() }), res);
    expect(state.status).toBe(502);
  });

  it("an unparseable body is a 502, not an empty list", async () => {
    fetchMock.mockResolvedValue(upstream(200, "<html>gateway</html>"));
    const { res, state } = makeRes();
    await handleAlerts(makeReq({ headers: await authedCookie() }), res);
    expect(state.status).toBe(502);
  });
});

describe("writes are validated before anything is stored", () => {
  async function post(body) {
    const { res, state } = makeRes();
    await handleAlerts(makeReq({ method: "POST", headers: await authedCookie(), body }), res);
    return state;
  }

  it("rejects an unknown rule kind", async () => {
    const state = await post({ action: "create", kind: "price-prediction", subject: SUBJECT });
    expect(state.status).toBe(400);
  });

  it("rejects a malformed subject", async () => {
    const state = await post({ action: "create", kind: "heat-tier", subject: "0x123" });
    expect(state.status).toBe(400);
  });

  it("requires a positive threshold for whale-move", async () => {
    for (const threshold of [undefined, null, 0, -1, "abc"]) {
      const state = await post({ action: "create", kind: "whale-move", subject: SUBJECT, threshold });
      expect(state.status, String(threshold)).toBe(400);
    }
  });

  it("rejects a threshold on a kind that ignores it, rather than silently dropping it", async () => {
    const state = await post({ action: "create", kind: "heat-tier", subject: SUBJECT, threshold: 5000 });
    expect(state.status).toBe(400);
    expect(state.json.error).toMatch(/does not take a threshold/i);
  });

  it("rejects a non-uuid rule id", async () => {
    expect((await post({ action: "delete", id: "../../etc/passwd" })).status).toBe(400);
  });

  it("rejects an unknown action", async () => {
    expect((await post({ action: "drop-table" })).status).toBe(400);
  });

  it("stores the VERIFIED wallet, never one supplied by the caller", async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      if (init?.method === "POST") return upstream(201, [{ id: RULE_ID }]);
      return upstream(200, []);
    });
    await post({
      action: "create",
      kind: "heat-tier",
      subject: SUBJECT,
      wallet: "0x9999999999999999999999999999999999999999",
    });
    const write = fetchMock.mock.calls.find((c) => c[1]?.method === "POST");
    expect(JSON.parse(write[1].body).wallet).toBe(WALLET);
  });

  it("enforces a hard per-wallet ceiling against what the database holds", async () => {
    const full = Array.from({ length: 25 }, (_, i) => ({ id: `id-${i}` }));
    fetchMock.mockResolvedValue(upstream(200, full));
    const state = await post({ action: "create", kind: "heat-tier", subject: SUBJECT });
    expect(state.status).toBe(409);
    expect(state.json.error).toMatch(/ceiling/i);
  });

  it("a duplicate is a 409, not a second identical rule", async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      if (init?.method === "POST") return upstream(409, { code: "23505" });
      return upstream(200, []);
    });
    const state = await post({ action: "create", kind: "heat-tier", subject: SUBJECT });
    expect(state.status).toBe(409);
  });

  it("delete and toggle scope the row to the verified wallet as well as its id", async () => {
    fetchMock.mockResolvedValue(upstream(200, []));
    await post({ action: "delete", id: RULE_ID });
    const call = fetchMock.mock.calls.find((c) => c[1]?.method === "DELETE");
    expect(call[0]).toContain(`id=eq.${RULE_ID}`);
    expect(call[0]).toContain(`wallet=eq.${WALLET}`);
  });

  it("an oversized body is refused before it reaches the database", async () => {
    const state = await post({ action: "create", kind: "heat-tier", subject: SUBJECT, pad: "x".repeat(9000) });
    expect(state.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
