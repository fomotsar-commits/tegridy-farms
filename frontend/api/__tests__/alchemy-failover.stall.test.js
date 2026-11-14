// @vitest-environment node
// What the Alchemy key failover does when the FIRST key's upstream takes the call and then
// says nothing: neither a throw nor a retryable status, so the fallback was never tried.
// Node, not jsdom, as in seaport-verify.body-stall.test.js. Walked through the helper and
// through api/alchemy.js, whose three call sites (and api/v1/index.js's one) hand no clock.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const noopRateLimit = vi.fn(async () => true);
vi.mock("../_lib/ratelimit.js", () => ({ checkRateLimit: noopRateLimit, checkGlobalLimit: noopRateLimit }));

const ATTEMPT_MS = 8_000;
const PRIMARY = "primary-key-aaaaaaaaaaaaaaaaaaaa";
const FALLBACK = "fallback-key-bbbbbbbbbbbbbbbb";
const NAKAMIGOS = "0xd774557b647330c91bf44cfeab205095f7e6c367";
const JSON_HEADERS = { "content-type": "application/json" };

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

const keyOf = (init) => String(init?.headers?.Authorization ?? "").replace(/^Bearer /, "");

/** The first key's upstream is silent; any other key is answered with `body`. Records each ask. */
function firstKeyStalls(body) {
  const asked = [];
  const start = Date.now();
  vi.stubGlobal("fetch", vi.fn((url, init) => {
    asked.push({ key: keyOf(init), atMs: Date.now() - start, signal: init?.signal });
    if (keyOf(init) === PRIMARY) return silent(init);
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS }));
  }));
  return asked;
}

/** Runs `call` on the fake clock. Reports how it ended and when, or null if still pending after `watchMs`. */
async function watch(call, watchMs = 30_000) {
  const start = Date.now();
  let ended = null;
  Promise.resolve().then(call).then(
    (value) => (ended = { afterMs: Date.now() - start, value }),
    (error) => (ended = { afterMs: Date.now() - start, error }),
  );
  // Small steps: a timer armed by a promise chain is only seen once the chain has run.
  while (ended === null && Date.now() - start < watchMs) await vi.advanceTimersByTimeAsync(50);
  return ended;
}

function makeRes() {
  const seen = { status: null, json: null };
  const res = {
    setHeader: () => res,
    status: (c) => { seen.status = c; return res; },
    json: (p) => { seen.json = p; return res; },
    end: () => res,
  };
  return { res, seen };
}

function setKeys({ fallback = true } = {}) {
  process.env.ALCHEMY_API_KEY = PRIMARY;
  if (fallback) process.env.ALCHEMY_API_KEY_FALLBACK = FALLBACK;
  else delete process.env.ALCHEMY_API_KEY_FALLBACK;
  process.env.NODE_ENV = "test";
}

let timeouts;
beforeEach(() => {
  vi.resetModules();
  setKeys();
  vi.useFakeTimers();
  timeouts = deadlinesOnTheFakeClock();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.ALCHEMY_API_KEY;
  delete process.env.ALCHEMY_API_KEY_FALLBACK;
  delete process.env.NODE_ENV;
});

describe("alchemy-failover: a key whose upstream stalls", () => {
  // The request as api/alchemy.js builds it for an RPC call: method, headers, body, no clock.
  const asAlchemyJsBuildsIt = (key) => ({
    url: "https://eth-mainnet.g.alchemy.com/v2",
    opts: {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
    },
  });

  it("a first key that stalls is left at 8 s and the fallback key is asked", async () => {
    const { fetchAlchemyWithFailover } = await import("../_lib/alchemy-failover.js");
    const asked = firstKeyStalls({ jsonrpc: "2.0", id: 1, result: "0x10" });
    const ended = await watch(() => fetchAlchemyWithFailover(asAlchemyJsBuildsIt));
    expect(ended, "still pending after 30 s").not.toBeNull();
    expect(ended.afterMs).toBe(ATTEMPT_MS);
    expect(ended.value.ok).toBe(true);
    expect(asked.map((a) => [a.key, a.atMs])).toEqual([[PRIMARY, 0], [FALLBACK, ATTEMPT_MS]]);
    // Each attempt has a clock of its own: the fallback is not handed one that already ran out.
    expect(timeouts.mock.calls.map((c) => c[0])).toEqual([ATTEMPT_MS, ATTEMPT_MS]);
    expect(asked[1].signal.aborted).toBe(false);
  });

  it("with one key, a stall ends as a throw at 8 s, which every call site already answers", async () => {
    setKeys({ fallback: false });
    const { fetchAlchemyWithFailover } = await import("../_lib/alchemy-failover.js");
    const asked = firstKeyStalls({});
    const ended = await watch(() => fetchAlchemyWithFailover(asAlchemyJsBuildsIt));
    expect(ended, "still pending after 30 s").not.toBeNull();
    expect(ended.afterMs).toBe(ATTEMPT_MS);
    expect(ended.error?.name).toBe("TimeoutError");
    expect(asked).toHaveLength(1);
  });

  it("a call site's own clock is kept: the helper adds one only where none was handed", async () => {
    const { fetchAlchemyWithFailover } = await import("../_lib/alchemy-failover.js");
    const own = new AbortController().signal;
    const asked = firstKeyStalls({});
    vi.stubGlobal("fetch", vi.fn((_url, init) => {
      asked.push({ signal: init.signal });
      return Promise.resolve(new Response("{}", { status: 200, headers: JSON_HEADERS }));
    }));
    const ended = await watch(() => fetchAlchemyWithFailover((key) => {
      const built = asAlchemyJsBuildsIt(key);
      return { url: built.url, opts: { ...built.opts, signal: own } };
    }));
    expect(ended.value.ok).toBe(true);
    expect(asked[0].signal).toBe(own);
    expect(timeouts).not.toHaveBeenCalled();
  });

  it("everything else in the request reaches fetch as the call site built it", async () => {
    const { fetchAlchemyWithFailover } = await import("../_lib/alchemy-failover.js");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: JSON_HEADERS }));
    vi.stubGlobal("fetch", fetchMock);
    await watch(() => fetchAlchemyWithFailover(asAlchemyJsBuildsIt));
    const [url, opts] = fetchMock.mock.calls[0];
    const { signal, ...rest } = opts;
    expect(url).toBe("https://eth-mainnet.g.alchemy.com/v2");
    expect(rest).toEqual(asAlchemyJsBuildsIt(PRIMARY).opts);
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe("the call sites that hand the failover no clock: a stalled first key still ends in the fallback key's answer", () => {
  it("api/alchemy.js, an NFT read", async () => {
    const handler = (await import("../alchemy.js")).default;
    const asked = firstKeyStalls({ ownersForCollection: [] });
    const { res, seen } = makeRes();
    const req = { method: "GET", query: { endpoint: "getOwnersForContract", contractAddress: NAKAMIGOS }, body: null, headers: { origin: "https://memetics.finance" } };
    const ended = await watch(() => handler(req, res));
    expect(ended, "still pending after 30 s").not.toBeNull();
    expect(ended.afterMs).toBe(ATTEMPT_MS);
    expect(seen.status).toBe(200);
    expect(asked.map((a) => a.key)).toEqual([PRIMARY, FALLBACK]);
  });

  it("api/alchemy.js, the RPC pass-through", async () => {
    const handler = (await import("../alchemy.js")).default;
    const asked = firstKeyStalls({ jsonrpc: "2.0", id: 1, result: "0x10" });
    const { res, seen } = makeRes();
    const req = { method: "POST", query: { endpoint: "rpc" }, body: { method: "eth_blockNumber", params: [] }, headers: { origin: "https://memetics.finance" } };
    const ended = await watch(() => handler(req, res));
    expect(ended, "still pending after 30 s").not.toBeNull();
    expect(ended.afterMs).toBe(ATTEMPT_MS);
    expect(seen.status).toBe(200);
    expect(seen.json).toMatchObject({ result: "0x10" });
    expect(asked.map((a) => a.key)).toEqual([PRIMARY, FALLBACK]);
  });

  it("api/alchemy.js with one key: a stall ends at 8 s in the answer a thrown fetch already gets, never a hang", async () => {
    setKeys({ fallback: false });
    const handler = (await import("../alchemy.js")).default;
    const req = { method: "GET", query: { endpoint: "getOwnersForContract", contractAddress: NAKAMIGOS }, body: null, headers: { origin: "https://memetics.finance" } };

    // What a fetch that THROWS is answered with today (the handler's own catch).
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const thrown = makeRes();
    await watch(() => handler(req, thrown.res));
    expect(thrown.seen.status).toBeGreaterThanOrEqual(500);

    firstKeyStalls({});
    const { res, seen } = makeRes();
    const ended = await watch(() => handler(req, res));
    expect(ended, "still pending after 30 s").not.toBeNull();
    expect(ended.afterMs).toBe(ATTEMPT_MS);
    expect(seen).toEqual(thrown.seen);
  });
});
