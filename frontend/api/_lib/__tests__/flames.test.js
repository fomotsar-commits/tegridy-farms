// Flames-board proxy (api/_lib/flames.js) — server-side suite.
//
// The load-bearing test in this file is THE STRIP. The island's board serves
// `person_id` (a stable UUID for ONE HUMAN across every wallet they have linked)
// and `wallet_count` (how many wallets that human controls). Neither may ever
// reach a public surface. The proxy strips them so the law is structural rather
// than a promise a component could forget, and the assertion below is what makes
// that structural. If it is ever deleted, the leak is silent.
//
// Covers the gates in dispatch order (method → origin → per-IP budget → global
// budget), the clamped upstream query (the SSRF/amplification boundary), the
// allowlist, and the two collapse invariants the file's own comments call
// load-bearing:
//   - upstream 404 means the board is OFF (204, card unmounts), not empty, and
//   - an outage (including a timeout or a shape change) must NEVER read as an
//     empty board.
//
// Mock/req/res conventions mirror api/_lib/__tests__/heat.test.js.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

// The shape read live from https://memetics.wtf/api/flames on 2026-09-06 —
// including the two keys that must not survive, at their real widths.
const UPSTREAM_PAYLOAD = {
  flames: [
    {
      x_username: "@_seacasa",
      x_pfp: null,
      degrees: 1785.14,
      tier: "Elder",
      held_since_unix: 1642281378,
      token_count: 18,
      wallet_count: 14,
      person_id: "0414f482-ef4b-41ea-8961-0235f52e4444",
    },
    {
      x_username: null,
      x_pfp: null,
      degrees: 524.27,
      tier: "Elder",
      held_since_unix: 1644551442,
      token_count: 6,
      wallet_count: 1,
      person_id: "f4d675f2-f78e-4e02-aaec-ccbcbb5d985c",
    },
  ],
  as_of_unix: 1788684733,
};

function makeReq({ method = "GET", query = {}, headers = {} } = {}) {
  return {
    method,
    query,
    headers: { origin: "https://tegridyfarms.vercel.app", ...headers },
  };
}

function makeRes() {
  const headerSpy = vi.fn();
  const statusSpy = vi.fn();
  const jsonSpy = vi.fn();
  const endSpy = vi.fn();
  const res = {
    setHeader: (k, v) => { headerSpy(k, v); return res; },
    status: (c) => { statusSpy(c); return res; },
    json: (p) => { jsonSpy(p); return res; },
    end: endSpy,
  };
  return { res, headerSpy, statusSpy, jsonSpy, endSpy };
}

function mockUpstream({ status = 200, ok = true, payload = UPSTREAM_PAYLOAD, raw = null } = {}) {
  return vi.fn(async () => ({
    ok,
    status,
    headers: { get: () => null },
    body: null,
    text: async () => (raw === null ? JSON.stringify(payload) : raw),
  }));
}

let handleFlames;
let fetchMock;
let consoleErrorSpy;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.NODE_ENV = "test"; // origin gate is permissive in non-prod
  fetchMock = mockUpstream();
  vi.stubGlobal("fetch", fetchMock);
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  ({ handleFlames } = await import("../flames.js"));
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.NODE_ENV;
  delete process.env.VERCEL_ENV;
  delete process.env.ALLOWED_ORIGIN;
  delete process.env.FLAMES_GLOBAL_RPM;
});

// ─── THE STRIP ──────────────────────────────────────────────────────────────
// If any assertion in this block is weakened, a named holder's cross-wallet
// identity reaches a public leaderboard.

describe("the strip (structural, not a promise)", () => {
  it("returns neither wallet_count nor person_id anywhere in the response", async () => {
    const { res, jsonSpy } = makeRes();
    await handleFlames(makeReq({ query: {} }), res);

    const body = jsonSpy.mock.calls[0][0];
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("wallet_count");
    expect(serialised).not.toContain("person_id");
    // The VALUES must be gone too, not merely the key names.
    expect(serialised).not.toContain("0414f482-ef4b-41ea-8961-0235f52e4444");
    expect(serialised).not.toContain("f4d675f2-f78e-4e02-aaec-ccbcbb5d985c");
  });

  it("still paints every field the board legitimately needs", async () => {
    const { res, jsonSpy } = makeRes();
    await handleFlames(makeReq({ query: {} }), res);

    const [first] = jsonSpy.mock.calls[0][0].flames;
    expect(first).toEqual({
      x_username: "@_seacasa",
      degrees: 1785.14,
      tier: "Elder",
      held_since_unix: 1642281378,
      token_count: 18,
    });
  });

  it("drops an identifying field the island adds AFTER this was written", async () => {
    // The allowlist is the whole reason this test can pass. A denylist of the two
    // known keys would forward `person_email` straight to the board.
    fetchMock = mockUpstream({
      payload: {
        flames: [{ ...UPSTREAM_PAYLOAD.flames[0], person_email: "holder@example.com" }],
        as_of_unix: 1,
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const { res, jsonSpy } = makeRes();
    await handleFlames(makeReq({ query: {} }), res);

    const serialised = JSON.stringify(jsonSpy.mock.calls[0][0]);
    expect(serialised).not.toContain("person_email");
    expect(serialised).not.toContain("holder@example.com");
  });

  it("does not forward x_pfp (an off-origin avatar URL is its own CSP decision)", async () => {
    const { res, jsonSpy } = makeRes();
    await handleFlames(makeReq({ query: {} }), res);
    expect(JSON.stringify(jsonSpy.mock.calls[0][0])).not.toContain("x_pfp");
  });

  it("passes as_of_unix through so the board can say when it was read", async () => {
    const { res, jsonSpy } = makeRes();
    await handleFlames(makeReq({ query: {} }), res);
    expect(jsonSpy.mock.calls[0][0].as_of_unix).toBe(1788684733);
  });
});

// ─── Collapse: the board is off vs the board is broken ──────────────────────

describe("upstream collapse", () => {
  it("answers 204 with no body when the board is off (upstream 404)", async () => {
    fetchMock = mockUpstream({ status: 404, ok: false });
    vi.stubGlobal("fetch", fetchMock);

    const { res, statusSpy, jsonSpy, endSpy } = makeRes();
    await handleFlames(makeReq({ query: {} }), res);

    expect(statusSpy).toHaveBeenCalledWith(204);
    expect(endSpy).toHaveBeenCalled();
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it.each([500, 502, 503])("collapses upstream %s to 502, never an empty board", async (status) => {
    fetchMock = mockUpstream({ status, ok: false });
    vi.stubGlobal("fetch", fetchMock);

    const { res, statusSpy, jsonSpy } = makeRes();
    await handleFlames(makeReq({ query: {} }), res);

    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Board unavailable" });
  });

  it("collapses a non-JSON body to 502", async () => {
    fetchMock = mockUpstream({ raw: "<html>gateway</html>" });
    vi.stubGlobal("fetch", fetchMock);

    const { res, statusSpy, jsonSpy } = makeRes();
    await handleFlames(makeReq({ query: {} }), res);

    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Board unreadable" });
  });

  it("treats a changed upstream shape as an outage, NOT as an empty island", async () => {
    fetchMock = mockUpstream({ payload: { board: [], as_of_unix: 1 } });
    vi.stubGlobal("fetch", fetchMock);

    const { res, statusSpy, jsonSpy } = makeRes();
    await handleFlames(makeReq({ query: {} }), res);

    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Board unreadable" });
  });

  it("collapses a thrown fetch (timeout/abort) to 502", async () => {
    fetchMock = vi.fn(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); });
    vi.stubGlobal("fetch", fetchMock);

    const { res, statusSpy, jsonSpy } = makeRes();
    await handleFlames(makeReq({ query: {} }), res);

    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Board unavailable" });
  });
});

// ─── The clamped upstream query (amplification boundary) ────────────────────

describe("upstream query", () => {
  it.each([
    [undefined, 10],
    ["5", 5],
    ["25", 25],
    ["500", 500],
    ["9999", 500],
    // Zero is FALSY, so `Number("0") || DEFAULT` coalesces to the default rather
    // than clamping to 1. Matches the directive's own reference implementation;
    // recorded here because it reads like an off-by-one until you see why.
    ["0", 10],
    ["-4", 1],
    ["not-a-number", 10],
    ["../../etc/passwd", 10],
  ])("clamps limit=%s to %i", async (input, expected) => {
    const { res } = makeRes();
    await handleFlames(makeReq({ query: input === undefined ? {} : { limit: input } }), res);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://memetics.wtf/api/flames?limit=${expected}`);
  });

  it("passes claimed=1 through, and nothing else", async () => {
    const { res } = makeRes();
    await handleFlames(makeReq({ query: { limit: "5", claimed: "1" } }), res);
    expect(fetchMock.mock.calls[0][0]).toBe("https://memetics.wtf/api/flames?limit=5&claimed=1");
  });

  it.each(["0", "true", "yes", "1; DROP TABLE"])("ignores claimed=%s", async (claimed) => {
    const { res } = makeRes();
    await handleFlames(makeReq({ query: { limit: "5", claimed } }), res);
    expect(fetchMock.mock.calls[0][0]).toBe("https://memetics.wtf/api/flames?limit=5");
  });
});

// ─── Caching ────────────────────────────────────────────────────────────────

describe("edge cache", () => {
  it("caches a successful board for five minutes", async () => {
    const { res, headerSpy } = makeRes();
    await handleFlames(makeReq({ query: {} }), res);
    expect(headerSpy).toHaveBeenCalledWith(
      "Cache-Control",
      "s-maxage=300, stale-while-revalidate=600",
    );
  });

  it("never caches a failed read", async () => {
    fetchMock = mockUpstream({ status: 503, ok: false });
    vi.stubGlobal("fetch", fetchMock);

    const { res, headerSpy } = makeRes();
    await handleFlames(makeReq({ query: {} }), res);
    expect(headerSpy).not.toHaveBeenCalledWith("Cache-Control", expect.anything());
  });
});

// ─── Gates, in dispatch order ───────────────────────────────────────────────

describe("method gate", () => {
  it.each(["POST", "PUT", "DELETE"])(
    "rejects %s with 405 before budgets or upstream",
    async (method) => {
      const { checkRateLimit } = await import("../ratelimit.js");
      const { res, statusSpy, jsonSpy } = makeRes();
      await handleFlames(makeReq({ method, query: {} }), res);

      expect(statusSpy).toHaveBeenCalledWith(405);
      expect(jsonSpy).toHaveBeenCalledWith({ error: "Method not allowed" });
      expect(checkRateLimit).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("answers OPTIONS with 200 and no upstream read", async () => {
    const { res, statusSpy, endSpy } = makeRes();
    await handleFlames(makeReq({ method: "OPTIONS", query: {} }), res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(endSpy).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("origin gate — production mode", () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = "production";
    ({ handleFlames } = await import("../flames.js"));
  });

  it("rejects a non-allowlisted origin with 403 before budgets or upstream", async () => {
    const { checkRateLimit } = await import("../ratelimit.js");
    const { res, statusSpy, jsonSpy } = makeRes();
    await handleFlames(
      makeReq({ query: {}, headers: { origin: "https://attacker.example" } }),
      res,
    );

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Origin not allowed" });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("rate limiting", () => {
  it("uses its OWN bucket, so a board read never starves the heat tape", async () => {
    const { checkRateLimit, checkGlobalLimit } = await import("../ratelimit.js");
    const { res } = makeRes();
    await handleFlames(makeReq({ query: {} }), res);

    expect(checkRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      res,
      expect.objectContaining({ identifier: "flames" }),
    );
    expect(checkGlobalLimit).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ identifier: "flames" }),
    );
  });

  it("stops before the upstream when the per-IP budget refuses", async () => {
    const { checkRateLimit } = await import("../ratelimit.js");
    checkRateLimit.mockResolvedValueOnce(false);

    const { res } = makeRes();
    await handleFlames(makeReq({ query: {} }), res);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops before the upstream when the global budget refuses", async () => {
    const { checkGlobalLimit } = await import("../ratelimit.js");
    checkGlobalLimit.mockResolvedValueOnce(false);

    const { res } = makeRes();
    await handleFlames(makeReq({ query: {} }), res);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
