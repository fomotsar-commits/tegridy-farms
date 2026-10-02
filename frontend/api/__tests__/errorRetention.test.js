// The two owner decisions of 2026-10-02 about error reports, and the code that keeps them.
//
//   1. NOTHING BEFORE 2026-10-16T00:00:00Z. The Privacy page gives 14 days' notice (its own
//      section 9), so no report is sent or stored before that instant, even if
//      VITE_ERROR_ENDPOINT is set early. ONE constant, in api/_lib/errorPolicy.js, is read by
//      the browser (src/lib/errorReporting.ts) and the server (api/errors.js); a second copy
//      of the date anywhere is how the two sides drift apart.
//   2. KEPT 30 DAYS, THEN DELETED AUTOMATICALLY, even when no new report arrives. The
//      scheduled job (.github/workflows/error-retention.yml) and the backstop inside
//      api/errors.js both call purgeExpiredErrorEvents, so there is one delete, not two.
//
// No test here reads the real clock: every instant is written out.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ERROR_REPORTING_STARTS_AT,
  ERROR_REPORTING_STARTS_AT_MS,
  ERROR_RETENTION_DAYS,
  errorReportingOpen,
  errorRetentionCutoff,
} from "../_lib/errorPolicy.js";
import { purgeExpiredErrorEvents } from "../_lib/errorPurge.js";

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => readFileSync(join(FRONTEND, ...p), "utf8");
const DAY = 24 * 60 * 60 * 1000;
const SUPABASE_URL = "https://test.supabase.co";
const KEY = "service-role";

describe("the start date: one constant, both sides of it", () => {
  it("is 2026-10-16T00:00:00Z, the owner's date: 14 days after the notice of 2026-10-02", () => {
    expect(ERROR_REPORTING_STARTS_AT).toBe("2026-10-16T00:00:00Z");
    expect(ERROR_REPORTING_STARTS_AT_MS).toBe(Date.UTC(2026, 9, 16));
    expect(ERROR_REPORTING_STARTS_AT_MS - Date.UTC(2026, 9, 2)).toBe(14 * DAY);
  });

  it("is closed one millisecond before, and open from the instant itself", () => {
    expect(errorReportingOpen(ERROR_REPORTING_STARTS_AT_MS - 1)).toBe(false);
    expect(errorReportingOpen(Date.UTC(2026, 9, 2, 12))).toBe(false);
    expect(errorReportingOpen(ERROR_REPORTING_STARTS_AT_MS)).toBe(true);
    expect(errorReportingOpen(Date.UTC(2027, 0, 1))).toBe(true);
  });

  it("is closed for a clock it cannot read (fail closed)", () => {
    for (const bad of [NaN, undefined, null, "2027-01-01", Infinity]) {
      expect(errorReportingOpen(bad)).toBe(false);
    }
  });

  it("is written once: the browser and the server import it, and neither spells the date", () => {
    // A copy of the literal in either file would let the two sides open on different days.
    const client = read("src", "lib", "errorReporting.ts");
    const server = read("api", "errors.js");
    for (const [name, src] of [["errorReporting.ts", client], ["errors.js", server]]) {
      expect(src, name).toMatch(/from ['"][./]*(?:api\/)?_lib\/errorPolicy\.js['"]/);
      expect(src, name).not.toContain("2026-10-16");
      expect(src, name).not.toMatch(/Date\.UTC\(2026,\s*9,\s*16/);
    }
  });
});

describe("the retention window", () => {
  it("is 30 days", () => {
    expect(ERROR_RETENTION_DAYS).toBe(30);
  });

  it("cuts off exactly 30 days before now", () => {
    const now = Date.UTC(2026, 10, 20, 6, 30);
    expect(errorRetentionCutoff(now)).toBe(new Date(now - 30 * DAY).toISOString());
  });
});

/**
 * A stand-in for PostgREST that holds rows and applies the one filter the purge sends,
 * `received_at=lt.<iso>`, the way PostgREST does: strictly less than. It refuses a key it
 * was not given, a DELETE with no filter (Supabase's safeupdate would too), and anything
 * that is not a DELETE on error_events.
 */
function fakePostgrest(rows, { key = KEY, table = true } = {}) {
  const requests = [];
  const fetchImpl = vi.fn(async (url, init = {}) => {
    requests.push({ url, init });
    const u = new URL(url);
    const h = init.headers || {};
    if (h.apikey !== key || h.Authorization !== `Bearer ${key}`) {
      return new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401 });
    }
    if (!table) {
      return new Response(JSON.stringify({ code: "PGRST205", message: "Could not find the table 'public.error_events' in the schema cache" }), { status: 404 });
    }
    if (init.method !== "DELETE" || u.pathname !== "/rest/v1/error_events") {
      return new Response("{}", { status: 405 });
    }
    const filter = u.searchParams.get("received_at");
    if (!filter || !filter.startsWith("lt.")) {
      return new Response(JSON.stringify({ code: "21000", message: "DELETE requires a WHERE clause" }), { status: 400 });
    }
    const cutoff = Date.parse(filter.slice(3));
    const before = rows.length;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (Date.parse(rows[i].received_at) < cutoff) rows.splice(i, 1);
    }
    return new Response(null, { status: 204, headers: { "Content-Range": `*/${before - rows.length}` } });
  });
  return { fetchImpl, requests };
}

describe("purgeExpiredErrorEvents: older than 30 days goes, newer stays", () => {
  const NOW = Date.UTC(2026, 10, 20, 12);
  const at = (msAgo, id) => ({ id, received_at: new Date(NOW - msAgo).toISOString() });
  const table = () => [
    at(45 * DAY, "45 days"),
    at(31 * DAY, "31 days"),
    at(30 * DAY + 1, "30 days and 1 ms"),
    at(30 * DAY, "exactly 30 days"),
    at(30 * DAY - 1, "1 ms short of 30 days"),
    at(29 * DAY, "29 days"),
    at(60 * 60 * 1000, "an hour"),
  ];

  it("deletes every row received more than 30 days ago and keeps the rest", async () => {
    const rows = table();
    const { fetchImpl } = fakePostgrest(rows);
    const r = await purgeExpiredErrorEvents({ supabaseUrl: SUPABASE_URL, serviceKey: KEY, nowMs: NOW, fetchImpl });
    expect(r).toMatchObject({ ok: true, deleted: 3 });
    expect(rows.map((x) => x.id)).toEqual(["exactly 30 days", "1 ms short of 30 days", "29 days", "an hour"]);
  });

  it("is idempotent: a second run deletes nothing and keeps the same rows", async () => {
    const rows = table();
    const { fetchImpl } = fakePostgrest(rows);
    await purgeExpiredErrorEvents({ supabaseUrl: SUPABASE_URL, serviceKey: KEY, nowMs: NOW, fetchImpl });
    const kept = rows.map((x) => x.id);
    const again = await purgeExpiredErrorEvents({ supabaseUrl: SUPABASE_URL, serviceKey: KEY, nowMs: NOW, fetchImpl });
    expect(again).toMatchObject({ ok: true, deleted: 0 });
    expect(rows.map((x) => x.id)).toEqual(kept);
  });

  it("measures from received_at, which the database sets, not from the client's occurred_at", async () => {
    const { fetchImpl, requests } = fakePostgrest([]);
    await purgeExpiredErrorEvents({ supabaseUrl: SUPABASE_URL, serviceKey: KEY, nowMs: NOW, fetchImpl });
    const u = new URL(requests[0].url);
    expect([...u.searchParams.keys()]).toEqual(["received_at"]);
    expect(u.searchParams.get("received_at")).toBe(`lt.${errorRetentionCutoff(NOW)}`);
  });

  it("sends the service key only to the configured project, as PostgREST expects it", async () => {
    const { fetchImpl, requests } = fakePostgrest([]);
    await purgeExpiredErrorEvents({ supabaseUrl: SUPABASE_URL, serviceKey: KEY, nowMs: NOW, fetchImpl });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).origin).toBe(SUPABASE_URL);
    expect(requests[0].init.method).toBe("DELETE");
    expect(requests[0].init.headers).toMatchObject({ apikey: KEY, Authorization: `Bearer ${KEY}` });
  });
});

describe("purgeExpiredErrorEvents: refuses, and never throws", () => {
  const NOW = Date.UTC(2026, 10, 20, 12);

  it("makes no request at all without the service key or the project URL", async () => {
    for (const cfg of [{ supabaseUrl: SUPABASE_URL }, { serviceKey: KEY }, {}]) {
      const { fetchImpl } = fakePostgrest([]);
      const r = await purgeExpiredErrorEvents({ ...cfg, nowMs: NOW, fetchImpl });
      expect(r).toMatchObject({ ok: false, reason: "not-configured" });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("will not send the key over plain http or to a URL it cannot parse", async () => {
    for (const supabaseUrl of ["http://test.supabase.co", "not a url", "javascript:alert(1)"]) {
      const { fetchImpl } = fakePostgrest([]);
      const r = await purgeExpiredErrorEvents({ supabaseUrl, serviceKey: KEY, nowMs: NOW, fetchImpl });
      expect(r.ok).toBe(false);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("a key the database refuses deletes nothing and reports failure", async () => {
    const rows = [{ id: "old", received_at: new Date(NOW - 40 * DAY).toISOString() }];
    const { fetchImpl } = fakePostgrest(rows, { key: "the-real-key" });
    const r = await purgeExpiredErrorEvents({ supabaseUrl: SUPABASE_URL, serviceKey: "anon-or-wrong", nowMs: NOW, fetchImpl });
    expect(r).toMatchObject({ ok: false, reason: "http-401" });
    expect(rows).toHaveLength(1);
  });

  it("a table that does not exist yet (026 not applied) is nothing to delete, said so", async () => {
    const { fetchImpl } = fakePostgrest([], { table: false });
    const r = await purgeExpiredErrorEvents({ supabaseUrl: SUPABASE_URL, serviceKey: KEY, nowMs: NOW, fetchImpl });
    expect(r).toMatchObject({ ok: true, deleted: 0, tableMissing: true });
  });

  it("any other 404 is a failure, not a missing table", async () => {
    const fetchImpl = vi.fn(async () => new Response("Not Found", { status: 404 }));
    const r = await purgeExpiredErrorEvents({ supabaseUrl: SUPABASE_URL, serviceKey: KEY, nowMs: NOW, fetchImpl });
    expect(r).toMatchObject({ ok: false, reason: "http-404" });
  });

  it("a network failure is reported, not thrown", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(purgeExpiredErrorEvents({ supabaseUrl: SUPABASE_URL, serviceKey: KEY, nowMs: NOW, fetchImpl }))
      .resolves.toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("a success without a row count is still a success, with the count unknown", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const r = await purgeExpiredErrorEvents({ supabaseUrl: SUPABASE_URL, serviceKey: KEY, nowMs: NOW, fetchImpl });
    expect(r).toMatchObject({ ok: true, deleted: null });
  });
});

describe("migration 026 lets the purge delete, and nobody else", () => {
  const sql = read("supabase", "migrations", "026_error_events.sql").replace(/--.*$/gm, "");

  it("grants DELETE to service_role, which both purges use", () => {
    expect(sql).toMatch(/GRANT\s+INSERT,\s*SELECT,\s*DELETE\s+ON\s+error_events\s+TO\s+service_role\s*;/i);
  });

  it("grants anon and authenticated nothing at all", () => {
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+error_events\s+FROM\s+anon,\s*authenticated\s*;/i);
    expect(sql).not.toMatch(/GRANT[^;]*ON\s+error_events[^;]*TO[^;]*\b(anon|authenticated)\b/i);
  });

  it("indexes received_at, the column the purge filters on", () => {
    expect(sql).toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+\w+\s+ON\s+error_events\s*\(\s*received_at\s*\)/i);
  });
});

describe("no copy outlives the 30 days", () => {
  it("the weekly backup does not copy error_events", () => {
    // A backup kept longer than 30 days would hold reports the page says are deleted.
    const wf = readFileSync(join(FRONTEND, "..", ".github", "workflows", "supabase-backup.yml"), "utf8");
    const tables = /^\s*TABLES="([^"]+)"/m.exec(wf);
    expect(tables, "the TABLES line in supabase-backup.yml").not.toBeNull();
    expect(tables[1].split(/\s+/)).not.toContain("error_events");
  });
});
