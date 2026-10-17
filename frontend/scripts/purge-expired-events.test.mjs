// purge-expired-events.mjs: what .github/workflows/error-retention.yml runs every hour.
// It deletes error reports older than 30 days and analytics events older than 90.
//
// The job's exit code is the only alarm it has (GitHub mails the owner about a failed
// scheduled run), so the rule is the repo's usual one: a run that did not delete what it
// should have is red, never green. The one green "nothing deleted" that is not a delete is
// a table not existing yet (error_events before migration 026, analytics_events before
// 013), when nothing can be stored in it. Each table is purged on its own, so one table
// failing never stops the other from being purged.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { main } from "./purge-expired-events.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.UTC(2026, 10, 20, 12);
const env = { SUPABASE_URL: "https://test.supabase.co", SUPABASE_SERVICE_KEY: "service-role" };

const deleted = (n) => async () => new Response(null, { status: 204, headers: { "Content-Range": `*/${n}` } });
const missing = (table) => async () =>
  new Response(JSON.stringify({ code: "PGRST205", message: `Could not find the table 'public.${table}'` }), { status: 404 });

/** Replies per table: { error_events, analytics_events }. Each is () => Response, or throws. */
function run({ env: e = env, error_events = deleted(4), analytics_events = deleted(7) } = {}) {
  const out = [];
  const err = [];
  const replies = { error_events, analytics_events };
  const fetchImpl = vi.fn(async (url) => {
    const table = new URL(url).pathname.replace("/rest/v1/", "");
    if (!replies[table]) throw new Error(`unexpected table ${table}`);
    return replies[table]();
  });
  return main({ env: e, fetchImpl, nowMs: NOW, log: (s) => out.push(s), error: (s) => err.push(s) })
    .then((code) => ({
      code,
      out: out.join("\n"),
      err: err.join("\n"),
      fetchImpl,
      tables: fetchImpl.mock.calls.map(([url]) => new URL(url).pathname),
    }));
}

describe("purge-expired-events.mjs", () => {
  it("deletes from both tables and says how many from each, exit 0", async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.tables).toEqual(["/rest/v1/error_events", "/rest/v1/analytics_events"]);
    expect(r.out).toContain("Deleted 4 error report(s)");
    expect(r.out).toContain("(older than 30 days)");
    expect(r.out).toContain("Deleted 7 analytics event(s)");
    expect(r.out).toContain("(older than 90 days)");
    expect(r.err).toBe("");
  });

  it("fails loudly, naming the missing secrets, and sends nothing", async () => {
    const r = await run({ env: { SUPABASE_URL: env.SUPABASE_URL } });
    expect(r.code).toBe(1);
    expect(r.err).toContain("::error");
    expect(r.err).toContain("SUPABASE_SERVICE_KEY");
    expect(r.err).not.toContain("SUPABASE_URL,");
    expect(r.err).toContain("30 days");
    expect(r.err).toContain("90 days");
    expect(r.fetchImpl).not.toHaveBeenCalled();
    const both = await run({ env: {} });
    expect(both.err).toContain("SUPABASE_URL");
    expect(both.err).toContain("SUPABASE_SERVICE_KEY");
  });

  it("a refused key or a server error on either table is red", async () => {
    for (const status of [401, 403, 500, 503]) {
      const reply = async () => new Response("{}", { status });
      for (const which of [{ error_events: reply }, { analytics_events: reply }, { error_events: reply, analytics_events: reply }]) {
        const r = await run(which);
        expect(r.code, `${status} ${Object.keys(which)}`).toBe(1);
        expect(r.err).toContain("::error");
      }
    }
  });

  it("one table failing never stops the other from being purged", async () => {
    const down = async () => new Response("{}", { status: 500 });
    const first = await run({ error_events: down });
    expect(first.code).toBe(1);
    expect(first.tables).toEqual(["/rest/v1/error_events", "/rest/v1/analytics_events"]);
    expect(first.out).toContain("Deleted 7 analytics event(s)");
    expect(first.err).toContain("Error reports older than 30 days may still be stored");
    expect(first.err).not.toContain("Analytics events older than");

    const second = await run({ analytics_events: down });
    expect(second.code).toBe(1);
    expect(second.out).toContain("Deleted 4 error report(s)");
    expect(second.err).toContain("Analytics events older than 90 days may still be stored");
    expect(second.err).not.toContain("Error reports older than");

    const thrown = await run({ error_events: async () => { throw new TypeError("fetch failed"); } });
    expect(thrown.code).toBe(1);
    expect(thrown.out).toContain("Deleted 7 analytics event(s)");
  });

  it("a network failure is red", async () => {
    const r = await run({ analytics_events: async () => { throw new TypeError("fetch failed"); } });
    expect(r.code).toBe(1);
    expect(r.err).toContain("unreachable");
  });

  it("before migration 026 error_events does not exist: green, with a notice saying so", async () => {
    const r = await run({ error_events: missing("error_events") });
    expect(r.code).toBe(0);
    expect(r.out).toContain("::notice");
    expect(r.out).toContain("026");
    expect(r.out).toContain("Deleted 7 analytics event(s)");
  });

  it("before migration 013 analytics_events does not exist: green, with a notice saying so", async () => {
    const r = await run({ analytics_events: missing("analytics_events") });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/::notice title=analytics_events does not exist yet::[^\n]*013/);
    expect(r.out).toContain("Deleted 4 error report(s)");
    expect(r.err).toBe("");
  });

  it("before migration 027 the key may not delete analytics events: red, naming 027, not blaming the key", async () => {
    const r = await run({
      analytics_events: async () =>
        new Response(JSON.stringify({ code: "42501", message: "permission denied for table analytics_events" }), { status: 403 }),
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("::error");
    expect(r.err).toContain("(42501)");
    expect(r.err).toMatch(/42501[^\n]*027_analytics_events_retention\.sql/);
    expect(r.out).toContain("Deleted 4 error report(s)");
  });

  it("a 404 that is not PGRST205 is red, not a missing table", async () => {
    const r = await run({ analytics_events: async () => new Response("Not Found", { status: 404 }) });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("::notice");
  });

  it("never prints the service key", async () => {
    const outcomes = [
      await run(),
      await run({ error_events: async () => new Response("{}", { status: 401 }), analytics_events: async () => new Response("{}", { status: 401 }) }),
      await run({ analytics_events: async () => { throw new Error(`boom ${env.SUPABASE_SERVICE_KEY}`); } }),
    ];
    for (const r of outcomes) expect(`${r.out}\n${r.err}`).not.toContain(env.SUPABASE_SERVICE_KEY);
  });

  it("imports nothing from node_modules, so the workflow runs it with no install", () => {
    const files = [
      join(HERE, "purge-expired-events.mjs"),
      join(HERE, "..", "api", "_lib", "errorPurge.js"),
      join(HERE, "..", "api", "_lib", "errorPolicy.js"),
    ];
    for (const f of files) {
      const specifiers = [...readFileSync(f, "utf8").matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
      expect(specifiers.filter((s) => !s.startsWith(".") && !s.startsWith("node:")), f).toEqual([]);
    }
  });
});

describe("error-retention.yml", () => {
  // Code lines only: the header explains, in words, what the steps must not do.
  const wf = readFileSync(join(HERE, "..", "..", ".github", "workflows", "error-retention.yml"), "utf8")
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  it("runs on a schedule at least hourly, and by hand", () => {
    expect(wf).toMatch(/schedule:\s*\n\s*- cron: "\d{1,2} \* \* \* \*"/);
    expect(wf).toContain("workflow_dispatch:");
  });

  it("runs this script with the two Supabase secrets the backup already uses, and nothing else", () => {
    expect(wf).toContain("node frontend/scripts/purge-expired-events.mjs");
    expect(wf).not.toContain("purge-error-events.mjs");
    const secrets = [...wf.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect([...new Set(secrets)].sort()).toEqual(["SUPABASE_SERVICE_KEY", "SUPABASE_URL"]);
    expect(wf).not.toMatch(/npm (ci|install)/);
  });

  it("can only read the repository", () => {
    expect(wf).toMatch(/permissions:\s*\n\s*contents: read\s*\n/);
    expect(wf).toContain("persist-credentials: false");
  });
});
