// @vitest-environment node
// The public v1 routes that read an outside source with no helper between: the OpenSea
// listings, and the holder scan's two sources. A silent source is answered at 8 s with the
// refund and the words a source that throws already gets. Node, not jsdom; the clock runs
// on vitest's fake timers.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { settle } = vi.hoisted(() => ({ settle: vi.fn(async () => {}) }));

vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));
// A keyed caller on a metered tier, so the refund can be seen: `settle` is the meter.
vi.mock("../_lib/apiAuth.js", async (importOriginal) => ({
  ...(await importOriginal()),
  admitKeyedCall: vi.fn(async () => ({ admitted: true, keyed: true, keyId: "k1", tier: { id: "builder" }, settle })),
}));

const DEADLINE_MS = 8_000;
const JSON_HEADERS = { "content-type": "application/json" };
const TOKEN = "0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce";
const REFUSAL = { status: 500, json: { error: "Internal error" } };

function makeReq(query) {
  return { method: "GET", query, headers: { origin: "https://memetics.finance", "x-api-key": "a-presented-key" } };
}

function makeRes() {
  const seen = { status: null, json: null, done: false };
  const res = {
    setHeader: () => res,
    status: (c) => { seen.status = c; return res; },
    json: (p) => { seen.json = p; seen.done = true; return res; },
    end: () => { seen.done = true; return res; },
  };
  return { res, seen };
}

/** AbortSignal.timeout on the fake clock: Node arms the real one where vitest's clock never reaches. */
function deadlinesOnTheFakeClock() {
  return vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), ms);
    return ctrl.signal;
  });
}

/** An upstream that takes the call and ends only if the caller gives up. */
function silent(init) {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal.reason));
  });
}

/** A body that sends half an answer and then ends only by being aborted. */
function halfBody(signal) {
  return new ReadableStream({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('{"listings":['));
      signal?.addEventListener("abort", () => stream.error(signal.reason));
    },
  });
}

/** Runs the handler on the fake clock. Reports when it answered, or null if still pending after `watchMs`. */
async function watch(handler, req, watchMs = 30_000) {
  const { res, seen } = makeRes();
  const start = Date.now();
  let settledAt = null;
  Promise.resolve(handler(req, res)).then(
    () => (settledAt = Date.now() - start),
    () => (settledAt = Date.now() - start),
  );
  // Small steps: a timer armed by a promise chain is only seen once the chain has run.
  while (settledAt === null && Date.now() - start < watchMs) await vi.advanceTimersByTimeAsync(50);
  return settledAt === null ? null : { afterMs: settledAt, ...seen, settled: settle.mock.calls.map((c) => c[0]) };
}

describe("v1: a source that takes the call and does not answer is given up, and refunded", () => {
  let handler;
  let slug;
  let timeouts;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = "test";
    const mod = await import("../v1/index.js");
    handler = mod.default;
    slug = Object.keys(mod.SLUG_TO_CONTRACT)[0];
    vi.useFakeTimers();
    timeouts = deadlinesOnTheFakeClock();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.NODE_ENV;
  });

  describe("route=listings (OpenSea)", () => {
    const listings = () => makeReq({ route: "listings", slug });

    it("the OpenSea call carries a deadline, the house 8 s", async () => {
      const fetchMock = vi.fn(async () => new Response('{"listings":[]}', { status: 200, headers: JSON_HEADERS }));
      vi.stubGlobal("fetch", fetchMock);
      const ended = await watch(handler, listings());
      expect(ended).toMatchObject({ json: { slug, listings: [] }, settled: [200] });
      expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
      expect(timeouts.mock.calls.map((c) => c[0])).toEqual([DEADLINE_MS]);
    });

    it("a silent OpenSea is answered at 8 s, with the refund and the words an OpenSea that throws already gets", async () => {
      // What an upstream that THROWS is answered with today (the route's own catch).
      vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
      const thrown = await watch(handler, listings());
      expect(thrown).toMatchObject({ ...REFUSAL, settled: [500] });

      settle.mockClear();
      vi.stubGlobal("fetch", vi.fn((_url, init) => silent(init)));
      const ended = await watch(handler, listings());
      expect(ended, "still pending after 30 s").not.toBeNull();
      expect(ended.afterMs).toBe(DEADLINE_MS);
      // The SAME answer, and the same refund: a call the venue gave up on is not metered.
      expect({ status: ended.status, json: ended.json, settled: ended.settled }).toEqual({ status: thrown.status, json: thrown.json, settled: thrown.settled });
    });

    it("an OpenSea that stops part-way through its answer is given up at 8 s too", async () => {
      vi.stubGlobal("fetch", vi.fn((_url, init) => Promise.resolve(new Response(halfBody(init.signal), { status: 200, headers: JSON_HEADERS }))));
      const ended = await watch(handler, listings());
      expect(ended, "still pending after 30 s").not.toBeNull();
      expect(ended.afterMs).toBe(DEADLINE_MS);
      expect(ended).toMatchObject({ ...REFUSAL, settled: [500] });
    });

    it("an answer that comes inside the deadline is served whole", async () => {
      vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => {
        setTimeout(() => resolve(new Response('{"listings":[]}', { status: 200, headers: JSON_HEADERS })), DEADLINE_MS - 100);
      })));
      const ended = await watch(handler, listings());
      expect(ended).toMatchObject({ afterMs: DEADLINE_MS - 100, json: { slug, listings: [] }, settled: [200] });
    });
  });

  // The holder scan's clock is one per read, pinned leg by leg in scannerApi.stall.test.js.
  // Here: what the public route says, and that it refunds.
  describe.each(["ethereum", "base"])("route=erc20scan, chain=%s", (chain) => {
    const scan = () => makeReq({ route: "erc20scan", contract: TOKEN, chain });

    it("a silent holder source is answered at 8 s, with the refund and the words a source that throws already gets", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
      const thrown = await watch(handler, scan());
      expect(thrown).toMatchObject({ ...REFUSAL, settled: [500] });

      settle.mockClear();
      vi.stubGlobal("fetch", vi.fn((_url, init) => silent(init)));
      const ended = await watch(handler, scan());
      expect(ended, "still pending after 30 s").not.toBeNull();
      expect(ended.afterMs).toBe(DEADLINE_MS);
      expect({ status: ended.status, json: ended.json, settled: ended.settled }).toEqual({ status: thrown.status, json: thrown.json, settled: thrown.settled });
    });
  });
});
