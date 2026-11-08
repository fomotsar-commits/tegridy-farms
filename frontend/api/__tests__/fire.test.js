// `?resource=fire` (island answer twenty-four, build 4): the island's fire this week, for
// Bayla's intel line. Forwards the totals only, caches five minutes, and a read that fails
// is a 502 the line leaves out, never a zero.
import { describe, it, expect, vi } from "vitest";

vi.mock("../_lib/ratelimit.js", () => ({ checkRateLimit: vi.fn(async () => true), checkGlobalLimit: vi.fn(async () => true) }));

import { handleFire, toPublicFire } from "../_lib/fire.js";

const UPSTREAM = {
  floor: 1000,
  fire: { since: "2026-10-25T22:51:57.655Z", burned: 339866, feeds: 19, torches: 1 },
  week: { starts_at: "2026-10-26T00:00:00.000Z", ends_at: "2026-11-02T00:00:00.000Z", burned: 339866, keeper: { name: "someone", burned: 50000 }, by: [{ name: "someone", burned: 50000 }] },
};

function makeReq(method = "GET") {
  return { method, query: { resource: "fire" }, headers: { origin: "https://tegridyfarms.vercel.app" } };
}
function makeRes() {
  const out = { status: 0, body: undefined, headers: {} };
  const res = {
    setHeader: (k, v) => ((out.headers[k] = v), res),
    status: (c) => ((out.status = c), res),
    json: (b) => ((out.body = b), res),
    end: () => res,
  };
  return { res, out };
}

describe("?resource=fire", () => {
  it("forwards the week's and the fire's totals, nobody's name, cached five minutes", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(UPSTREAM), { status: 200 }));
    const { res, out } = makeRes();
    await handleFire(makeReq(), res, { fetchImpl });
    expect(out.status).toBe(200);
    expect(out.headers["Cache-Control"]).toBe("s-maxage=300, stale-while-revalidate=600");
    expect(out.body).toEqual({
      week: { starts_at: "2026-10-26T00:00:00.000Z", ends_at: "2026-11-02T00:00:00.000Z", burned: 339866 },
      fire: { since: "2026-10-25T22:51:57.655Z", burned: 339866, feeds: 19, torches: 1 },
    });
    expect(JSON.stringify(out.body)).not.toContain("someone");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://memetics.wtf/api/fire");
  });

  it("a failed read, a wrong shape or a thrown fetch is 502 no-store: the line leaves the fact out", async () => {
    for (const fetchImpl of [
      vi.fn(async () => new Response("down", { status: 503 })),
      vi.fn(async () => new Response(JSON.stringify({ floor: 1000 }), { status: 200 })),
      vi.fn(async () => {
        throw new Error("network");
      }),
    ]) {
      const { res, out } = makeRes();
      await handleFire(makeReq(), res, { fetchImpl });
      expect(out.status).toBe(502);
      expect(out.headers["Cache-Control"]).toBe("private, no-store");
    }
  });

  it("is GET only", async () => {
    const { res, out } = makeRes();
    await handleFire(makeReq("POST"), res, { fetchImpl: vi.fn() });
    expect(out.status).toBe(405);
  });

  it("toPublicFire takes only numbers it can read", () => {
    expect(toPublicFire({ week: { burned: "lots" } })).toBeNull();
    expect(toPublicFire({ week: { burned: 5 } })).toEqual({ week: { starts_at: null, ends_at: null, burned: 5 }, fire: null });
  });
});
