// AUDIT R053 integration tests: OpenSea proxy schema validation + URL
// scheme sanitization + cache-control selection + price sanity cap.

import { describe, it, expect, beforeEach, vi } from "vitest";

process.env.NODE_ENV = "test";
process.env.OPENSEA_API_KEY = "test-key";
process.env.ALLOWED_ORIGIN = "https://test.invalid";

// Rate-limiter pass-through
vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
}));

const fetchMock = vi.fn();
globalThis.fetch = fetchMock;

function mockOpenseaResponse(body) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  });
}

function mockOpenseaText(text, status = 200) {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  });
}

function makeReqRes(query, method = "GET", body = undefined) {
  const req = {
    method,
    headers: { origin: "https://test.invalid" },
    query,
    body,
  };
  const headers = {};
  const statusSpy = vi.fn();
  const jsonSpy = vi.fn();
  const res = {
    status: (code) => { statusSpy(code); return res; },
    json: (payload) => { jsonSpy(payload); return res; },
    setHeader: vi.fn((k, v) => { headers[k.toLowerCase()] = v; }),
    end: vi.fn(),
  };
  return { req, res, statusSpy, jsonSpy, headers };
}

describe("opensea proxy R053 — schema, URL allowlist, cache headers", () => {
  let handler;

  beforeEach(async () => {
    fetchMock.mockReset();
    vi.resetModules();
    handler = (await import("../opensea.js")).default;
  });

  it("strips javascript: scheme from image_url before forwarding (XSS guard)", async () => {
    mockOpenseaResponse({
      listings: [{
        order_hash: "0xabc",
        nft: { image_url: "javascript:alert(1)", external_url: "https://safe.example" },
        price: { current: { value: "1000000000000000000", currency: "ETH", decimals: 18 } },
      }],
    });
    const { req, res, jsonSpy, statusSpy } = makeReqRes({ path: "listings/collection/nakamigos/best" });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    const payload = jsonSpy.mock.calls[0][0];
    expect(payload.listings[0].nft.image_url).toBeNull();
    // safe URL preserved
    expect(payload.listings[0].nft.external_url).toBe("https://safe.example");
  });

  it("strips data:text/html and other non-image data: schemes", async () => {
    mockOpenseaResponse({
      listings: [{
        nft: {
          image_url: "data:text/html,<script>alert(1)</script>",
          animation_url: "data:image/svg+xml;base64,PHN2Zw==", // svg explicitly disallowed
        },
      }],
    });
    const { req, res, jsonSpy } = makeReqRes({ path: "listings/collection/nakamigos/best" });
    await handler(req, res);
    const payload = jsonSpy.mock.calls[0][0];
    expect(payload.listings[0].nft.image_url).toBeNull();
    expect(payload.listings[0].nft.animation_url).toBeNull();
  });

  it("preserves allowlisted ipfs:// and ar:// schemes", async () => {
    mockOpenseaResponse({
      listings: [{
        nft: {
          image_url: "ipfs://QmZ123abc",
          animation_url: "ar://abc-def-ghi",
          external_url: "https://nft.example",
        },
      }],
    });
    const { req, res, jsonSpy } = makeReqRes({ path: "listings/collection/nakamigos/best" });
    await handler(req, res);
    const payload = jsonSpy.mock.calls[0][0];
    expect(payload.listings[0].nft.image_url).toBe("ipfs://QmZ123abc");
    expect(payload.listings[0].nft.animation_url).toBe("ar://abc-def-ghi");
    expect(payload.listings[0].nft.external_url).toBe("https://nft.example");
  });

  // ── H-1: schema validation ──
  it("rejects 502 when listings have non-string wei value (schema mismatch)", async () => {
    mockOpenseaResponse({
      listings: [{
        order_hash: "0x1",
        price: { current: { value: 12345 } }, // number, schema expects string
      }],
    });
    const { req, res, statusSpy, jsonSpy } = makeReqRes({ path: "listings/collection/nakamigos/best" });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringMatching(/unexpected shape/i),
    }));
  });

  it("rejects 502 when wei value contains non-numeric chars", async () => {
    mockOpenseaResponse({
      listings: [{
        price: { current: { value: "1e23" } }, // schema regex ^[0-9]+$ rejects scientific
      }],
    });
    const { req, res, statusSpy } = makeReqRes({ path: "listings/collection/nakamigos/best" });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(502);
  });

  it("nulls out price.current.value when above MAX_OPENSEA_PRICE_WEI", async () => {
    // 10**25 wei = 10M ETH (above 1M cap). Schema regex passes (decimal), but
    // sanitize-walker should null the value so the consumer doesn't BigInt
    // it into a 10M-ETH "floor".
    mockOpenseaResponse({
      listings: [{
        price: { current: { value: "1".padEnd(26, "0") } },
      }],
    });
    const { req, res, jsonSpy } = makeReqRes({ path: "listings/collection/nakamigos/best" });
    await handler(req, res);
    const payload = jsonSpy.mock.calls[0][0];
    expect(payload.listings[0].price.current.value).toBeNull();
  });

  // ── Cache-Control selection ──
  it("uses private,no-store for offers/build (POST mutation)", async () => {
    mockOpenseaResponse({});
    const { req, res, headers } = makeReqRes({ path: "offers/build" }, "POST", {});
    await handler(req, res);
    expect(headers["cache-control"]).toBe("private, no-store");
  });

  it("uses 60s s-maxage for collection stats (public, slower-moving)", async () => {
    mockOpenseaResponse({ total: { volume: 100 } });
    const { req, res, headers } = makeReqRes({ path: "collection/nakamigos/stats" });
    await handler(req, res);
    expect(headers["cache-control"]).toMatch(/s-maxage=60/);
  });

  it("uses private,no-store when query carries maker= (user-bound)", async () => {
    mockOpenseaResponse({ orders: [] });
    const { req, res, headers } = makeReqRes({
      path: "orders/ethereum/seaport/listings",
      maker: "0x" + "1".repeat(40),
    });
    await handler(req, res);
    expect(headers["cache-control"]).toBe("private, no-store");
  });

  it("happy path: forwards data unchanged when no URL or price violations", async () => {
    mockOpenseaResponse({
      listings: [{
        order_hash: "0xabc",
        type: "basic",
        price: { current: { value: "1000000000000000000", currency: "ETH", decimals: 18 } },
        protocol_data: { signature: "0xdeadbeef" },
      }],
    });
    const { req, res, statusSpy, jsonSpy } = makeReqRes({ path: "listings/collection/nakamigos/best" });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    const payload = jsonSpy.mock.calls[0][0];
    expect(payload.listings[0].price.current.value).toBe("1000000000000000000");
    expect(payload.listings[0].protocol_data).toEqual({ signature: "0xdeadbeef" });
  });

  it("502 on non-JSON upstream response (existing behaviour preserved)", async () => {
    mockOpenseaText("<html>500 internal error</html>");
    const { req, res, statusSpy } = makeReqRes({ path: "listings/collection/nakamigos/best" });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(502);
  });
});
