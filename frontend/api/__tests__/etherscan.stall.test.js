// @vitest-environment node
// What the Etherscan proxy does when Etherscan takes the call and then says nothing, or
// sends half an answer and stops. The stall's rule from solrpc.stall.test.js, on the
// explorer's read. Node, not jsdom; the clock runs on vitest's fake timers.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

const DEADLINE_MS = 8_000;
const JSON_HEADERS = { "content-type": "application/json" };
const ANSWER = { status: "1", message: "OK", result: [] };

function makeReq() {
  return {
    method: "GET",
    query: { module: "account", action: "txlist", address: "0x" + "a".repeat(40) },
    headers: { origin: "https://tegridyfarms.vercel.app" },
  };
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
      stream.enqueue(new TextEncoder().encode('{"status":"1","message":'));
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
  return settledAt === null ? null : { afterMs: settledAt, ...seen };
}

describe("etherscan: an Etherscan that takes the call and does not answer is given up", () => {
  let handler;
  let timeouts;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = "test";
    handler = (await import("../etherscan.js")).default;
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

  it("the upstream call carries a deadline, the house 8 s", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(ANSWER), { status: 200, headers: JSON_HEADERS }));
    vi.stubGlobal("fetch", fetchMock);
    const ended = await watch(handler, makeReq());
    expect(ended).toMatchObject({ status: 200, json: ANSWER });
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(timeouts.mock.calls.map((c) => c[0])).toEqual([DEADLINE_MS]);
  });

  it("a silent Etherscan is answered at 8 s, in the words an Etherscan that throws already gets", async () => {
    // What an upstream that THROWS is answered with today (the handler's own catch).
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const thrown = await watch(handler, makeReq());
    expect(thrown).toMatchObject({ status: 502, json: { error: "Etherscan proxy error" } });

    vi.stubGlobal("fetch", vi.fn((_url, init) => silent(init)));
    const ended = await watch(handler, makeReq());
    expect(ended, "still pending after 30 s").not.toBeNull();
    expect(ended.afterMs).toBe(DEADLINE_MS);
    // The SAME answer: the deadline adds no state the browser has not already met.
    expect({ status: ended.status, json: ended.json }).toEqual({ status: thrown.status, json: thrown.json });
  });

  it("an Etherscan that stops part-way through its answer is given up at 8 s too", async () => {
    vi.stubGlobal("fetch", vi.fn((_url, init) => Promise.resolve(new Response(halfBody(init.signal), { status: 200, headers: JSON_HEADERS }))));
    const ended = await watch(handler, makeReq());
    expect(ended, "still pending after 30 s").not.toBeNull();
    expect(ended.afterMs).toBe(DEADLINE_MS);
    expect(ended).toMatchObject({ status: 502, json: { error: "Etherscan proxy error" } });
  });

  it("an answer that comes inside the deadline is served whole", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => {
      setTimeout(() => resolve(new Response(JSON.stringify(ANSWER), { status: 200, headers: JSON_HEADERS })), DEADLINE_MS - 100);
    })));
    const ended = await watch(handler, makeReq());
    expect(ended).toMatchObject({ afterMs: DEADLINE_MS - 100, status: 200, json: ANSWER });
  });
});
