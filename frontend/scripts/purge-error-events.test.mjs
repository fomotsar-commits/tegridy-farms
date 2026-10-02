// purge-error-events.mjs: what .github/workflows/error-retention.yml runs every hour.
//
// The job's exit code is the only alarm it has (GitHub mails the owner about a failed
// scheduled run), so the rule is the repo's usual one: a run that did not delete what it
// should have is red, never green. The one green "nothing deleted" that is not a delete is
// the table not existing yet, before migration 026, when nothing can be stored.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { main } from "./purge-error-events.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.UTC(2026, 10, 20, 12);
const env = { SUPABASE_URL: "https://test.supabase.co", SUPABASE_SERVICE_KEY: "service-role" };

function run({ env: e = env, reply } = {}) {
  const out = [];
  const err = [];
  const fetchImpl = vi.fn(reply ?? (async () => new Response(null, { status: 204, headers: { "Content-Range": "*/4" } })));
  return main({ env: e, fetchImpl, nowMs: NOW, log: (s) => out.push(s), error: (s) => err.push(s) })
    .then((code) => ({ code, out: out.join("\n"), err: err.join("\n"), fetchImpl }));
}

describe("purge-error-events.mjs", () => {
  it("deletes and says how many, exit 0", async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("Deleted 4");
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails loudly, naming the missing secrets, and sends nothing", async () => {
    const r = await run({ env: { SUPABASE_URL: env.SUPABASE_URL } });
    expect(r.code).toBe(1);
    expect(r.err).toContain("::error");
    expect(r.err).toContain("SUPABASE_SERVICE_KEY");
    expect(r.err).not.toContain("SUPABASE_URL,");
    expect(r.fetchImpl).not.toHaveBeenCalled();
    const both = await run({ env: {} });
    expect(both.err).toContain("SUPABASE_URL");
    expect(both.err).toContain("SUPABASE_SERVICE_KEY");
  });

  it("a refused key or a server error is red", async () => {
    for (const status of [401, 403, 500, 503]) {
      const r = await run({ reply: async () => new Response("{}", { status }) });
      expect(r.code, String(status)).toBe(1);
      expect(r.err).toContain("::error");
    }
  });

  it("a network failure is red", async () => {
    const r = await run({ reply: async () => { throw new TypeError("fetch failed"); } });
    expect(r.code).toBe(1);
  });

  it("before migration 026 the table does not exist: green, with a notice saying so", async () => {
    const r = await run({
      reply: async () => new Response(JSON.stringify({ code: "PGRST205", message: "Could not find the table" }), { status: 404 }),
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("::notice");
    expect(r.out).toContain("026");
  });

  it("never prints the service key", async () => {
    const outcomes = [
      await run(),
      await run({ reply: async () => new Response("{}", { status: 401 }) }),
      await run({ reply: async () => { throw new Error(`boom ${env.SUPABASE_SERVICE_KEY}`); } }),
    ];
    for (const r of outcomes) expect(`${r.out}\n${r.err}`).not.toContain(env.SUPABASE_SERVICE_KEY);
  });

  it("imports nothing from node_modules, so the workflow runs it with no install", () => {
    const files = [
      join(HERE, "purge-error-events.mjs"),
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
    expect(wf).toContain("node frontend/scripts/purge-error-events.mjs");
    const secrets = [...wf.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect([...new Set(secrets)].sort()).toEqual(["SUPABASE_SERVICE_KEY", "SUPABASE_URL"]);
    expect(wf).not.toMatch(/npm (ci|install)/);
  });

  it("can only read the repository", () => {
    expect(wf).toMatch(/permissions:\s*\n\s*contents: read\s*\n/);
    expect(wf).toContain("persist-credentials: false");
  });
});
