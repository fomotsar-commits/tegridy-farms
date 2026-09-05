// OUTAGE-AS-ZERO (audit 2026-09-04). The trade-query catch answered
// `res.json({ trades: [], count: 0, degraded: true })` with NO status, i.e. an
// HTTP 200. Both client readers (fetchTrades / fetchTradeFeed) key on `res.ok`
// and return before touching the body, so an unreadable trade table rode out as
// a SUCCESSFUL empty result: TradesPanel painted "No trades" and the nav badge
// cleared — over live, unexpired offers the wallet could still accept.
//
// The pair below is the whole point: an outage must NOT look like an empty
// book, and an empty book must still be allowed to say it is empty.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../_lib/ratelimit.js", () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock("viem", () => ({ recoverMessageAddress: vi.fn(async () => "0x" + "a".repeat(40)) }));

let readError = null;
let rowsToReturn = [];

function makeQueryResult() {
  const chain = {
    insert: vi.fn(() => chain),
    update: vi.fn(() => chain),
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    or: vi.fn(() => chain),
    gt: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    single: vi.fn(async () => ({ data: null, error: readError })),
    maybeSingle: vi.fn(async () => ({ data: null, error: readError })),
    then: (resolve) => resolve({
      data: readError ? null : rowsToReturn,
      error: readError,
      count: readError ? null : rowsToReturn.length,
    }),
  };
  return chain;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: () => makeQueryResult() })),
}));

function makeReq(query) {
  return { method: "GET", body: {}, query, headers: { origin: "https://memetic.fun" } };
}
function makeRes() {
  const jsonSpy = vi.fn();
  const statusSpy = vi.fn();
  const headerSpy = vi.fn();
  const res = {
    setHeader: (k, v) => { headerSpy(k, v); return res; },
    status: (c) => { statusSpy(c); return res; },
    json: (p) => { jsonSpy(p); return res; },
    end: vi.fn(),
  };
  return { res, jsonSpy, statusSpy, headerSpy };
}

const WALLET = "0x" + "2".repeat(40);
const QUERY = { action: "trade-query", role: "incoming", wallet: WALLET, status: "active" };

let handler;
beforeEach(async () => {
  vi.resetModules();
  readError = null;
  rowsToReturn = [];
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = "service-role";
  process.env.NODE_ENV = "test";
  handler = (await import("../orderbook.js")).default;
});

describe("orderbook trade-query — an unreadable table is not an empty book", () => {
  it("answers 503, never a 200 that looks like 'no offers'", async () => {
    readError = { message: "connection refused" };
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(makeReq(QUERY), res);
    expect(statusSpy).toHaveBeenCalledWith(503);
    expect(statusSpy).not.toHaveBeenCalledWith(200);
    const payload = jsonSpy.mock.calls.at(-1)[0];
    // An empty list and a 0 ARE the false zero — neither may be served.
    expect(payload.trades).toBeNull();
    expect(payload.count).toBeNull();
    expect(payload.degraded).toBe(true);
  });

  it("does not pin the outage at the shared edge", async () => {
    readError = { message: "rate limited" };
    const { res, headerSpy } = makeRes();
    await handler(makeReq(QUERY), res);
    const headers = {};
    for (const [k, v] of headerSpy.mock.calls) headers[k] = v;
    expect(headers["Cache-Control"]).toBe("no-store");
  });

  it("does not leak the upstream error text to the caller", async () => {
    readError = { message: "FATAL: password authentication failed for user postgres" };
    const { res, jsonSpy } = makeRes();
    await handler(makeReq(QUERY), res);
    const payload = JSON.stringify(jsonSpy.mock.calls.at(-1)[0]);
    expect(payload).not.toMatch(/password|postgres/i);
  });

  it("a genuinely empty book still answers 200 with an empty list", async () => {
    // The other half of the pair. A wallet with no incoming offers is a real
    // answer and must keep reading as one.
    rowsToReturn = [];
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(makeReq(QUERY), res);
    expect(statusSpy).not.toHaveBeenCalledWith(503);
    const payload = jsonSpy.mock.calls.at(-1)[0];
    expect(payload.trades).toEqual([]);
    expect(payload.degraded).toBeUndefined();
  });
});
