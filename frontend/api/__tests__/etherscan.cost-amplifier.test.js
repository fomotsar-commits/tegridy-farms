// COST AMPLIFIER — /api/etherscan silently dropped `page` / `offset`.
//
// Measured on prod: a request carrying `offset=5` came back with 99 rows and
// 918,663 bytes, because the proxy never forwarded the pagination params and
// Etherscan therefore answered with its unbounded default page. Busier
// addresses cross the 5 MB body cap, at which point `readBoundedText` reports
// `truncated` and the endpoint 502s — permanently, for that address, on every
// retry. So the dropped param is not just wasted bandwidth: it is an anonymous,
// unauthenticated lever that both burns the shared Etherscan quota and bricks
// a page.
//
// These tests pin the INVARIANTS, not the copy:
//   1. whatever pagination the caller asked for reaches the upstream URL,
//   2. `offset` is bounded by a server-side ceiling the caller cannot raise,
//   3. an unreadable pagination value is REJECTED, never silently discarded
//      (silently discarding it is exactly how a bounded request became an
//      unbounded one), and
//   4. a distributed flood is shed by the global circuit-breaker before any
//      upstream call is paid for.

import { describe, it, expect, beforeEach, vi } from "vitest";

const checkRateLimitMock = vi.fn(async () => true);
const checkGlobalLimitMock = vi.fn(async () => true);
vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: (...args) => checkRateLimitMock(...args),
  checkGlobalLimit: (...args) => checkGlobalLimitMock(...args),
}));

const ADDR = "0x" + "a".repeat(40);

function makeReq(query = {}) {
  return {
    method: "GET",
    query: { module: "account", action: "txlist", address: ADDR, ...query },
    headers: { origin: "https://memetic.fun" },
  };
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
  process.env.ETHERSCAN_API_KEY = "test-key";
  process.env.NODE_ENV = "test";
  fetchMock = vi.fn(async () => ({
    ok: true,
    headers: { get: () => null },
    body: null,
    text: async () => JSON.stringify({ status: "1", message: "OK", result: [] }),
  }));
  globalThis.fetch = fetchMock;
  handler = (await import("../etherscan.js")).default;
});

/** The querystring actually sent upstream, as URLSearchParams. */
function upstreamParams() {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return new URL(String(fetchMock.mock.calls[0][0])).searchParams;
}

describe("etherscan — pagination reaches the upstream", () => {
  it("forwards the caller's page and offset", async () => {
    const { res } = makeRes();
    await handler(makeReq({ page: "2", offset: "25" }), res);
    const p = upstreamParams();
    expect(p.get("page")).toBe("2");
    expect(p.get("offset")).toBe("25");
  });

  it("forwards a small offset verbatim — the prod repro that returned 99 rows", async () => {
    const { res } = makeRes();
    await handler(makeReq({ offset: "5" }), res);
    expect(upstreamParams().get("offset")).toBe("5");
  });

  // REVIEW GUARD (not a defect proof — this also holds pre-fix). The two
  // callers that send NO pagination (src/lib/txHistory.ts fetchAddressTxList,
  // src/hooks/useDeployerReputation.ts fetchTxList) deliberately read full
  // history and then filter it for contract-creation txs. If this proxy ever
  // starts inventing a default page size, those reads get silently truncated
  // and the UI renders "no contract-creation transactions found" as a claim
  // about someone's address that is really an artifact of our own truncation.
  // Pin it: absent stays absent.
  it("invents no pagination when the caller sends none", async () => {
    const { res } = makeRes();
    await handler(makeReq(), res);
    const p = upstreamParams();
    expect(p.has("page")).toBe(false);
    expect(p.has("offset")).toBe(false);
  });
});

describe("etherscan — offset is bounded server-side", () => {
  it("clamps an offset above the ceiling instead of honouring it", async () => {
    const { res } = makeRes();
    await handler(makeReq({ page: "1", offset: "10000" }), res);
    const sent = Number(upstreamParams().get("offset"));
    // The invariant is a ceiling the caller cannot raise, not the number 500.
    expect(sent).toBeLessThanOrEqual(500);
    expect(sent).toBeGreaterThan(0);
  });
});

describe("etherscan — an unreadable pagination value fails CLOSED", () => {
  // Dropping the param is the defect. A request the server cannot bound must
  // not be answered with an unbounded one.
  for (const bad of ["abc", "-1", "0", "1e5", "", "  "]) {
    it(`rejects offset=${JSON.stringify(bad)} without calling the upstream`, async () => {
      const { res, statusSpy } = makeRes();
      await handler(makeReq({ offset: bad }), res);
      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  for (const bad of ["abc", "-3", "0"]) {
    it(`rejects page=${JSON.stringify(bad)} without calling the upstream`, async () => {
      const { res, statusSpy } = makeRes();
      await handler(makeReq({ page: bad, offset: "10" }), res);
      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }
});

describe("etherscan — global circuit-breaker", () => {
  it("consults the aggregate breaker for this endpoint", async () => {
    const { res } = makeRes();
    await handler(makeReq({ page: "1", offset: "10" }), res);
    expect(checkGlobalLimitMock).toHaveBeenCalledTimes(1);
    expect(checkGlobalLimitMock.mock.calls[0][1]).toMatchObject({
      identifier: "etherscan",
    });
  });

  it("sheds load before paying for the upstream call", async () => {
    checkGlobalLimitMock.mockResolvedValueOnce(false);
    const { res } = makeRes();
    await handler(makeReq({ page: "1", offset: "10" }), res);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
