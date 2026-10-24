// @vitest-environment node
// ?resource=range-stats, range-pools, range-swaps. The rows come from the real hourly count
// (scripts/range-stats.mjs) run twice over a fake chain into a fake PostgREST, so each figure
// here is the count's own; the program's split is applied by hand, swap by swap, to check it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BEHIND_AFTER_MS, stateOf, windowFigures } from "../rangeStats.js";
import { RANGE_PROGRAM_ID } from "../rangeEvents.js";
import { ENV, POOL, T0, createdData, fakeDb, ix, key, run, seededPool, split, swapData, world } from "../../../scripts/lib/range-stats-cases.mjs";

vi.mock("../ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

const HERE = dirname(fileURLToPath(import.meta.url));

const snap = (slot, time, over = {}) => ({
  slot, block_time: new Date(time * 1000).toISOString(), at_open: false, trade_fee_rate: 10_000, protocol_fee_rate: 104_000, fund_fee_rate: 56_000,
  cum_swaps: "0", protocol_fees_0: "0", protocol_fees_1: "0", fund_fees_0: "0", fund_fees_1: "0", cum_volume_0: "0", cum_volume_1: "0",
  cum_fees_0: "0", cum_fees_1: "0", cum_vault_collected_0: "0", cum_vault_collected_1: "0", cum_workshop_collected_0: "0", cum_workshop_collected_1: "0", sqrt_price_x64: "1", ...over,
});
const A = snap(100, T0);
const B = snap(200, T0 + 3600, { cum_swaps: "3", cum_fees_0: "100000", protocol_fees_0: "10400", fund_fees_0: "5600", cum_volume_0: "9" });
const NUMBERS = /^(swaps|volume_|fees_|to_positions_|vault_|workshop_|no_range_)/;

describe("one window", () => {
  it("a window with a fault gap answers `complete: false` and no number", () => {
    const hole = { kind: "log-truncated", standing: false, signature: "sig", from_slot: 150, to_slot: 150, detail: "cut" };
    const w = windowFigures(A, B, [hole]);
    expect(w.complete).toBe(false);
    expect(w.reason).toBe("gap");
    expect(w.gaps).toEqual([expect.objectContaining({ kind: "log-truncated", from_slot: 150 })]);
    expect(Object.keys(w).filter((k) => NUMBERS.test(k))).toEqual([]);
    // A hole outside the window, or at its start slot (already inside the earlier snapshot), does not touch it.
    expect(windowFigures(A, B, [{ ...hole, from_slot: 100, to_slot: 100 }]).complete).toBe(true);
    expect(windowFigures(A, B, [{ ...hole, from_slot: 201, to_slot: 300 }]).complete).toBe(true);
    expect(windowFigures(A, B, [{ ...hole, from_slot: 200, to_slot: 300 }]).complete).toBe(false);
  });

  it("fees to positions are all fees less the vault's and the Workshop's gain and collections", () => {
    const w = windowFigures(A, { ...B, protocol_fees_0: "400", cum_vault_collected_0: "10000" }, []);
    expect(w).toMatchObject({ complete: true, swaps: 3, fees_0: "100000", vault_0: "10400", workshop_0: "5600", to_positions_0: "84000", no_range_0: "0", no_range_basis: "rate" });
  });

  it("a tier change withholds only the no-range share, and says why", () => {
    const w = windowFigures(A, B, [{ kind: "tier-changed", standing: true, from_slot: 101, to_slot: 200, detail: "rates" }]);
    expect(w).toMatchObject({ complete: true, to_positions_0: "84000", no_range_0: null, no_range_basis: "tier-changed" });
    expect(w.limits).toHaveLength(1);
  });

  it("figures that do not add up are no figures", () => {
    expect(windowFigures(A, { ...B, protocol_fees_0: "999999" }, [])).toMatchObject({ complete: false, reason: "inconsistent" });
    expect(windowFigures(null, B, [])).toEqual({ complete: false, reason: "too-short" });
  });
});

describe("state", () => {
  const latest = { block_time: new Date(T0 * 1000).toISOString() };
  const cursor = { last_ok_at: "2026-10-24T10:05:00Z", last_error_at: null };
  it("ok inside two hours, behind after, and behind when the last run failed or the pool waits", () => {
    expect(stateOf({ cursor, latest, gaps: [], nowMs: T0 * 1000 + BEHIND_AFTER_MS })).toEqual({ state: "ok", reason: [] });
    expect(stateOf({ cursor, latest, gaps: [], nowMs: T0 * 1000 + BEHIND_AFTER_MS + 1 }).reason).toEqual(["late"]);
    expect(stateOf({ cursor: { ...cursor, last_error_at: "2026-10-24T10:06:00Z" }, latest, gaps: [], nowMs: T0 * 1000 }).reason).toEqual(["last-run-failed"]);
    expect(stateOf({ cursor, latest, gaps: [{ kind: "backlog-truncated", gap_key: "backlog-truncated:wait:9" }], nowMs: T0 * 1000 }).reason).toEqual(["waiting"]);
    expect(stateOf({ cursor: null, latest, gaps: [], nowMs: 0 }).state).toBe("unread");
  });
});

function makeReq(query) {
  return { method: "GET", query, headers: { origin: "https://tegridyfarms.vercel.app" } };
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

describe("the three resources over a counted pool", () => {
  let seeded;
  let H;
  const END = T0 + 26 * 3600;
  const call = async (handler, query, nowMs = (END + 1800) * 1000, fetchImpl = seeded.db.fetchImpl) => {
    const { res, out } = makeRes();
    await H[handler](makeReq(query), res, { nowMs, fetchImpl });
    return out;
  };
  beforeEach(async () => {
    Object.assign(process.env, ENV);
    vi.spyOn(console, "error").mockImplementation(() => {});
    H = await import("../rangeStats.js");
    seeded = await seededPool();
  });
  afterEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    vi.restoreAllMocks();
  });

  it("range-stats answers ok with counted_to, and each window is the count's own", async () => {
    const out = await call("handleRangeStats", { resource: "range-stats", pool: POOL });
    expect(out.status).toBe(200);
    expect(out.headers["Cache-Control"]).toMatch(/s-maxage=300/);
    const b = out.body;
    expect(b).toMatchObject({ state: "ok", pool: POOL, counted_to: new Date(END * 1000).toISOString(), counted_to_slot: 9000 });
    // The day after the first count: two swaps of 40,000 and 60,000, the program's split on each.
    expect(b.windows["24h"]).toMatchObject({ complete: true, since_open: false, swaps: 2, fees_0: "100000", vault_0: "10400", workshop_0: "5600", to_positions_0: "84000", no_range_0: "0" });
    // Since the pool opened: five swaps, one a fill with no range in use (21,000 to the vault).
    for (const name of ["7d", "30d", "all"]) {
      expect(b.windows[name]).toMatchObject({ complete: true, since_open: true, swaps: 5, fees_0: String(seeded.fees), vault_0: String(seeded.vault), workshop_0: String(seeded.workshop), no_range_0: String(seeded.noRange) });
      expect(BigInt(b.windows[name].to_positions_0)).toBe(seeded.fees - seeded.vault - seeded.workshop);
    }
    expect(b.windows["7d"].low_sqrt_price_x64 < b.windows["7d"].high_sqrt_price_x64).toBe(true);
    expect(b.windows["24h"].largest.by_fee_0.map((s) => s.fee_0)).toEqual(["60000", "40000"]);
    expect(b.collections).toEqual([expect.objectContaining({ by_whom: "vault", amount_0: "5000", amount_1: "0" })]);
    expect(b.venue_waiting).toMatchObject({ vault_0: String(seeded.vault - seeded.collected), workshop_0: String(seeded.workshop) });
    // Every closed hour from the opening hour to the last one counted, each one whole.
    expect(b.hours).toHaveLength(26);
    expect(b.hours.every((h) => h.complete)).toBe(true);
    expect(b.hours.filter((h) => h.swaps).map((h) => h.swaps)).toEqual([2, 1, 2]);
    expect(b.gaps).toEqual([]);
  });

  it("is behind after two hours, with the time it was counted to", async () => {
    const out = await call("handleRangeStats", { resource: "range-stats", pool: POOL }, (END + 7201) * 1000);
    expect(out.body).toMatchObject({ state: "behind", behind: ["late"], counted_to: new Date(END * 1000).toISOString() });
    expect(out.body.windows["24h"].complete).toBe(true);
  });

  it("a hole inside a window gives that window no number, and leaves the others", async () => {
    seeded.db.data.range_gap.push({ id: 99, pool: POOL, gap_key: "log-truncated:x", kind: "log-truncated", standing: false, signature: "x", from_slot: 8200, to_slot: 8200, from_time: null, to_time: null, detail: "cut", resolved_at: null });
    const b = (await call("handleRangeStats", { resource: "range-stats", pool: POOL })).body;
    for (const name of ["24h", "7d", "all"]) {
      expect(b.windows[name]).toMatchObject({ complete: false, reason: "gap" });
      expect(Object.keys(b.windows[name]).filter((k) => NUMBERS.test(k))).toEqual([]);
    }
    expect(b.gaps).toHaveLength(1);
  });

  it("a pool with more gaps than one read returns gives no number, rather than miss one", async () => {
    for (let i = 0; i < 200; i++) {
      seeded.db.data.range_gap.push({ id: 1000 + i, pool: POOL, gap_key: `tier-changed:${i}`, kind: "tier-changed", standing: true, signature: null, from_slot: 8001, to_slot: 9000, from_time: null, to_time: null, detail: "rates", resolved_at: null });
    }
    const b = (await call("handleRangeStats", { resource: "range-stats", pool: POOL })).body;
    expect(b.windows["24h"]).toMatchObject({ complete: false, reason: "gap" });
    expect(b.gaps_listed_all).toBe(false);
  });

  it("unread, never a number: an unknown pool, a bad address, a failed read, no keys", async () => {
    expect((await call("handleRangeStats", { resource: "range-stats", pool: key(42) })).body).toEqual({ state: "unread", pool: key(42), reason: "not-counted" });
    expect((await call("handleRangeStats", { resource: "range-stats", pool: "pool=eq.x" })).status).toBe(400);
    const down = async () => new Response("boom", { status: 500 });
    const failed = await call("handleRangeStats", { resource: "range-stats", pool: POOL }, undefined, down);
    expect([failed.status, failed.body, failed.headers["Cache-Control"]]).toEqual([502, { state: "unread", pool: POOL }, "s-maxage=30"]);
    delete process.env.SUPABASE_SERVICE_KEY;
    expect((await call("handleRangeStats", { resource: "range-stats", pool: POOL })).status).toBe(503);
  });

  it("before migration 030 every resource is unread", async () => {
    const missing = async () => new Response(JSON.stringify({ code: "PGRST205" }), { status: 404 });
    for (const [h, q] of [["handleRangeStats", { pool: POOL }], ["handleRangePools", {}], ["handleRangeSwaps", { pool: POOL }]]) {
      expect((await call(h, q, undefined, missing)).body.state).toBe("unread");
    }
  });

  it("holds no wallet: the swap's sender is in no answer", async () => {
    const sender = key(50);
    for (const [h, q] of [["handleRangeStats", { pool: POOL }], ["handleRangePools", {}], ["handleRangeSwaps", { pool: POOL }]]) {
      const body = JSON.stringify((await call(h, q)).body);
      expect(body).not.toContain(sender);
      expect(body).not.toMatch(/wallet_count|person_id|sender/);
    }
  });

  it("range-pools lists the pool and says whether the list was whole", async () => {
    const b = (await call("handleRangePools", { resource: "range-pools" })).body;
    expect(b).toMatchObject({ state: "ok", list_complete: true, pools: [expect.objectContaining({ address: POOL, registry: false, opened_slot: 100 })] });
    seeded.db.data.range_run.push({ id: 50, finished_at: new Date((END + 120) * 1000).toISOString(), ok: false, list_read: false });
    expect((await call("handleRangePools", { resource: "range-pools" })).body).toMatchObject({ state: "behind", list_complete: false });
  });

  it("range-swaps pages newest first and never splits a slot", async () => {
    const all = (await call("handleRangeSwaps", { resource: "range-swaps", pool: POOL })).body;
    expect(all).toMatchObject({ state: "ok", counted_through_slot: 9000, next_before: null, gaps: [] });
    expect(all.swaps.map((s) => s.slot)).toEqual([8500, 8000, 250, 200, 150]);
    expect(all.swaps[0]).toMatchObject({ fee_0: "60000", zero_for_one: true });
    const page = (await call("handleRangeSwaps", { resource: "range-swaps", pool: POOL, limit: "2" })).body;
    expect(page.swaps.map((s) => s.slot)).toEqual([8500]);
    expect(page.next_before).toBe(8500);
    const rest = (await call("handleRangeSwaps", { resource: "range-swaps", pool: POOL, before: "8500", limit: "500" })).body;
    expect(rest.swaps.map((s) => s.slot)).toEqual([8000, 250, 200, 150]);
    expect((await call("handleRangeSwaps", { resource: "range-swaps", pool: POOL, limit: "501" })).status).toBe(400);
  });

  it("range-swaps serves a slot whole when it holds more swaps than a page", async () => {
    const at200 = seeded.db.data.range_swap.find((s) => s.slot === 200);
    seeded.db.data.range_swap.push({ ...at200, event_index: 1, fee_0: "1" });
    const id = (s) => `${s.slot}/${s.event_index}`;
    const all = (await call("handleRangeSwaps", { resource: "range-swaps", pool: POOL })).body.swaps.map(id);
    expect(all).toEqual(["8500/0", "8000/0", "250/0", "200/1", "200/0", "150/0"]);
    const paged = [];
    let before = null;
    for (let i = 0; i < 10; i++) {
      const b = (await call("handleRangeSwaps", { resource: "range-swaps", pool: POOL, limit: "1", ...(before ? { before: String(before) } : {}) })).body;
      paged.push(...b.swaps.map(id));
      if (b.next_before === null) break;
      before = b.next_before;
    }
    expect(paged).toEqual(all);
  });

  it("an hour a hole touches has no number; the hours beside it keep theirs", async () => {
    // Three swaps in the 10:00 hour, the middle one's log cut; one at 11:30. Counted at 12:01.
    const w = world({ slot: 400, time: T0 + 2 * 3600 + 60 });
    const db = fakeDb();
    const price = (i) => (1n << 64n) + BigInt(i);
    let fees = 0n;
    const swap = (txSlot, t, fee, i, cutLog = false) => {
      fees += fee;
      const lines = ix(RANGE_PROGRAM_ID, "SwapV2", [swapData({ fee0: fee, price: price(i) })]);
      w.tx({ lines: cutLog ? [...lines, "Log truncated"] : lines, txSlot, at: T0 + t });
    };
    w.tx({ lines: ix(RANGE_PROGRAM_ID, "CreatePool", [createdData({ price: price(0) })]), txSlot: 100, at: T0 });
    swap(150, 600, 10_000n, 1);
    swap(200, 1200, 90_000n, 2, true);
    swap(250, 1800, 20_000n, 3);
    swap(300, 5400, 5_000n, 4);
    const { vault, workshop } = split(fees);
    w.pool(POOL, { price: price(4), protocolFees0: vault, fundFees0: workshop });
    expect(await run(w, db)).toBe(0);
    const at = (T0 + 2 * 3600 + 120) * 1000;
    const iso = (s) => new Date(s * 1000).toISOString();
    const hours = async () => (await call("handleRangeStats", { resource: "range-stats", pool: POOL }, at, db.fetchImpl)).body.hours;
    expect(await hours()).toEqual([
      { hour: iso(T0), complete: false },
      { hour: iso(T0 + 3600), complete: true, swaps: 1, volume_0: "1000000", volume_1: "2000000", fees_0: "5000", fees_1: "0", open_price: String(price(4)), high_price: String(price(4)), low_price: String(price(4)), close_price: String(price(4)) },
    ]);
    // A hole known only by its slots could sit in either hour, so neither has a number.
    db.data.range_gap.push({ id: 7, pool: POOL, gap_key: "backlog-truncated:skip:260", kind: "backlog-truncated", standing: false, signature: null, from_slot: 260, to_slot: 290, from_time: null, to_time: null, detail: "skipped", resolved_at: null });
    expect((await hours()).map((h) => h.complete)).toEqual([false, false]);
  });

  it("each branch sits above `const provider` in the catchall", () => {
    const src = readFileSync(join(HERE, "..", "..", "aggregator.js"), "utf8");
    for (const r of ["range-stats", "range-pools", "range-swaps"]) {
      const at = src.indexOf(`req.query.resource === "${r}"`);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(src.indexOf("const provider = req.query.provider"));
    }
  });
});
