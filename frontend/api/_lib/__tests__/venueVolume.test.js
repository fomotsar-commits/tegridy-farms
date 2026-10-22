// ?resource=venue-volume: the home page's all-time volume. The rules under test are the
// ones a visitor relies on: a source never counted is no number at all, a late or failing
// source is "behind" with the time it was last complete, a failed read is never zero, and
// a good answer carries the edge cache header that makes it free.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { summarize, VOLUME_SOURCES, STALE_AFTER_MS } from "../venueVolumePolicy.js";

vi.mock("../ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

const NOW = Date.parse("2026-10-19T16:30:00Z");
const row = (source, over = {}) => ({
  source,
  swaps: 10,
  usd: "100.5",
  unpriced: 0,
  counted_to: "2026-10-19T16:00:00Z",
  last_ok_at: "2026-10-19T16:05:00Z",
  last_error_at: null,
  ...over,
});
const allRows = () => VOLUME_SOURCES.map((s) => row(s));

describe("summarize", () => {
  it("sums every source, as of the oldest source's count", () => {
    const rows = allRows();
    rows[2].counted_to = "2026-10-19T15:45:00Z";
    const s = summarize(rows, NOW);
    expect(s).toEqual({
      state: "current",
      usd: 502.5,
      swaps: 50,
      unpricedSwaps: 0,
      asOf: "2026-10-19T15:45:00.000Z",
      staleAt: new Date(Date.parse("2026-10-19T15:45:00Z") + STALE_AFTER_MS).toISOString(),
    });
  });

  it("is unread, with no number, while any source has never been counted", () => {
    expect(summarize(allRows().slice(1), NOW)).toEqual({ state: "unread" });
    const rows = allRows();
    rows[0].last_ok_at = null;
    expect(summarize(rows, NOW)).toEqual({ state: "unread" });
    rows[0] = row(rows[0].source, { usd: "not a number" });
    expect(summarize(rows, NOW)).toEqual({ state: "unread" });
    expect(summarize(null, NOW)).toEqual({ state: "unread" });
  });

  it("is behind when a source's last run failed", () => {
    const rows = allRows();
    rows[1].last_error_at = "2026-10-19T16:20:00Z";
    expect(summarize(rows, NOW).state).toBe("behind");
    rows[1].last_error_at = "2026-10-19T15:00:00Z"; // an old error, since recovered
    expect(summarize(rows, NOW).state).toBe("current");
  });

  it("stays current through GitHub's late runs, and is behind after nine hours", () => {
    // The longest gap measured between runs, 7.8 h, plus the ~16 min an EVM count trails.
    expect(summarize(allRows(), Date.parse("2026-10-20T00:05:00Z")).state).toBe("current");
    expect(summarize(allRows(), Date.parse("2026-10-20T01:00:00Z")).state).toBe("current");
    expect(summarize(allRows(), Date.parse("2026-10-20T01:00:01Z")).state).toBe("behind");
  });
});

function makeReq() {
  return { method: "GET", query: { resource: "venue-volume" }, headers: { origin: "https://tegridyfarms.vercel.app" } };
}
function makeRes() {
  const headers = {};
  const out = { status: 0, body: undefined, headers };
  const res = {
    setHeader: (k, v) => ((headers[k] = v), res),
    status: (c) => ((out.status = c), res),
    json: (b) => ((out.body = b), res),
    end: () => res,
  };
  return { res, out };
}

describe("handleVenueVolume", () => {
  let handleVenueVolume;
  beforeEach(async () => {
    process.env.SUPABASE_URL = "https://db.test";
    process.env.SUPABASE_SERVICE_KEY = "service";
    vi.spyOn(console, "error").mockImplementation(() => {});
    ({ handleVenueVolume } = await import("../venueVolume.js"));
  });
  afterEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    vi.restoreAllMocks();
  });

  it("serves the sum with an edge cache header, reading only the public columns", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(allRows()), { status: 200 }));
    const { res, out } = makeRes();
    await handleVenueVolume(makeReq(), res, { nowMs: NOW, fetchImpl });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ state: "current", usd: 502.5, swaps: 50 });
    expect(out.headers["Cache-Control"]).toMatch(/s-maxage=300/);
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain("/rest/v1/venue_volume?select=");
    expect(url).not.toMatch(/cursor|last_error,|bot_/);
  });

  it("answers a failed read with no number, never zero", async () => {
    for (const reply of [
      async () => new Response("boom", { status: 500 }),
      async () => new Response("<html>", { status: 200 }),
      async () => {
        throw new Error("timeout");
      },
    ]) {
      const { res, out } = makeRes();
      await handleVenueVolume(makeReq(), res, { nowMs: NOW, fetchImpl: reply });
      expect(out.body).toEqual({ state: "unread" });
      expect(out.headers["Cache-Control"]).toBe("s-maxage=30");
    }
  });

  it("answers unread with no keys configured", async () => {
    delete process.env.SUPABASE_SERVICE_KEY;
    const { res, out } = makeRes();
    await handleVenueVolume(makeReq(), res, { nowMs: NOW, fetchImpl: vi.fn() });
    expect(out.status).toBe(503);
    expect(out.body).toEqual({ state: "unread" });
  });
});
