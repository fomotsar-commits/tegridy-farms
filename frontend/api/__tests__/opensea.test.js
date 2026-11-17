// AUDIT R060: regression tests for the opensea proxy hardening.
// Coverage: contract-allowlist on POST bodies (R053-style schema enforcement),
// path traversal guard, body cap.

import { describe, it, expect, beforeEach, vi } from "vitest";

// AUDIT FIX TF-019: opensea.js gained the global circuit-breaker that
// alchemy.js and etherscan.js already carried. Hoisted mocks so the breaker
// can be driven per-test.
const checkGlobalLimitMock = vi.fn(async () => true);
vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: (...args) => checkGlobalLimitMock(...args),
}));

const NAKAMIGOS = "0xd774557b647330c91bf44cfeab205095f7e6c367";

function makeReq({ method = "POST", query = {}, body = {}, headers = {} } = {}) {
  return {
    method,
    query,
    body,
    headers: { origin: "https://memetics.finance", ...headers },
  };
}

function makeRes() {
  const headerSpy = vi.fn();
  const statusSpy = vi.fn();
  const jsonSpy = vi.fn();
  const res = {
    setHeader: (k, v) => { headerSpy(k, v); return res; },
    status: (c) => { statusSpy(c); return res; },
    json: (p) => { jsonSpy(p); return res; },
    end: vi.fn(),
  };
  return { res, headerSpy, statusSpy, jsonSpy };
}

// AUDIT TF-019. The per-IP cap bounds ONE source; it does nothing about a
// distributed flood of many IPs each staying under 30/min, and the CORS
// headers this proxy sets bound browsers only — never curl. That made the
// paid OpenSea key the last key-holding surface with no aggregate ceiling.
// The property pinned here is "an aggregate ceiling is consulted, and it can
// shed load BEFORE the upstream call is paid for" — not the numeric limit,
// which is env-tunable by design.
describe("opensea — global circuit-breaker", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.OPENSEA_API_KEY = "test-key";
    process.env.NODE_ENV = "test";
    checkGlobalLimitMock.mockClear().mockResolvedValue(true);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ ok: true }),
    }));
    handler = (await import("../opensea.js")).default;
  });

  const statsReq = () =>
    makeReq({ method: "GET", query: { path: "collection/nakamigos/stats" } });

  it("consults the aggregate breaker for this endpoint", async () => {
    const { res } = makeRes();
    await handler(statsReq(), res);
    expect(checkGlobalLimitMock).toHaveBeenCalledTimes(1);
    expect(checkGlobalLimitMock.mock.calls[0][1]).toMatchObject({ identifier: "opensea" });
  });

  it("sheds load before paying for the upstream call", async () => {
    checkGlobalLimitMock.mockResolvedValueOnce(false);
    const { res } = makeRes();
    await handler(statsReq(), res);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("opensea — POST body contract-allowlist", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.OPENSEA_API_KEY = "test-key";
    process.env.NODE_ENV = "test";
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ ok: true }),
    }));
    handler = (await import("../opensea.js")).default;
  });

  it("rejects POST with non-allowlisted contract in offer item", async () => {
    const req = makeReq({
      query: { path: "orders/ethereum/seaport/listings" },
      body: {
        parameters: {
          offer: [{ itemType: 2, token: "0x" + "e".repeat(40) }],
          consideration: [],
        },
      },
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Contract not supported" });
  });

  it("accepts POST with allowlisted contract in offer item", async () => {
    const req = makeReq({
      query: { path: "orders/ethereum/seaport/listings" },
      body: {
        parameters: {
          offer: [{ itemType: 2, token: NAKAMIGOS }],
          consideration: [{ itemType: 0, token: "0x0000000000000000000000000000000000000000", startAmount: "1000" }],
        },
      },
    });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(200);
  });
});

describe("opensea — path traversal / encoded-segment guard", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = "test";
    handler = (await import("../opensea.js")).default;
  });

  it("rejects URL-encoded path components (decode-then-check)", async () => {
    // %2F..%2Fadmin should decode different from raw, triggering the guard.
    const req = makeReq({
      method: "GET",
      query: { path: "orders/%2F..%2Fadmin" },
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Invalid or missing path" });
  });

  it("rejects literal '..' in path", async () => {
    const req = makeReq({ method: "GET", query: { path: "orders/../admin" } });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
  });
});

describe("opensea — body cap (10 KB)", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = "test";
    handler = (await import("../opensea.js")).default;
  });

  it("rejects POST with body > 10 KB", async () => {
    const req = makeReq({
      query: { path: "orders/ethereum/seaport/listings" },
      body: { padding: "x".repeat(11_000) },
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(413);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Request body too large (max 10KB)" });
  });
});

describe("opensea — collection stats path allowlist (F514)", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.OPENSEA_API_KEY = "test-key";
    process.env.NODE_ENV = "test";
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ total: { volume: 1234 } }),
    }));
    handler = (await import("../opensea.js")).default;
  });

  it("accepts the plural collections/{slug}/stats path (OpenSea v2 form)", async () => {
    const req = makeReq({ method: "GET", query: { path: "collections/nakamigos/stats" } });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    // Reaches OpenSea (200) instead of 400-ing in the allowlist.
    expect(statusSpy).toHaveBeenCalledWith(200);
  });

  it("still accepts the singular collection/{slug}/stats path", async () => {
    const req = makeReq({ method: "GET", query: { path: "collection/nakamigos/stats" } });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(200);
  });

  it("rejects collections/{slug}/stats for a non-allowlisted slug", async () => {
    const req = makeReq({ method: "GET", query: { path: "collections/evilcollection/stats" } });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
  });
});

describe("opensea — query param validation", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = "test";
    handler = (await import("../opensea.js")).default;
  });

  it("rejects non-allowlisted asset_contract_address query param", async () => {
    const req = makeReq({
      method: "GET",
      query: {
        path: "events/collection/nakamigos",
        asset_contract_address: "0x" + "9".repeat(40),
      },
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Contract not supported" });
  });

  it("rejects non-numeric token_ids", async () => {
    const req = makeReq({
      method: "GET",
      query: {
        path: "events/collection/nakamigos",
        token_ids: "evil-string",
      },
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Invalid token_ids — must be numeric (max 10 digits)" });
  });
});

// ─── A PERMANENT UPSTREAM REJECTION MUST NOT ARRIVE AS A 5xx ────────────────
//
// The proxy used to collapse EVERY non-2xx upstream status into 502. The client
// treats 5xx as retryable (nakamigos/lib/proxy.js ApiError.isRetryable) while
// explicitly NOT retrying 4xx (nakamigos/api.js:20), so our own 502 was the only
// reason a permanently-dead route was retried at all — 4 requests and ~10.5s
// each, every 30s, against a 30/min per-IP budget.
//
// Live cause, measured 2026-09-05: OpenSea made the seaport order routes
// POST-only, so five GET call sites now receive 405 forever.
describe("upstream status forwarding", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    checkGlobalLimitMock.mockResolvedValue(true);
    process.env.OPENSEA_API_KEY = "test-key";
  });

  const upstream = (status, body = { error: { message: "Method Not Allowed" } }, headers = {}) =>
    vi.fn(async () => ({
      ok: false,
      status,
      headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
      text: async () => JSON.stringify(body),
    }));

  // 405 is the one that is actually happening in production today.
  for (const status of [400, 404, 405, 410, 422]) {
    it(`forwards a permanent ${status} instead of dressing it as 502`, async () => {
      vi.stubGlobal("fetch", upstream(status));
      const { res, statusSpy, jsonSpy } = makeRes();
      const mod = await import("../opensea.js");
      await mod.default(makeReq({ method: "GET", query: { path: "orders/ethereum/seaport/listings" } }), res);

      expect(statusSpy).toHaveBeenCalledWith(status);
      expect(statusSpy).not.toHaveBeenCalledWith(502);
      // API-M4 still holds: the caller learns the status and nothing else.
      const payload = jsonSpy.mock.calls.at(-1)?.[0];
      expect(payload).toEqual({ error: "upstream-rejected", status });
      expect(JSON.stringify(payload)).not.toContain("Method Not Allowed");
    });
  }

  it("still collapses a genuine server fault to 502, and 401/403 with it", async () => {
    // The point of the change is to separate PERMANENT from TRANSIENT — not to
    // stop shielding the caller. 500 is retryable and stays 5xx; 401/403 are
    // about OUR api key and must not become the caller's business.
    for (const status of [500, 503, 401, 403]) {
      vi.stubGlobal("fetch", upstream(status));
      const { res, statusSpy } = makeRes();
      const mod = await import("../opensea.js");
      await mod.default(makeReq({ method: "GET", query: { path: "collections/nakamigos/stats" } }), res);
      expect(statusSpy, `upstream ${status} should stay opaque`).toHaveBeenCalledWith(502);
    }
  });

  it("forwards 429 and passes the upstream Retry-After through, but only if it is a plain number", async () => {
    vi.stubGlobal("fetch", upstream(429, { error: "slow down" }, { "retry-after": "17" }));
    const { res, statusSpy, headerSpy } = makeRes();
    const mod = await import("../opensea.js");
    await mod.default(makeReq({ method: "GET", query: { path: "collections/nakamigos/stats" } }), res);
    expect(statusSpy).toHaveBeenCalledWith(429);
    expect(headerSpy).toHaveBeenCalledWith("Retry-After", "17");

    // A header we did not author is attacker-influenced; only digits go through.
    vi.stubGlobal("fetch", upstream(429, { error: "slow down" }, { "retry-after": "9999999999, injected" }));
    const second = makeRes();
    await mod.default(makeReq({ method: "GET", query: { path: "collections/nakamigos/stats" } }), second.res);
    expect(second.statusSpy).toHaveBeenCalledWith(429);
    expect(second.headerSpy).not.toHaveBeenCalledWith("Retry-After", expect.stringContaining("injected"));
  });
});

// ─── THE LISTINGS/OFFERS ALLOWLIST ASYMMETRY ────────────────────────────────
//
// `offers/collection/{slug}/` admitted any sub-path; `listings/collection/{slug}/`
// admitted only the exact `/best`. So OUR proxy 400'd `listings/collection/
// nakamigos/all` — a route OpenSea serves (OPTIONS -> 200, "allow: GET,HEAD,
// OPTIONS", verified 2026-09-05). With `orders/{chain}/seaport/listings` now
// POST-only upstream, the collection-scoped listings routes are the only read
// path left for My Listings, so the asymmetry had to go.
//
// These pin BOTH directions: the new paths open, and the slug scoping that keeps
// the rule from becoming an open proxy stays shut.
describe("listings sub-path allowlist", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    checkGlobalLimitMock.mockResolvedValue(true);
    process.env.OPENSEA_API_KEY = "test-key";
  });

  const okUpstream = () => vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ listings: [] }),
  }));

  const call = async (path) => {
    vi.stubGlobal("fetch", okUpstream());
    const { res, statusSpy } = makeRes();
    const mod = await import("../opensea.js");
    await mod.default(makeReq({ method: "GET", query: { path } }), res);
    return statusSpy;
  };

  it("admits listings sub-paths for an allowed slug", async () => {
    for (const p of [
      "listings/collection/nakamigos/all",
      "listings/collection/nakamigos/best",
      "listings/collection/nakamigos/nfts/1/best",
      "listings/collection/junglebay/all",
    ]) {
      const statusSpy = await call(p);
      expect(statusSpy, `${p} should be admitted`).not.toHaveBeenCalledWith(400);
    }
  });

  // THE HALF THAT MATTERS. A prefix rule is only safe while it stays inside the
  // slug loop; written as a bare `listings/collection/` prefix it would proxy
  // ANY collection, which is the open-proxy shape this allowlist exists to stop.
  it("still refuses a slug that is not on the list", async () => {
    for (const p of [
      "listings/collection/not-our-collection/all",
      "listings/collection/boredapeyachtclub/all",
      "listings/collection/nakamigos-evil/all",
    ]) {
      const statusSpy = await call(p);
      expect(statusSpy, `${p} must be refused`).toHaveBeenCalledWith(400);
    }
  });

  it("refuses a path carrying a query string or fragment", async () => {
    // A prefix rule should not double as a query-injection primitive. Harmless
    // today (the api key is a header), but the reach grows with every prefix.
    for (const p of [
      "listings/collection/nakamigos/all?limit=999",
      "listings/collection/nakamigos/all#frag",
      "offers/collection/nakamigos/all?maker=0x1",
    ]) {
      const statusSpy = await call(p);
      expect(statusSpy, `${p} must be refused`).toHaveBeenCalledWith(400);
    }
  });

  it("keeps refusing traversal and encoded paths through the new rule", async () => {
    for (const p of [
      "listings/collection/nakamigos/../../admin",
      "listings/collection/nakamigos//all",
      "listings/collection/nakamigos/%2e%2e/admin",
    ]) {
      const statusSpy = await call(p);
      expect(statusSpy, `${p} must be refused`).toHaveBeenCalledWith(400);
    }
  });
});

// ─── BIDS ARE SEAPORT 1.6: THE CRITERIA ROUTES AND THE GASLESS CANCEL ──────
//
// Measured 2026-11-15: OpenSea's `criteria_offers` route is gone (OPTIONS 404);
// collection and trait offers are built at `offers/build` (which 400s without
// `protocol_address`) and posted to `offers`. A SignedZone order is cancelled
// without gas at orders/chain/{chain}/protocol/{protocol}/{hash}/cancel with a
// body of the offerer's signature. The proxy admits exactly those, for venue
// collections and Seaport 1.6 only, and nothing else in their place.
describe("opensea — Seaport 1.6 bid routes", () => {
  const SEAPORT_16 = "0x0000000000000068F116a894984e2DB1123eB395";
  const SEAPORT_15 = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC";
  const HASH = "0x" + "ab".repeat(32);
  const SIG = "0x" + "cd".repeat(65);
  const cancelPath = (chain = "ethereum", protocol = SEAPORT_16.toLowerCase(), hash = HASH) =>
    `orders/chain/${chain}/protocol/${protocol}/${hash}/cancel`;
  const criteriaBody = (over = {}) => ({
    criteria: { collection: { slug: "junglebay" } },
    protocol_address: SEAPORT_16,
    ...over,
  });
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.OPENSEA_API_KEY = "test-key";
    process.env.NODE_ENV = "test";
    checkGlobalLimitMock.mockResolvedValue(true);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ order_hash: HASH, last_signature_issued_valid_until: "0" }),
    }));
    handler = (await import("../opensea.js")).default;
  });

  async function send({ method = "POST", path, body, query = {} }) {
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(makeReq({ method, query: { path, ...query }, body }), res);
    return { status: statusSpy.mock.calls.at(-1)?.[0], body: jsonSpy.mock.calls.at(-1)?.[0] };
  }
  const upstreamUrl = () => String(globalThis.fetch.mock.calls[0]?.[0] ?? "");

  it("refuses the dead `criteria_offers` route outright", async () => {
    const out = await send({ path: "criteria_offers", body: criteriaBody() });
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ error: "Invalid or missing path" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("posts a venue collection's criteria offer to `offers`", async () => {
    const out = await send({ path: "offers", body: criteriaBody() });
    expect(out.status).toBe(200);
    expect(upstreamUrl()).toBe("https://api.opensea.io/api/v2/offers");
    expect(globalThis.fetch.mock.calls[0][1].method).toBe("POST");
  });

  it("builds a venue collection's offer at `offers/build` for Seaport 1.6", async () => {
    const out = await send({ path: "offers/build", body: criteriaBody({ offerer: "0x" + "a".repeat(40), quantity: 1, offer_protection_enabled: true }) });
    expect(out.status).toBe(200);
    expect(upstreamUrl()).toBe("https://api.opensea.io/api/v2/offers/build");
  });

  it("keeps the venue-slug check on both criteria routes", async () => {
    for (const path of ["offers", "offers/build"]) {
      for (const slug of ["boredapeyachtclub", "bojungless", undefined]) {
        const out = await send({ path, body: criteriaBody({ criteria: { collection: { slug } } }) });
        expect(out.status, `${path} ${slug}`).toBe(403);
      }
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("refuses a criteria build or post for any protocol but Seaport 1.6", async () => {
    for (const path of ["offers", "offers/build"]) {
      for (const protocol_address of [SEAPORT_15, undefined, "0x" + "1".repeat(40), 7]) {
        const out = await send({ path, body: criteriaBody({ protocol_address }) });
        expect(out.status, `${path} ${protocol_address}`).toBe(400);
      }
      // Any case of the same address is the same protocol.
      expect((await send({ path, body: criteriaBody({ protocol_address: SEAPORT_16.toLowerCase() }) })).status).toBe(200);
    }
  });

  // Review 2026-11-16 F4: OpenSea reads a criteria post's order from
  // protocol_data.parameters. The contract check read a top-level `parameters`
  // first, so any such key, even {}, made it check the decoy and forward a BAYC
  // order under the junglebay slug; and `offers/build` forwarded criteria.contract
  // unchecked.
  describe("a criteria build or post is held to its slug's own collection", () => {
    const BAYC = "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D";
    const JBAC = "0xd37264c71e9af940e49795F0d3a8336afAaFDdA9";
    const GNSS = "0xa1De9f93c56C290C48849B1393b09eB616D55dbb";
    const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
    const ME = "0x" + "b".repeat(40);
    const orderFor = (nft) => ({
      offerer: ME,
      offer: [{ itemType: 1, token: WETH, identifierOrCriteria: "0", startAmount: "1000", endAmount: "1000" }],
      consideration: [{ itemType: 4, token: nft, identifierOrCriteria: "0", startAmount: "1", endAmount: "1", recipient: ME }],
    });
    const postOf = (nft, over = {}) => criteriaBody({ protocol_data: { parameters: orderFor(nft), signature: SIG }, ...over });
    const buildWith = (criteria) => criteriaBody({ criteria: { collection: { slug: "junglebay" }, ...criteria }, offerer: ME, quantity: 1, offer_protection_enabled: true });

    it("refuses a top-level `parameters` beside the order", async () => {
      for (const decoy of [{}, orderFor(JBAC)]) {
        expect((await send({ path: "offers", body: postOf(BAYC, { parameters: decoy }) })).status, JSON.stringify(decoy)).toBe(400);
      }
      expect((await send({ path: "offers/build", body: { ...buildWith({}), parameters: {} } })).status).toBe(400);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("checks the order OpenSea reads, protocol_data.parameters, against the slug's own contract", async () => {
      expect((await send({ path: "offers", body: postOf(BAYC) })).status).toBe(403);
      // Another venue collection's NFT under this slug is not this collection's bid.
      expect((await send({ path: "offers", body: postOf(GNSS) })).status).toBe(403);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect((await send({ path: "offers", body: postOf(JBAC.toLowerCase()) })).status).toBe(200);
    });

    it("refuses criteria naming another contract, or any key but collection, traits and numericTraits", async () => {
      expect((await send({ path: "offers/build", body: buildWith({ contract: { address: BAYC } }) })).status).toBe(403);
      expect((await send({ path: "offers/build", body: buildWith({ contract: { address: GNSS } }) })).status).toBe(403);
      for (const extra of [{ trait: { type: "Fur", value: "Gold" } }, { encoded_token_ids: "1,2" }, { contract: null }]) {
        const out = await send({ path: "offers/build", body: buildWith(extra) });
        expect([400, 403], JSON.stringify(extra)).toContain(out.status);
      }
      expect(globalThis.fetch).not.toHaveBeenCalled();
      // What the site sends: a collection, or a collection and its traits. A
      // contract that is the slug's own (any case) names the same collection.
      for (const ok of [{}, { traits: [{ type: "Fur", value: "Gold" }] }, { numericTraits: [{ type: "Level", min: 1 }] }, { contract: { address: JBAC.toLowerCase() } }]) {
        expect((await send({ path: "offers/build", body: buildWith(ok) })).status, JSON.stringify(ok)).toBe(200);
      }
    });
  });

  it("takes only a POST on the criteria routes", async () => {
    for (const path of ["offers", "offers/build"]) {
      expect((await send({ method: "GET", path })).status).toBe(405);
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  // OpenSea's single-order read, GET orders/chain/{chain}/protocol/{p}/{hash}, in
  // its live shape (2026-11-16): { order: { protocol_data: { parameters } } }.
  const JBAC = "0xd37264c71e9af940e49795F0d3a8336afAaFDdA9";
  const BOJUNGLES = "0x36aFeE4FaDC3b77Ff5f1f9a040E264150aFb979A";
  const BAYC = "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D";
  const bidOn = (nft) => ({ order: { order_hash: HASH, protocol_address: SEAPORT_16.toLowerCase(), protocol_data: { parameters: {
    offerer: "0x" + "b".repeat(40),
    offer: [{ itemType: 1, token: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", identifierOrCriteria: "0", startAmount: "1000", endAmount: "1000" }],
    consideration: [
      { itemType: 4, token: nft.toLowerCase(), identifierOrCriteria: "0", startAmount: "1", endAmount: "1", recipient: "0x" + "b".repeat(40) },
      { itemType: 1, token: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", identifierOrCriteria: "0", startAmount: "10", endAmount: "10", recipient: "0x0000a26b00c1f0df003000390027140000faa719" },
    ],
  } } } });
  /** Upstream answering the order read with `order` (at `status`) and the cancel itself with 200. */
  function upstreamWith(order, status = 200) {
    globalThis.fetch = vi.fn(async (url) => {
      const cancel = String(url).endsWith("/cancel");
      return {
        ok: cancel || status < 300,
        status: cancel ? 200 : status,
        headers: { get: () => null },
        text: async () => JSON.stringify(cancel ? { last_signature_issued_valid_until: "0" } : order),
      };
    });
  }
  const forwardedCancel = () => globalThis.fetch.mock.calls.some(([url]) => String(url).endsWith("/cancel"));

  it("forwards a gasless cancel of exactly one shape, on Ethereum and on Base, after reading the order", async () => {
    for (const [chain, nft] of [["ethereum", JBAC], ["base", BOJUNGLES]]) {
      upstreamWith(bidOn(nft));
      const out = await send({ path: cancelPath(chain), body: { offererSignature: SIG } });
      expect(out.status, chain).toBe(200);
      const [[readUrl, readOpts], [cancelUrl, cancelOpts]] = globalThis.fetch.mock.calls;
      expect(readUrl).toBe(`https://api.opensea.io/api/v2/${cancelPath(chain).replace(/\/cancel$/, "")}`);
      expect(readOpts.method ?? "GET").toBe("GET");
      expect(cancelUrl).toBe(`https://api.opensea.io/api/v2/${cancelPath(chain)}`);
      expect(cancelOpts.method).toBe("POST");
      expect(JSON.parse(cancelOpts.body)).toEqual({ offererSignature: SIG });
    }
  });

  // Review 2026-11-16 F7: the route cancelled ANY Seaport 1.6 order hash, so the
  // venue's OpenSea key served cancels on every collection. Only the maker can
  // sign one, so it cost the key's quota and nothing else, and now it is refused.
  it("refuses a gasless cancel of an order whose NFT is not a venue collection on that chain", async () => {
    for (const [chain, nft] of [["ethereum", BAYC], ["base", JBAC], ["ethereum", BOJUNGLES]]) {
      upstreamWith(bidOn(nft));
      const out = await send({ path: cancelPath(chain), body: { offererSignature: SIG } });
      expect(out.status, `${chain} ${nft}`).toBe(403);
      expect(forwardedCancel(), `${chain} ${nft}`).toBe(false);
    }
  });

  it("refuses a gasless cancel when the order cannot be read, or names no NFT", async () => {
    const noNft = bidOn(JBAC);
    noNft.order.protocol_data.parameters.consideration.shift();
    for (const [answer, status, want] of [
      [{ errors: ["Order not found"] }, 400, 400],
      [{ errors: ["boom"] }, 500, 502],
      [{}, 200, 403],
      [noNft, 200, 403],
    ]) {
      upstreamWith(answer, status);
      const out = await send({ path: cancelPath(), body: { offererSignature: SIG } });
      expect(out.status, JSON.stringify(answer)).toBe(want);
      expect(forwardedCancel()).toBe(false);
    }
  });

  it("refuses a cancel body that is anything but one 65-byte signature", async () => {
    const bad = [
      { offererSignature: SIG, extra: 1 },
      { offererSignature: "0x" + "cd".repeat(64) },
      { offererSignature: "0x" + "zz".repeat(65) },
      { offererSignature: SIG.slice(2) },
      { signature: SIG },
      {},
      [SIG],
      undefined,
    ];
    for (const body of bad) {
      const out = await send({ path: cancelPath(), body });
      expect(out.status, JSON.stringify(body)).toBe(400);
    }
    expect((await send({ path: cancelPath(), body: { offererSignature: SIG }, query: { limit: "5" } })).status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("refuses a cancel for another protocol, chain or hash shape, and any GET", async () => {
    for (const path of [
      cancelPath("ethereum", SEAPORT_15.toLowerCase()),
      cancelPath("polygon"),
      cancelPath("ethereum", SEAPORT_16.toLowerCase(), "0x" + "ab".repeat(31)),
      cancelPath("ethereum", SEAPORT_16.toLowerCase(), "0x" + "zz".repeat(32)),
      `${cancelPath()}/actions`,
      cancelPath().replace("/cancel", "/cancel/"),
    ]) {
      expect((await send({ path, body: { offererSignature: SIG } })).status, path).toBe(400);
    }
    expect((await send({ method: "GET", path: cancelPath() })).status).toBe(405);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("keeps the body cap on the new routes", async () => {
    expect((await send({ path: cancelPath(), body: { offererSignature: SIG, pad: "x".repeat(11_000) } })).status).toBe(413);
    expect((await send({ path: "offers", body: criteriaBody({ pad: "x".repeat(11_000) }) })).status).toBe(413);
  });
});

// OpenSea builds a fill from an order hash, so what the fill moves is only
// known from its answer. Every NFT item (itemType 2 to 5) in the answer's
// orders must be a venue contract, and an accepted offer must hand over the
// contract its request named. Anything else is refused before it is returned.
describe("opensea: a fill answer moves only venue NFTs", () => {
  const GOLD = "0x6Aa03F42c5366E2664c887eb2e90844CA00B92F3";
  const RARE_TOWELIE = "0x2BCAaD3cD618D0C0f87E153b3928e02bab757705";
  const SEAPORT = "0x0000000000000068f116a894984e2db1123eb395";
  const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const ZERO = "0x" + "0".repeat(40);
  const MAKER = "0x" + "c".repeat(40);
  const FULFILLER = { address: "0x" + "a".repeat(40) };
  let handler;
  let upstream;

  beforeEach(async () => {
    vi.resetModules();
    process.env.OPENSEA_API_KEY = "test-key";
    process.env.NODE_ENV = "test";
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(upstream),
    }));
    handler = (await import("../opensea.js")).default;
  });

  const item = (itemType, token, amount = "1") => ({
    itemType, token, identifierOrCriteria: itemType >= 2 ? "1" : "0", startAmount: amount, endAmount: amount, recipient: MAKER,
  });
  const answer = (...orders) => ({
    protocol: "seaport1.6",
    fulfillment_data: {
      transaction: { to: SEAPORT, value: "0", function: "fulfillOrder", input_data: {} },
      orders: orders.map((parameters) => ({ parameters: { offerer: MAKER, ...parameters }, signature: "0x" })),
    },
  });
  // A listing offers the NFT for ETH; an offer pays WETH and asks for the NFT.
  const listing = (nftItem) => ({ offer: [nftItem], consideration: [item(0, ZERO, "1000")] });
  const bid = (nftItem) => ({ offer: [item(1, WETH, "1000")], consideration: [nftItem] });

  const buy = () => makeReq({
    query: { path: "listings/fulfillment_data" },
    body: { listing: { hash: "0xlisting", chain: "ethereum", protocol_address: SEAPORT }, fulfiller: FULFILLER },
  });
  const accept = (named) => makeReq({
    query: { path: "offers/fulfillment_data" },
    body: {
      offer: { hash: "0xoffer", chain: "ethereum", protocol_address: SEAPORT },
      fulfiller: FULFILLER,
      consideration: { asset_contract_address: named, token_id: "1" },
    },
  });
  async function send(req) {
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    return { status: statusSpy.mock.calls.at(-1)?.[0], body: jsonSpy.mock.calls.at(-1)?.[0] };
  }

  it("refuses a buy whose answer moves a Rare Towelie ERC-1155", async () => {
    upstream = answer(listing(item(3, RARE_TOWELIE)));
    const out = await send(buy());
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ error: "Contract not supported" });
  });

  it("refuses a buy when a second order's consideration asks for a Rare Towelie ERC-1155", async () => {
    upstream = answer(listing(item(2, GOLD)), { offer: [item(2, GOLD)], consideration: [item(0, ZERO, "1000"), item(3, RARE_TOWELIE)] });
    const out = await send(buy());
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ error: "Contract not supported" });
  });

  it("refuses an accept named for Gold whose answer hands over a Rare Towelie ERC-1155", async () => {
    upstream = answer(bid(item(3, RARE_TOWELIE)));
    const out = await send(accept(GOLD));
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ error: "Contract not supported" });
  });

  it("refuses an accept named for Gold whose answer hands over another venue collection", async () => {
    upstream = answer(bid(item(2, NAKAMIGOS)));
    const out = await send(accept(GOLD));
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ error: "Contract not supported" });
  });

  it("passes a Gold buy through with its answer intact", async () => {
    upstream = answer(listing(item(2, GOLD)));
    const out = await send(buy());
    expect(out.status).toBe(200);
    expect(out.body.fulfillment_data.orders[0].parameters.offer[0].token).toBe(GOLD);
  });

  it("passes a Gold accept, a collection bid's criteria item (itemType 4) included", async () => {
    upstream = answer(bid(item(4, GOLD.toLowerCase())));
    const out = await send(accept(GOLD));
    expect(out.status).toBe(200);
    expect(out.body.fulfillment_data.orders[0].parameters.consideration[0].itemType).toBe(4);
  });
});
