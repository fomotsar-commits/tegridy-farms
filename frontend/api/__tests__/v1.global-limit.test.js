// COST AMPLIFIER — /api/v1 had a per-IP cap and no aggregate cap.
//
// Every v1 route fans out to 1-3 metered upstream calls (Alchemy compute
// units, an OpenSea key, an Ethplorer key). The per-IP limiter stops ONE
// abusive source; it does nothing about N sources each staying under 20/min,
// which is the shape an actual quota-burn attack takes. api/alchemy.js and
// _lib/aggregator-proxy.js already sit behind `checkGlobalLimit` for exactly
// this reason — v1 was the gap.
//
// The invariant pinned here is "the aggregate breaker is consulted, and when
// it sheds, no upstream call is paid for" — not a limit number or a message.

import { describe, it, expect, beforeEach, vi } from "vitest";

const checkRateLimitMock = vi.fn(async () => true);
const checkGlobalLimitMock = vi.fn(async () => true);
vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: (...args) => checkRateLimitMock(...args),
  checkGlobalLimit: (...args) => checkGlobalLimitMock(...args),
}));

const NAKAMIGOS = "0xd774557b647330c91bf44cfeab205095f7e6c367";

function makeReq(query = {}) {
  return { method: "GET", query, headers: { origin: "https://memetic.fun" } };
}

function makeRes() {
  const statusSpy = vi.fn();
  const jsonSpy = vi.fn();
  const res = {
    setHeader: () => res,
    status: (c) => { statusSpy(c); return res; },
    json: (p) => { jsonSpy(p); return res; },
    end: vi.fn(),
  };
  return { res, statusSpy, jsonSpy };
}

let handler;
let fetchMock;

beforeEach(async () => {
  vi.resetModules();
  checkRateLimitMock.mockClear().mockResolvedValue(true);
  checkGlobalLimitMock.mockClear().mockResolvedValue(true);
  process.env.NODE_ENV = "test";
  process.env.ALCHEMY_API_KEY = "test-key";
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: null,
    text: async () => JSON.stringify({ openSea: { floorPrice: 1 } }),
  }));
  globalThis.fetch = fetchMock;
  handler = (await import("../v1/index.js")).default;
});

describe("v1 — global circuit-breaker", () => {
  it("consults the aggregate breaker for this endpoint", async () => {
    const { res } = makeRes();
    await handler(makeReq({ route: "floor", contract: NAKAMIGOS }), res);
    expect(checkGlobalLimitMock).toHaveBeenCalledTimes(1);
    expect(checkGlobalLimitMock.mock.calls[0][1]).toMatchObject({ identifier: "v1" });
  });

  it("sheds load before paying for any upstream call", async () => {
    checkGlobalLimitMock.mockResolvedValueOnce(false);
    const { res } = makeRes();
    await handler(makeReq({ route: "floor", contract: NAKAMIGOS }), res);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("also guards erc20scan, the route that reads ANY address", async () => {
    // erc20scan skips the collection allowlist by design, so it is the widest
    // anonymous surface on this function and the cheapest one to flood.
    checkGlobalLimitMock.mockResolvedValueOnce(false);
    const { res } = makeRes();
    await handler(
      makeReq({ route: "erc20scan", contract: "0x" + "b".repeat(40) }),
      res,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
