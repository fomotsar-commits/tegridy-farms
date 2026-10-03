// The owner's decision of 2026-10-03 about analytics events, and the code that keeps it.
//
//   KEPT 90 DAYS, THEN DELETED AUTOMATICALLY. analytics_events (migration 013, written by
//   api/analytics.js) had no delete at all: every event was kept forever, and the Privacy
//   page said nothing about how long. Now the hourly retention job
//   (.github/workflows/error-retention.yml, scripts/purge-expired-events.mjs) and a backstop
//   inside api/analytics.js both call purgeExpiredAnalyticsEvents, the same delete the error
//   reports use, measured from ANALYTICS_RETENTION_DAYS, the one constant the Privacy page's
//   test reads too.
//
// No test here reads the real clock: every instant is written out.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ANALYTICS_RETENTION_DAYS,
  ERROR_RETENTION_DAYS,
  analyticsRetentionCutoff,
  errorRetentionCutoff,
} from "../_lib/errorPolicy.js";
import {
  ANALYTICS_EVENTS_TABLE,
  ERROR_EVENTS_TABLE,
  purgeExpiredAnalyticsEvents,
  purgeExpiredErrorEvents,
} from "../_lib/errorPurge.js";

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => readFileSync(join(FRONTEND, ...p), "utf8");
const DAY = 24 * 60 * 60 * 1000;
const SUPABASE_URL = "https://test.supabase.co";
const KEY = "service-role";
const NOW = Date.UTC(2027, 0, 20, 12);

/**
 * A stand-in for PostgREST holding one table, applying the one filter the purge sends,
 * `received_at=lt.<iso>`, the way PostgREST does: strictly less than. It refuses a key it
 * was not given (401), a role with no DELETE on the table (403, 42501: analytics_events
 * before migration 027), a table that does not exist (404, PGRST205: before 013), a
 * DELETE with no filter (Supabase's safeupdate would too), and any other table or method.
 */
function fakePostgrest(rows, { key = KEY, table = ANALYTICS_EVENTS_TABLE, exists = true, canDelete = true } = {}) {
  const requests = [];
  const fetchImpl = vi.fn(async (url, init = {}) => {
    requests.push({ url, init });
    const u = new URL(url);
    const h = init.headers || {};
    if (h.apikey !== key || h.Authorization !== `Bearer ${key}`) {
      return new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401 });
    }
    if (u.pathname !== `/rest/v1/${table}` || init.method !== "DELETE") {
      return new Response("{}", { status: 405 });
    }
    if (!exists) {
      return new Response(JSON.stringify({ code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` }), { status: 404 });
    }
    if (!canDelete) {
      return new Response(JSON.stringify({ code: "42501", message: `permission denied for table ${table}` }), { status: 403 });
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

const purge = (fetchImpl, over = {}) =>
  purgeExpiredAnalyticsEvents({ supabaseUrl: SUPABASE_URL, serviceKey: KEY, nowMs: NOW, fetchImpl, ...over });

describe("the analytics retention window", () => {
  it("is 90 days, written once, next to the 30 days for error reports", () => {
    expect(ANALYTICS_RETENTION_DAYS).toBe(90);
    expect(ERROR_RETENTION_DAYS).toBe(30);
    const policy = read("api", "_lib", "errorPolicy.js");
    const days = policy.indexOf("export const ANALYTICS_RETENTION_DAYS = 90;");
    expect(days).toBeGreaterThan(-1);
    // Next to it: the two retention constants are one glance apart, not two files apart.
    const errorDays = policy.indexOf("export const ERROR_RETENTION_DAYS = 30;");
    expect(errorDays).toBeGreaterThan(-1);
    expect(policy.slice(Math.min(days, errorDays), Math.max(days, errorDays)).split("\n").length).toBeLessThan(6);
  });

  it("cuts off exactly 90 days before now, and the error cutoff stays at 30", () => {
    expect(analyticsRetentionCutoff(NOW)).toBe(new Date(NOW - 90 * DAY).toISOString());
    expect(errorRetentionCutoff(NOW)).toBe(new Date(NOW - 30 * DAY).toISOString());
  });
});

describe("purgeExpiredAnalyticsEvents: older than 90 days goes, newer stays", () => {
  const at = (msAgo, id) => ({ id, received_at: new Date(NOW - msAgo).toISOString() });
  const table = () => [
    at(400 * DAY, "400 days"),
    at(91 * DAY, "91 days"),
    at(90 * DAY + 1, "90 days and 1 ms"),
    at(90 * DAY, "exactly 90 days"),
    at(90 * DAY - 1, "1 ms short of 90 days"),
    at(89 * DAY, "89 days"),
    at(31 * DAY, "31 days"),
    at(60 * 60 * 1000, "an hour"),
  ];

  it("deletes every event received more than 90 days ago and keeps the rest", async () => {
    const rows = table();
    const { fetchImpl } = fakePostgrest(rows);
    const r = await purge(fetchImpl);
    expect(r).toMatchObject({ ok: true, deleted: 3, cutoff: analyticsRetentionCutoff(NOW) });
    expect(rows.map((x) => x.id)).toEqual(["exactly 90 days", "1 ms short of 90 days", "89 days", "31 days", "an hour"]);
  });

  it("keeps an event of exactly 90 days, and deletes it one millisecond later", async () => {
    const rows = [at(90 * DAY, "the boundary")];
    const { fetchImpl } = fakePostgrest(rows);
    expect(await purge(fetchImpl)).toMatchObject({ ok: true, deleted: 0 });
    expect(rows).toHaveLength(1);
    expect(await purge(fetchImpl, { nowMs: NOW + 1 })).toMatchObject({ ok: true, deleted: 1 });
    expect(rows).toHaveLength(0);
  });

  it("is idempotent: a second run deletes nothing and keeps the same rows", async () => {
    const rows = table();
    const { fetchImpl } = fakePostgrest(rows);
    await purge(fetchImpl);
    const kept = rows.map((x) => x.id);
    expect(await purge(fetchImpl)).toMatchObject({ ok: true, deleted: 0 });
    expect(rows.map((x) => x.id)).toEqual(kept);
  });

  it("deletes from analytics_events only, filtered on received_at, which the database sets", async () => {
    const { fetchImpl, requests } = fakePostgrest([]);
    await purge(fetchImpl);
    expect(requests).toHaveLength(1);
    const u = new URL(requests[0].url);
    expect(u.origin).toBe(SUPABASE_URL);
    expect(u.pathname).toBe("/rest/v1/analytics_events");
    expect([...u.searchParams.keys()]).toEqual(["received_at"]);
    expect(u.searchParams.get("received_at")).toBe(`lt.${analyticsRetentionCutoff(NOW)}`);
    expect(requests[0].init.method).toBe("DELETE");
    expect(requests[0].init.headers).toMatchObject({ apikey: KEY, Authorization: `Bearer ${KEY}` });
  });

  it("and the error purge still deletes from error_events only, at 30 days", async () => {
    expect([ANALYTICS_EVENTS_TABLE, ERROR_EVENTS_TABLE]).toEqual(["analytics_events", "error_events"]);
    const { fetchImpl, requests } = fakePostgrest([], { table: ERROR_EVENTS_TABLE });
    await purgeExpiredErrorEvents({ supabaseUrl: SUPABASE_URL, serviceKey: KEY, nowMs: NOW, fetchImpl });
    const u = new URL(requests[0].url);
    expect(u.pathname).toBe("/rest/v1/error_events");
    expect(u.searchParams.get("received_at")).toBe(`lt.${errorRetentionCutoff(NOW)}`);
  });
});

describe("purgeExpiredAnalyticsEvents: refuses, and never throws", () => {
  const old = () => [{ id: "old", received_at: new Date(NOW - 200 * DAY).toISOString() }];

  it("a key the database refuses deletes nothing and reports failure", async () => {
    const rows = old();
    const { fetchImpl } = fakePostgrest(rows, { key: "the-real-key" });
    const r = await purgeExpiredAnalyticsEvents({ supabaseUrl: SUPABASE_URL, serviceKey: "anon-or-wrong", nowMs: NOW, fetchImpl });
    expect(r).toMatchObject({ ok: false, reason: "http-401" });
    expect(rows).toHaveLength(1);
  });

  it("a key with no DELETE on the table (before migration 027) deletes nothing and is a failure", async () => {
    const rows = old();
    const { fetchImpl } = fakePostgrest(rows, { canDelete: false });
    const r = await purge(fetchImpl);
    expect(r).toMatchObject({ ok: false, reason: "http-403", code: "42501" });
    expect(r.tableMissing).toBeUndefined();
    expect(rows).toHaveLength(1);
  });

  it("a table that does not exist (013 not applied) is nothing to delete, said so", async () => {
    const { fetchImpl } = fakePostgrest([], { exists: false });
    expect(await purge(fetchImpl)).toMatchObject({ ok: true, deleted: 0, tableMissing: true });
  });

  it("makes no request without the service key or the project URL, or over plain http", async () => {
    for (const cfg of [{ serviceKey: undefined }, { supabaseUrl: undefined }, { supabaseUrl: "http://test.supabase.co" }]) {
      const { fetchImpl } = fakePostgrest(old());
      const r = await purge(fetchImpl, cfg);
      expect(r.ok).toBe(false);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("a network failure is reported, not thrown", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(purge(fetchImpl)).resolves.toMatchObject({ ok: false, reason: "unreachable" });
  });
});

describe("migration 027 lets the purge delete analytics events, and nobody else", () => {
  const raw = read("supabase", "migrations", "027_analytics_events_retention.sql");
  const sql = raw.replace(/--.*$/gm, "");

  it("stops with a plain message if analytics_events does not exist, before changing anything", () => {
    const guard = sql.search(/to_regclass\('public\.analytics_events'\)\s+IS\s+NULL/i);
    expect(guard).toBeGreaterThan(-1);
    expect(sql.slice(guard)).toMatch(/RAISE\s+EXCEPTION\s+'[^']*013_analytics_events\.sql/i);
    expect(guard).toBeLessThan(sql.search(/\bGRANT\b/i));
    expect(guard).toBeLessThan(sql.search(/CREATE\s+INDEX/i));
  });

  it("grants DELETE on analytics_events to service_role, which both purges use", () => {
    expect(sql).toMatch(/GRANT\s+DELETE\s+ON\s+(public\.)?analytics_events\s+TO\s+service_role\s*;/i);
  });

  it("grants anon and authenticated nothing at all", () => {
    expect(sql).not.toMatch(/GRANT[^;]*TO[^;]*\b(anon|authenticated|public)\b/i);
  });

  it("indexes received_at, the column the purge filters on, idempotently", () => {
    expect(sql).toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+\w+\s+ON\s+(public\.)?analytics_events\s*\(\s*received_at\s*\)/i);
  });

  it("reloads PostgREST and writes its own ledger row, safe to run twice", () => {
    expect(sql).toMatch(/NOTIFY\s+pgrst,\s*'reload schema'\s*;/i);
    expect(sql).toMatch(
      /INSERT\s+INTO\s+public\.schema_migrations\s*\(filename,\s*note\)\s*VALUES\s*\(\s*'027_analytics_events_retention\.sql'[\s\S]*?ON\s+CONFLICT\s*\(filename\)\s*DO\s+NOTHING\s*;/i,
    );
    expect(sql).not.toMatch(/\bDROP\b|\bDELETE\s+FROM\b|\bTRUNCATE\b|\bALTER\s+TABLE\b/i);
  });

  it("013 still grants service_role no DELETE, which is why 027 exists", () => {
    const m013 = read("supabase", "migrations", "013_analytics_events.sql").replace(/--.*$/gm, "");
    expect(m013).toMatch(/GRANT\s+INSERT,\s*SELECT\s+ON\s+analytics_events\s+TO\s+service_role\s*;/i);
    expect(m013).toMatch(/received_at\s+timestamptz\s+NOT\s+NULL\s+DEFAULT\s+now\(\)/i);
  });
});

describe("no copy outlives the 90 days", () => {
  it("the weekly backup does not copy analytics_events", () => {
    // A backup kept past the 90 days would hold events the Privacy page says are deleted.
    const wf = readFileSync(join(FRONTEND, "..", ".github", "workflows", "supabase-backup.yml"), "utf8");
    const tables = /^\s*TABLES="([^"]+)"/m.exec(wf);
    expect(tables, "the TABLES line in supabase-backup.yml").not.toBeNull();
    expect(tables[1].split(/\s+/)).not.toContain("analytics_events");
    const optional = /^\s*OPTIONAL_TABLES="([^"]*)"/m.exec(wf);
    expect(optional, "the OPTIONAL_TABLES line in supabase-backup.yml").not.toBeNull();
    expect(optional[1].split(/\s+/)).not.toContain("analytics_events");
  });
});
