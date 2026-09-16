// Named-tape proxy (api/_lib/tape.js) — server-side suite. Wave seven, element N.
//
// Two tests here are load-bearing and the rest support them.
//
// THE STRIP. A heat envelope carries a stranger's ENTIRE per-token breakdown —
// every contract they hold and when they first held it. A tape row needs three
// fields. Forwarding the rest would publish a buyer's whole portfolio next to
// their trade, to anyone who opens a room. The allowlist makes that structural;
// this file is what keeps it structural.
//
// FAILURE LEAVES THE ROW. A wallet whose read fails resolves to no name, and the
// row keeps the address it always had. It is never dropped and never rendered as
// "unnamed", because "we could not ask" and "this person has no name" are
// different facts and only one of them is true during an outage.
//
// Mock/req/res conventions mirror api/_lib/__tests__/flames.test.js.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

const A1 = "0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca";
const A2 = "0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a";
const SOL = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

/** The shape the island really serves, including everything that must not survive. */
function envelope(over = {}) {
  return {
    address: A1,
    degrees: 1792.96,
    tier: "Elder",
    is_cold: false,
    held_since_unix: 1642281378,
    as_of_unix: 1789000000,
    token_count: 18,
    x_handle: "_seacasa",
    x_pfp: "https://pbs.twimg.com/whatever.jpg",
    observedAt: 1789000001,
    breakdown: [
      { token_address: "0xaaa", chain: "ethereum", name: "Junglebayapeclub", symbol: "JBAC", heat_degrees: 338.21, first_seen_at_unix: 1642281378, retired: false },
    ],
    ...over,
  };
}

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

let handleTape;
let consoleErrorSpy;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.NODE_ENV = "test";
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  ({ handleTape } = await import("../tape.js"));
});

afterEach(() => {
  consoleErrorSpy?.mockRestore();
  vi.unstubAllGlobals();
});

/** Answer every upstream call with `payload`, or per-address via a function. */
function stubUpstream(resolve) {
  const calls = [];
  let inFlight = 0;
  let peak = 0;
  const fn = vi.fn(async (url) => {
    calls.push(String(url));
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 5));
      const addr = String(url).split("/").pop();
      const out = typeof resolve === "function" ? resolve(addr) : resolve;
      if (out === "throw") throw new Error("network");
      if (out === "notok") return { ok: false, status: 502, headers: { get: () => null }, body: null, text: async () => "" };
      return { ok: true, status: 200, headers: { get: () => null }, body: null, text: async () => JSON.stringify(out) };
    } finally {
      inFlight -= 1;
    }
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls, peak: () => peak };
}

describe("the named tape — the strip", () => {
  it("forwards ONLY the handle, tier, held-since and as-of", async () => {
    stubUpstream(envelope());
    const { res, jsonSpy } = makeRes();
    await handleTape(makeReq({ query: { addresses: A1 } }), res);

    const name = jsonSpy.mock.calls[0][0].names[A1];
    expect(Object.keys(name).sort()).toEqual(
      ["as_of_unix", "held_since_unix", "tier", "x_handle"].sort(),
    );
  });

  it("never forwards the buyer's per-token breakdown", async () => {
    // THE LEAK THIS FILE EXISTS FOR. The envelope carries every contract this
    // wallet holds. A tape row publishes a stranger's trade; it must not also
    // publish their portfolio.
    stubUpstream(envelope());
    const { res, jsonSpy } = makeRes();
    await handleTape(makeReq({ query: { addresses: A1 } }), res);

    const body = JSON.stringify(jsonSpy.mock.calls[0][0]);
    expect(body).not.toContain("breakdown");
    expect(body).not.toContain("JBAC");
    expect(body).not.toContain("0xaaa");
  });

  it("never forwards the avatar, degrees, or the cold flag", async () => {
    // x_pfp is an off-origin image: a CSP entry, and every viewer's IP handed to
    // whoever hosts it. degrees is the whole flame, which is the instrument's to
    // paint, not a trade row's.
    stubUpstream(envelope());
    const { res, jsonSpy } = makeRes();
    await handleTape(makeReq({ query: { addresses: A1 } }), res);

    const body = JSON.stringify(jsonSpy.mock.calls[0][0]);
    expect(body).not.toContain("x_pfp");
    expect(body).not.toContain("pbs.twimg.com");
    expect(body).not.toContain("degrees");
    expect(body).not.toContain("is_cold");
  });

  it("drops an unknown key the island adds later, because it is an allowlist", async () => {
    stubUpstream(envelope({ person_id: "0414f482-ef4b-41ea-8961-0235f52e4444", wallet_count: 14 }));
    const { res, jsonSpy } = makeRes();
    await handleTape(makeReq({ query: { addresses: A1 } }), res);

    const body = JSON.stringify(jsonSpy.mock.calls[0][0]);
    expect(body).not.toContain("person_id");
    expect(body).not.toContain("wallet_count");
    expect(body).not.toContain("0414f482");
  });
});

describe("the named tape — failure leaves the row", () => {
  it("omits a wallet whose read threw, and keeps the others", async () => {
    stubUpstream((addr) => (addr === A1 ? "throw" : envelope({ address: addr, x_handle: "two" })));
    const { res, statusSpy, jsonSpy } = makeRes();
    await handleTape(makeReq({ query: { addresses: `${A1},${A2}` } }), res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    const names = jsonSpy.mock.calls[0][0].names;
    expect(names[A1]).toBeUndefined();
    expect(names[A2].x_handle).toBe("two");
  });

  it("omits a wallet whose read was not ok, and never 502s the whole tape", async () => {
    // The rows are already on screen. One unreadable buyer is not this call's
    // licence to invalidate eleven others.
    stubUpstream((addr) => (addr === A1 ? "notok" : envelope({ address: addr, x_handle: "two" })));
    const { res, statusSpy, jsonSpy } = makeRes();
    await handleTape(makeReq({ query: { addresses: `${A1},${A2}` } }), res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(jsonSpy.mock.calls[0][0].names[A1]).toBeUndefined();
  });

  it("omits a wallet whose body was not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, headers: { get: () => null }, body: null, text: async () => "<html>nope",
    })));
    const { res, statusSpy, jsonSpy } = makeRes();
    await handleTape(makeReq({ query: { addresses: A1 } }), res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(jsonSpy.mock.calls[0][0].names).toEqual({});
  });

  it("gives NO name to a flame with no handle, rather than a bare tier", async () => {
    // The island's naming is opt-in at its own door. Painting a stranger's tier
    // beside their trade because we could read them is not the same as them
    // having put their name on it.
    stubUpstream(envelope({ x_handle: null }));
    const { res, jsonSpy } = makeRes();
    await handleTape(makeReq({ query: { addresses: A1 } }), res);
    expect(jsonSpy.mock.calls[0][0].names).toEqual({});
  });
});

describe("the named tape — the fan-out is bounded", () => {
  it("never has more than four reads in flight", async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `0x${String(i).padStart(40, "a")}`);
    const up = stubUpstream((addr) => envelope({ address: addr, x_handle: "h" }));
    const { res } = makeRes();
    await handleTape(makeReq({ query: { addresses: twelve.join(",") } }), res);
    expect(up.peak()).toBeLessThanOrEqual(4);
    expect(up.fn).toHaveBeenCalledTimes(12);
  });

  it("clamps at twelve addresses however many are asked for", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `0x${String(i).padStart(40, "b")}`);
    const up = stubUpstream((addr) => envelope({ address: addr, x_handle: "h" }));
    const { res } = makeRes();
    await handleTape(makeReq({ query: { addresses: many.join(",") } }), res);
    expect(up.fn).toHaveBeenCalledTimes(12);
  });

  it("de-duplicates BEFORE clamping, so one busy buyer does not eat the tape", async () => {
    // A tape where one wallet took six of twelve rows should still name the
    // other six. Clamping first would spend the budget on one repeated address.
    const dupes = [A1, A1, A1, A1, A1, A1, A2].join(",");
    const up = stubUpstream((addr) => envelope({ address: addr, x_handle: "h" }));
    const { res } = makeRes();
    await handleTape(makeReq({ query: { addresses: dupes } }), res);
    expect(up.fn).toHaveBeenCalledTimes(2);
    expect(up.calls.some((u) => u.endsWith(A2))).toBe(true);
  });

  it("accepts a Solana address and rejects a malformed one", async () => {
    const up = stubUpstream((addr) => envelope({ address: addr, x_handle: "h" }));
    const { res } = makeRes();
    await handleTape(makeReq({ query: { addresses: `${SOL},../../etc/passwd,0xnope` } }), res);
    expect(up.fn).toHaveBeenCalledTimes(1);
    expect(up.calls[0]).toContain(SOL);
    // The SSRF boundary: nothing but a validated address reaches the host.
    expect(up.calls.join(" ")).not.toContain("passwd");
  });
});

describe("the named tape — the gates", () => {
  it("refuses a method that is not GET", async () => {
    stubUpstream(envelope());
    const { res, statusSpy } = makeRes();
    await handleTape(makeReq({ method: "POST", query: { addresses: A1 } }), res);
    expect(statusSpy).toHaveBeenCalledWith(405);
  });

  it("answers an empty list with 200 and no names, not an error", async () => {
    const up = stubUpstream(envelope());
    const { res, statusSpy, jsonSpy } = makeRes();
    await handleTape(makeReq({ query: {} }), res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(jsonSpy.mock.calls[0][0]).toEqual({ names: {} });
    expect(up.fn).not.toHaveBeenCalled();
  });

  it("spends its OWN rate-limit bucket, never the instrument's", async () => {
    // The whole reason the island gave the tape a door: twelve rows through
    // heat's 20/min would 429 the next visitor's own reading.
    stubUpstream(envelope());
    const { checkRateLimit } = await import("../ratelimit.js");
    const { res } = makeRes();
    await handleTape(makeReq({ query: { addresses: A1 } }), res);
    expect(checkRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ identifier: "tape" }),
    );
  });

  it("caches at the edge for five minutes, like the board", async () => {
    stubUpstream(envelope());
    const { res, headerSpy } = makeRes();
    await handleTape(makeReq({ query: { addresses: A1 } }), res);
    expect(headerSpy).toHaveBeenCalledWith(
      "Cache-Control",
      "s-maxage=300, stale-while-revalidate=600",
    );
  });
});

describe("the named tape — both limiters carry a window", () => {
  it("passes a 60 s window to the per-IP AND the global limiter", async () => {
    // Wave seven's post-deploy walk: the global limiter was called without
    // windowSec, ratelimit.js built Upstash's window as "undefined s", and every
    // production read answered 500. The in-memory limiter used in dev accepts an
    // undefined window silently and this suite mocks ratelimit.js, so only the
    // call's own arguments can catch it.
    const { checkRateLimit, checkGlobalLimit } = await import("../ratelimit.js");
    vi.mocked(checkRateLimit).mockClear();
    vi.mocked(checkGlobalLimit).mockClear();
    stubUpstream(envelope());
    const { res } = makeRes();
    await handleTape(makeReq({ query: { addresses: A1 } }), res);
    expect(vi.mocked(checkRateLimit).mock.calls.at(-1)?.[2]).toMatchObject({ windowSec: 60, identifier: "tape" });
    expect(vi.mocked(checkGlobalLimit).mock.calls.at(-1)?.[1]).toMatchObject({ windowSec: 60, identifier: "tape" });
  });
});
