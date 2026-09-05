// OUTAGE-AS-ZERO (audit 2026-09-04). A refused/throttled first page of
// GeckoTerminal new_pools ended the walk the SAME way a clean "no new pools"
// answer did, and the handler then sent HTTP 200 with `data: []` and a FRESH
// `observedAt` — a claim that we read the whole market at that second and
// nothing launched — and told the CDN to cache it for 60s (+300s SWR).
//
// The three outcomes must stay separable on the wire:
//   502                          could not look
//   200 + poolsReadFailed:false  looked; this is the window (empty = real zero)
//   200 + poolsReadFailed:true   looked, but the window is SHORT
import { describe, it, expect, beforeEach, vi } from "vitest";

import { handleLaunchRadar } from "../_lib/launch-radar.js";

function page(rows) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: null,
    text: async () => JSON.stringify({ data: rows }),
  };
}
const REFUSED = { ok: false, status: 429, headers: { get: () => null }, body: null, text: async () => "" };

function makeReq() {
  return { method: "GET", query: {}, headers: { origin: "https://memetics.finance" } };
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
function headersOf(headerSpy) {
  const out = {};
  for (const [k, v] of headerSpy.mock.calls) out[k] = v;
  return out;
}

const ROW = { id: "pool-1", attributes: { name: "X / WETH" } };

beforeEach(() => { vi.restoreAllMocks(); });

describe("launch-radar — an unread window is not an empty market", () => {
  it("a refused first page answers 502, never 200 with an empty list", async () => {
    globalThis.fetch = vi.fn(async () => REFUSED);
    const { res, statusSpy, jsonSpy } = makeRes();
    await handleLaunchRadar(makeReq(), res);
    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(statusSpy).not.toHaveBeenCalledWith(200);
    const payload = jsonSpy.mock.calls.at(-1)[0];
    // The lie was `observedAt` — it asserted we looked. It must not be sent.
    expect(payload.observedAt).toBeUndefined();
    expect(payload.data).toBeUndefined();
  });

  it("does not pin an unread window at the shared edge", async () => {
    globalThis.fetch = vi.fn(async () => REFUSED);
    const { res, headerSpy } = makeRes();
    await handleLaunchRadar(makeReq(), res);
    expect(headersOf(headerSpy)["Cache-Control"]).toBeUndefined();
  });

  it("a genuine empty window is still a 200 and is NOT flagged unread", async () => {
    globalThis.fetch = vi.fn(async () => page([]));
    const { res, statusSpy, jsonSpy } = makeRes();
    await handleLaunchRadar(makeReq(), res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    const payload = jsonSpy.mock.calls.at(-1)[0];
    expect(payload.data).toEqual([]);
    expect(payload.poolsReadFailed).toBe(false);
    expect(typeof payload.observedAt).toBe("number");
  });

  it("a SHORT window (later page refused) keeps its rows but is flagged", async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => { call += 1; return call === 1 ? page([ROW]) : REFUSED; });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handleLaunchRadar(makeReq(), res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    const payload = jsonSpy.mock.calls.at(-1)[0];
    expect(payload.data).toHaveLength(1);
    expect(payload.poolsReadFailed).toBe(true);
  });

  it("a fully read window is not flagged", async () => {
    globalThis.fetch = vi.fn(async () => page([ROW]));
    const { res, jsonSpy } = makeRes();
    await handleLaunchRadar(makeReq(), res);
    const payload = jsonSpy.mock.calls.at(-1)[0];
    expect(payload.poolsReadFailed).toBe(false);
  });
});
