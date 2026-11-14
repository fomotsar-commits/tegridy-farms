// @vitest-environment node
// The holder reads (Ethplorer for Ethereum, Blockscout for Base) when a leg takes the call
// and says nothing, or stops part-way through its answer. One clock for a whole read, so
// the Base read's page two cannot carry the read past it. Node, not jsdom; the clock runs
// on vitest's fake timers.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const TOKEN = "0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce";
const CLOCK_MS = 8_000;
const JSON_HEADERS = { "content-type": "application/json" };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
/** The same answer, `ms` later. */
const later = (ms, make) => new Promise((resolve) => setTimeout(() => resolve(make()), ms));

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
      stream.enqueue(new TextEncoder().encode('{"holders":['));
      signal?.addEventListener("abort", () => stream.error(signal.reason));
    },
  });
}

/** Runs `run` on the fake clock. Reports when it ended and how, or null if still pending after `watchMs`. */
async function watch(run, watchMs = 30_000) {
  const start = Date.now();
  let ended = null;
  Promise.resolve().then(run).then(
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
  };
  return { res, seen };
}

// Ethplorer: a token whose holder list is read and empty, so the read ends without the
// code walk (a third upstream, with its own clock in _lib/eth-code.js).
const EP_INFO = { name: "Shiba Inu", symbol: "SHIB", decimals: "18", totalSupply: "999982329055168014311278372706779", holdersCount: 0 };
const EP_TOP = { holders: [] };
const isTop = (url) => String(url).includes("getTopTokenHolders");

// Blockscout: sixty holders over two pages of fifty and ten.
const row = (i) => ({ address: { hash: "0x" + String(i).padStart(40, "0"), is_contract: false }, value: "10" });
const BS_INFO = { type: "ERC-20", name: "Base Coin", symbol: "BC", decimals: "18", total_supply: "600", holders_count: "60" };
const BS_PAGE_ONE = { items: Array.from({ length: 50 }, (_, i) => row(i + 1)), next_page_params: { items_count: 50, value: "10" } };
const BS_PAGE_TWO = { items: Array.from({ length: 10 }, (_, i) => row(i + 51)), next_page_params: null };
const isPageTwo = (url) => String(url).includes("holders?");
const isPageOne = (url) => String(url).endsWith("/holders");

describe("the holder reads: a source that takes the call and does not answer is given up", () => {
  let api;
  let timeouts;

  beforeEach(async () => {
    vi.resetModules();
    api = await import("../_lib/scannerApi.js");
    vi.useFakeTimers();
    timeouts = deadlinesOnTheFakeClock();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("Ethereum (Ethplorer)", () => {
    it("both legs carry the same clock, the house 8 s", async () => {
      const fetchMock = vi.fn(async (url) => json(isTop(url) ? EP_TOP : EP_INFO));
      vi.stubGlobal("fetch", fetchMock);
      const ended = await watch(() => api.readErc20Distribution(TOKEN));
      expect(ended.value).toMatchObject({ ok: true, data: { source: "ethplorer", holders: [] } });
      const signals = fetchMock.mock.calls.map((c) => c[1].signal);
      expect(signals).toHaveLength(2);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals[1], "one clock, not one per leg").toBe(signals[0]);
      expect(timeouts.mock.calls.map((c) => c[0])).toEqual([CLOCK_MS]);
    });

    it("a silent leg ends the read at 8 s, as a leg that throws does", async () => {
      // What a leg that THROWS does today: the read throws, and each caller answers it.
      vi.stubGlobal("fetch", vi.fn(async (url) => { if (isTop(url)) throw new TypeError("fetch failed"); return json(EP_INFO); }));
      const thrown = await watch(() => api.readErc20Distribution(TOKEN));
      expect(thrown.error).toBeInstanceOf(TypeError);

      vi.stubGlobal("fetch", vi.fn((url, init) => (isTop(url) ? silent(init) : Promise.resolve(json(EP_INFO)))));
      const ended = await watch(() => api.readErc20Distribution(TOKEN));
      expect(ended, "still pending after 30 s").not.toBeNull();
      expect(ended.afterMs).toBe(CLOCK_MS);
      expect(ended.error?.name).toBe("TimeoutError");
    });

    it("a leg that stops part-way through its answer ends the read at 8 s too", async () => {
      vi.stubGlobal("fetch", vi.fn((url, init) => Promise.resolve(isTop(url) ? new Response(halfBody(init.signal), { status: 200, headers: JSON_HEADERS }) : json(EP_INFO))));
      const ended = await watch(() => api.readErc20Distribution(TOKEN));
      expect(ended, "still pending after 30 s").not.toBeNull();
      expect(ended.afterMs).toBe(CLOCK_MS);
      expect(ended.error?.name).toBe("TimeoutError");
    });

    it("legs that answer inside the clock are read whole", async () => {
      vi.stubGlobal("fetch", vi.fn((url) => later(CLOCK_MS - 100, () => json(isTop(url) ? EP_TOP : EP_INFO))));
      const ended = await watch(() => api.readErc20Distribution(TOKEN));
      expect(ended).toMatchObject({ afterMs: CLOCK_MS - 100, value: { ok: true } });
    });

    // The keyed scan is the sold surface: what it says when it could not read is the product.
    it("the keyed scan: a silent source is refused at 8 s exactly as one that throws, and never as a clean result", async () => {
      const scan = async () => {
        const { res, seen } = makeRes();
        const ended = await watch(() => api.handleScanRoute({ query: { chain: "ethereum", address: TOKEN } }, res, { tier: { id: "builder" } }));
        return ended && { afterMs: ended.afterMs, returned: ended.value, ...seen };
      };
      vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
      const thrown = await scan();
      expect(thrown).toMatchObject({ returned: 502, status: 502, json: { code: "upstream_unavailable", scanned: false } });

      vi.stubGlobal("fetch", vi.fn((_url, init) => silent(init)));
      const ended = await scan();
      expect(ended, "still pending after 30 s").not.toBeNull();
      expect(ended.afterMs).toBe(CLOCK_MS);
      // The status it returns is what the caller settles the meter with: a 5xx is not billed.
      expect({ returned: ended.returned, status: ended.status, json: ended.json }).toEqual({ returned: thrown.returned, status: thrown.status, json: thrown.json });
      expect(ended.json).not.toHaveProperty("distribution");
    });
  });

  describe("Base (Blockscout)", () => {
    const serve = (pageTwo, firstLegsAfterMs = 0) => vi.fn((url, init) => {
      if (isPageTwo(url)) return pageTwo(init);
      return later(firstLegsAfterMs, () => json(isPageOne(url) ? BS_PAGE_ONE : BS_INFO));
    });

    it("both first legs and page two carry the same clock, the house 8 s", async () => {
      const fetchMock = serve(() => Promise.resolve(json(BS_PAGE_TWO)));
      vi.stubGlobal("fetch", fetchMock);
      const ended = await watch(() => api.readBaseErc20Distribution(TOKEN));
      expect(ended.value).toMatchObject({ ok: true, data: { source: "blockscout" } });
      expect(ended.value.data.holders).toHaveLength(60);
      const signals = fetchMock.mock.calls.map((c) => c[1].signal);
      expect(signals).toHaveLength(3);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals.every((s) => s === signals[0]), "one clock for the read, page two included").toBe(true);
      expect(timeouts.mock.calls.map((c) => c[0])).toEqual([CLOCK_MS]);
    });

    it("a silent page two fails the read at the READ's 8 s, not 8 s after page one", async () => {
      // The first legs take 3 s. A clock per leg would end this at 11 s, past a function's default limit.
      vi.stubGlobal("fetch", serve((init) => silent(init), 3_000));
      const ended = await watch(() => api.readBaseErc20Distribution(TOKEN));
      expect(ended, "still pending after 30 s").not.toBeNull();
      expect(ended.afterMs).toBe(CLOCK_MS);
      // A failed page two fails the whole read, as it already does: never 50 of 100 served as asked.
      expect(ended.value).toEqual({ ok: false, kind: "upstream" });
    });

    it("a silent first leg ends the read at 8 s, as a leg that throws does", async () => {
      vi.stubGlobal("fetch", vi.fn(async (url) => { if (isPageOne(url)) throw new TypeError("fetch failed"); return json(BS_INFO); }));
      const thrown = await watch(() => api.readBaseErc20Distribution(TOKEN));
      expect(thrown.error).toBeInstanceOf(TypeError);

      vi.stubGlobal("fetch", vi.fn((url, init) => (isPageOne(url) ? silent(init) : Promise.resolve(json(BS_INFO)))));
      const ended = await watch(() => api.readBaseErc20Distribution(TOKEN));
      expect(ended, "still pending after 30 s").not.toBeNull();
      expect(ended.afterMs).toBe(CLOCK_MS);
      expect(ended.error?.name).toBe("TimeoutError");
    });

    it("a page two that answers inside the read's clock is read whole", async () => {
      vi.stubGlobal("fetch", serve(() => later(4_900, () => json(BS_PAGE_TWO)), 3_000));
      const ended = await watch(() => api.readBaseErc20Distribution(TOKEN));
      expect(ended).toMatchObject({ afterMs: 7_900, value: { ok: true } });
      expect(ended.value.data.holders).toHaveLength(60);
    });
  });
});
