// @vitest-environment node
// What the Solana RPC proxy does when its upstream takes the call and then says nothing,
// or sends half an answer and stops. Node, not jsdom, as in seaport-verify.body-stall.test.js.
// The browser puts no clock of its own on a request (web3.js 1.98), and the confirmation
// watch (src/lib/solana/confirm.ts) reads its limit only BETWEEN reads: one hung read held it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../_lib/ratelimit.js", () => ({ checkRateLimit: vi.fn(async () => true) }));

const DEADLINE_MS = 8_000;
const JSON_HEADERS = { "content-type": "application/json" };

function makeReq(method, params = []) {
  return {
    method: "POST",
    body: { jsonrpc: "2.0", method, params, id: 1 },
    headers: { origin: "https://tegridyfarms.vercel.app" },
  };
}

function makeRes() {
  const seen = { status: null, json: null, sent: null, done: false };
  const res = {
    setHeader: () => res,
    status: (c) => { seen.status = c; return res; },
    json: (p) => { seen.json = p; seen.done = true; return res; },
    send: (p) => { seen.sent = p; seen.done = true; return res; },
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
      stream.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,'));
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

describe("solrpc: an upstream that takes the call and does not answer is given up", () => {
  let handler;
  let timeouts;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = "test"; // origin gate permissive in non-prod
    handler = (await import("../solrpc.js")).default;
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
    const fetchMock = vi.fn(async () => new Response('{"jsonrpc":"2.0","result":"ok","id":1}', { status: 200, headers: JSON_HEADERS }));
    vi.stubGlobal("fetch", fetchMock);
    const ended = await watch(handler, makeReq("getSignatureStatuses", [["x"]]));
    expect(ended.status).toBe(200);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(timeouts.mock.calls.map((c) => c[0])).toEqual([DEADLINE_MS]);
  });

  // A read the watch repeats, and the send: the one call where giving up changes what a
  // person may be told, because the upstream may already have passed the bytes on.
  it.each(["getSignatureStatuses", "sendTransaction"])(
    "%s: a silent upstream is answered at 8 s, in the words an upstream that throws already gets",
    async (method) => {
      // What an upstream that THROWS is answered with today (the catch under the fetch).
      vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
      const thrown = await watch(handler, makeReq(method, ["AQID"]));
      expect(thrown).toMatchObject({ status: 502, json: { error: "Upstream RPC error" } });

      vi.stubGlobal("fetch", vi.fn((_url, init) => silent(init)));
      const ended = await watch(handler, makeReq(method, ["AQID"]));
      expect(ended, "still pending after 30 s").not.toBeNull();
      expect(ended.afterMs).toBe(DEADLINE_MS);
      // The SAME answer, word for word. The browser's senders read a send error by its words
      // ("simulation failed", "preflight", "Blockhash not found": never sent, in submit.ts,
      // ladder/write.ts and islandBasketSol.ts; "reject", "declin", "denied", "cancel": the
      // person's no, in walletThrow.ts). A new sentence is a new thing to misread.
      expect({ status: ended.status, json: ended.json }).toEqual({ status: thrown.status, json: thrown.json });
      expect(ended.sent).toBeNull();
    },
  );

  it("an upstream that stops part-way through its answer is given up at 8 s too", async () => {
    vi.stubGlobal("fetch", vi.fn((_url, init) => Promise.resolve(new Response(halfBody(init.signal), { status: 200, headers: JSON_HEADERS }))));
    const ended = await watch(handler, makeReq("getSignatureStatuses", [["x"]]));
    expect(ended, "still pending after 30 s").not.toBeNull();
    expect(ended.afterMs).toBe(DEADLINE_MS);
    expect(ended).toMatchObject({ status: 502, json: { error: "Upstream RPC error" }, sent: null });
  });

  it("an answer that comes inside the deadline is served whole", async () => {
    const answer = '{"jsonrpc":"2.0","result":{"value":[null]},"id":1}';
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => {
      setTimeout(() => resolve(new Response(answer, { status: 200, headers: JSON_HEADERS })), DEADLINE_MS - 100);
    })));
    const ended = await watch(handler, makeReq("getSignatureStatuses", [["x"]]));
    expect(ended).toMatchObject({ afterMs: DEADLINE_MS - 100, status: 200, sent: answer });
  });
});
