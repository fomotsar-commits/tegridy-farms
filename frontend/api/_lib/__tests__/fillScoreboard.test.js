// ?resource=fill-scoreboard: the Solana swap page's quote-against-fill line. The rules under
// test are the ones a visitor relies on: no finished run is no number, a failed or oversized
// read is never a figure, and a good answer carries the edge cache header that makes it free.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

const NOW = Date.parse("2026-10-22T12:00:00Z");
const CURSOR = [{ counted_to: "2026-10-22T11:41:00Z", last_ok_at: "2026-10-22T11:42:00Z", last_error_at: null }];
const ROW = {
  block_time: "2026-10-21T00:00:00Z",
  bot: false,
  quoted_out: "1000000",
  delivered_out: "1000100",
  slippage_bps: 50,
  deposit_lamports: "0",
  unread_reason: null,
};

function makeReq() {
  return { method: "GET", query: { resource: "fill-scoreboard" }, headers: { origin: "https://tegridyfarms.vercel.app" } };
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
const answer = (status, body) => new Response(JSON.stringify(body), { status });

describe("handleFillScoreboard", () => {
  let handleFillScoreboard;
  const saved = { ...process.env };
  beforeEach(async () => {
    process.env.SUPABASE_URL = "https://db.test";
    process.env.SUPABASE_SERVICE_KEY = "k";
    ({ handleFillScoreboard } = await import("../fillScoreboard.js"));
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  function fakeDb(cursor, rows) {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      return url.includes("fill_scoreboard_cursor") ? cursor() : rows();
    };
    return { urls, fetchImpl };
  }

  it("summarizes the last 30 days and lets the edge cache it", async () => {
    const db = fakeDb(() => answer(200, CURSOR), () => answer(200, [ROW]));
    const { res, out } = makeRes();
    await handleFillScoreboard(makeReq(), res, { nowMs: NOW, fetchImpl: db.fetchImpl });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ state: "current", trades: 1, medianFillBps: 1, atOrAboveQuote: 1 });
    expect(out.headers["Cache-Control"]).toBe("s-maxage=300, stale-while-revalidate=600");
    const rowsUrl = db.urls.find((u) => u.includes("fill_scoreboard?"));
    // Amounts come back as text: a numeric JSON number loses digits past 2^53.
    expect(rowsUrl).toContain("quoted_out::text");
    expect(rowsUrl).toContain(`block_time=gte.${encodeURIComponent("2026-09-22T12:00:00.000Z")}`);
  });

  it("is unread, with no number, before the first finished run", async () => {
    const db = fakeDb(() => answer(200, []), () => answer(200, [ROW]));
    const { res, out } = makeRes();
    await handleFillScoreboard(makeReq(), res, { nowMs: NOW, fetchImpl: db.fetchImpl });
    expect(out.body).toEqual({ state: "unread" });
    expect(out.headers["Cache-Control"]).toBe("s-maxage=30");
  });

  it("is unread when either read fails or the window holds more rows than one read", async () => {
    for (const [cursor, rows] of [
      [() => answer(500, {}), () => answer(200, [ROW])],
      [() => answer(200, CURSOR), () => answer(404, { code: "PGRST205" })],
      [() => answer(200, CURSOR), () => answer(200, Array.from({ length: 5001 }, () => ROW))],
      [() => Promise.reject(new Error("down")), () => answer(200, [ROW])],
    ]) {
      const { res, out } = makeRes();
      await handleFillScoreboard(makeReq(), res, { nowMs: NOW, fetchImpl: fakeDb(cursor, rows).fetchImpl });
      expect(out.body).toEqual({ state: "unread" });
    }
  });

  it("is unread with no secrets, and refuses other methods", async () => {
    delete process.env.SUPABASE_SERVICE_KEY;
    const { res, out } = makeRes();
    await handleFillScoreboard(makeReq(), res, { nowMs: NOW, fetchImpl: async () => answer(200, []) });
    expect(out).toMatchObject({ status: 503, body: { state: "unread" } });

    const post = makeRes();
    await handleFillScoreboard({ ...makeReq(), method: "POST" }, post.res, { nowMs: NOW });
    expect(post.out.status).toBe(405);
  });
});
