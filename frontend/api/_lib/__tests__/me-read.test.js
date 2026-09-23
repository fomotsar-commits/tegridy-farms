// me-read (api/_lib/me-read.js): the ONE Magic Eden read the venue makes.
//
// Junglets live on Solana and OpenSea does not list them, so their stats and
// listed items come from Magic Eden's keyless v2 API. Magic Eden sends no CORS
// header for this site, so the read has to be server-side, and it is a pipe
// with three invariants, modelled on gecko-read:
//
//   1. It is an allowlist, not a proxy. Two fixed paths for ONE symbol, and on
//      the listings path two query keys with fixed values. Anything else is a
//      400 that never reaches fetch. Only 208 Junglets exist and 55 are listed,
//      so three listing pages cover the collection; a free `offset` would turn
//      one edge-cached URL into a million cache misses against a keyless
//      per-IP limit that already sat at 429 for 25 minutes.
//   2. The edge cache is the point. A 200 carries an s-maxage; a failure never
//      does.
//   3. Status fidelity. 404 and 429 are forwarded (429 with Retry-After) so the
//      page can say which kind of nothing it got; everything else is 502.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const limits = vi.hoisted(() => ({ perIp: [], global: [] }));

vi.mock("../ratelimit.js", () => ({
  checkRateLimit: vi.fn(async (req, res, opts) => { limits.perIp.push(opts); return true; }),
  checkGlobalLimit: vi.fn(async (res, opts) => { limits.global.push(opts); return true; }),
}));

const STATS = { symbol: "junglet", floorPrice: 695000000, listedCount: 55 };

function makeReq({ method = "GET", query = {}, headers = {} } = {}) {
  return { method, query, headers: { origin: "https://memetics.finance", ...headers } };
}

function makeRes() {
  const out = { status: null, json: null, headers: {} };
  const res = {
    setHeader: (k, v) => { out.headers[k] = v; return res; },
    status: (c) => { out.status = c; return res; },
    json: (p) => { out.json = p; return res; },
    end: vi.fn(),
  };
  return { res, out };
}

function upstream({ ok = true, status = 200, payload = STATS, headers = {} } = {}) {
  return vi.fn(async () => ({
    ok,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    body: null,
    text: async () => JSON.stringify(payload),
  }));
}

let handleMeRead;
let fetchMock;

beforeEach(async () => {
  vi.resetModules();
  limits.perIp.length = 0;
  limits.global.length = 0;
  fetchMock = upstream();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  ({ handleMeRead } = await import(/* @vite-ignore */ "../me-read.js" + ""));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function call(init) {
  const { res, out } = makeRes();
  await handleMeRead(makeReq(init), res);
  return out;
}

describe("the two admitted reads", () => {
  it("reads the Junglets stats from Magic Eden's v2 API", async () => {
    const out = await call({ query: { path: "/collections/junglet/stats" } });
    expect(out.status).toBe(200);
    expect(out.json).toEqual(STATS);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin).toBe("https://api-mainnet.magiceden.dev");
    expect(url.pathname).toBe("/v2/collections/junglet/stats");
    expect(url.search).toBe("");
  });

  it.each(["0", "100", "200"])("reads a page of 100 listings at offset %s", async (offset) => {
    const out = await call({ query: { path: "/collections/junglet/listings", limit: "100", offset } });
    expect(out.status).toBe(200);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/v2/collections/junglet/listings");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("offset")).toBe(offset);
    expect([...url.searchParams.keys()].sort()).toEqual(["limit", "offset"]);
  });
});

describe("everything else is refused before fetch", () => {
  it.each([
    ["another symbol", { path: "/collections/degods/stats" }],
    ["the collection detail route", { path: "/collections/junglet" }],
    ["the activities route", { path: "/collections/junglet/activities" }],
    ["a token route", { path: "/tokens/DGzxMHMKVdy1SsSRfR1wLXxA1eB5TeNMp22NADsKYPK3" }],
    ["traversal", { path: "/collections/junglet/../../wallets/x" }],
    ["an encoded slash", { path: "/collections/junglet%2Fstats" }],
    ["a query smuggled into the path", { path: "/collections/junglet/stats?limit=500" }],
    ["a fragment smuggled into the path", { path: "/collections/junglet/stats#x" }],
    ["no path", {}],
    ["a query key on the stats path", { path: "/collections/junglet/stats", limit: "100" }],
    ["an unknown query key", { path: "/collections/junglet/listings", limit: "100", offset: "0", sort: "price" }],
    ["a limit other than 100", { path: "/collections/junglet/listings", limit: "20", offset: "0" }],
    ["an offset off the page grid", { path: "/collections/junglet/listings", limit: "100", offset: "50" }],
    ["an offset past the collection", { path: "/collections/junglet/listings", limit: "100", offset: "300" }],
    ["a non-numeric offset", { path: "/collections/junglet/listings", limit: "100", offset: "0x10" }],
  ])("refuses %s with 400", async (_label, query) => {
    const out = await call({ query });
    expect(out.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a method other than GET", async () => {
    const out = await call({ method: "POST", query: { path: "/collections/junglet/stats" } });
    expect(out.status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces the origin", async () => {
    const out = await call({ query: { path: "/collections/junglet/stats" }, headers: { origin: "https://evil.example" } });
    expect(out.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the edge cache and the budget", () => {
  it("a 200 carries an s-maxage of at least two minutes", async () => {
    const out = await call({ query: { path: "/collections/junglet/stats" } });
    const sMaxAge = Number(/s-maxage=(\d+)/.exec(out.headers["Cache-Control"] || "")?.[1] ?? 0);
    expect(sMaxAge).toBeGreaterThanOrEqual(120);
  });

  it("is rate limited per visitor and, lower, for the whole fleet", async () => {
    await call({ query: { path: "/collections/junglet/stats" } });
    expect(limits.perIp.length).toBe(1);
    expect(limits.global.length).toBe(1);
    expect(limits.global[0].limit).toBeLessThanOrEqual(60);
    expect(String(limits.global[0].identifier)).toContain("me-read");
  });
});

describe("status fidelity", () => {
  it("forwards a 429 with its Retry-After, and caches nothing", async () => {
    fetchMock = upstream({ ok: false, status: 429, payload: "You have exceeded the requests in 1 min limit!", headers: { "retry-after": "60" } });
    vi.stubGlobal("fetch", fetchMock);
    const out = await call({ query: { path: "/collections/junglet/stats" } });
    expect(out.status).toBe(429);
    expect(out.headers["Retry-After"]).toBe("60");
    expect(out.headers["Cache-Control"] ?? "").not.toMatch(/s-maxage/);
  });

  it("forwards a 404", async () => {
    fetchMock = upstream({ ok: false, status: 404, payload: { error: "Not Found" } });
    vi.stubGlobal("fetch", fetchMock);
    const out = await call({ query: { path: "/collections/junglet/stats" } });
    expect(out.status).toBe(404);
  });

  it.each([500, 403, 400])("turns an upstream %s into a 502", async (status) => {
    fetchMock = upstream({ ok: false, status, payload: { error: "x" } });
    vi.stubGlobal("fetch", fetchMock);
    const out = await call({ query: { path: "/collections/junglet/stats" } });
    expect(out.status).toBe(502);
    expect(out.headers["Cache-Control"] ?? "").not.toMatch(/s-maxage/);
  });

  it("turns an oversized body into a 502", async () => {
    fetchMock = upstream({ headers: { "content-length": String(50 * 1024 * 1024) } });
    vi.stubGlobal("fetch", fetchMock);
    const out = await call({ query: { path: "/collections/junglet/stats" } });
    expect(out.status).toBe(502);
  });

  it("turns a non-JSON body into a 502", async () => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, body: null, text: async () => "<html>" }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await call({ query: { path: "/collections/junglet/stats" } });
    expect(out.status).toBe(502);
  });
});

describe("dispatch", () => {
  const src = readFileSync(join(process.cwd(), "api", "aggregator.js"), "utf8");

  it("the aggregator dispatches ?resource=me-read to this handler", () => {
    expect(src).toMatch(/req\.query\.resource === "me-read"/);
    expect(src).toMatch(/import\("\.\/_lib\/me-read\.js"\)/);
  });

  it("the branch sits above `const provider`, or a ?resource= call never reaches it", () => {
    const branch = src.indexOf('req.query.resource === "me-read"');
    const provider = src.indexOf("const provider = req.query.provider");
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(provider);
  });

  it("keeps no origin list of its own (the parity guard allows only mirrors to spell the site)", () => {
    const own = readFileSync(join(process.cwd(), "api", "_lib", "me-read.js"), "utf8");
    expect(own).not.toContain("https://memetic.fun");
    expect(own).toMatch(/isRequestOriginAllowed/);
  });
});
