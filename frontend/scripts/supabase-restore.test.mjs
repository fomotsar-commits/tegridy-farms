// Proof for scripts/supabase-restore.mjs and for the migration hygiene the
// restore depends on.
//
// The restore itself cannot be unit-tested end to end — it needs a Supabase
// project and this repo applies no SQL. What CAN be pinned is the part that
// decides whether a restore is honest: the ordering, and the refusal to let
// "we never saw this table" look like "this table was empty".
//
// The second describe block is the enforcement half of the ledger fix in
// supabase/MIGRATIONS.md. Two independent slices numbered their migration 016
// on 2026-08-19; one was renumbered by hand. This is the check that makes the
// next one fail loudly instead of quietly overwriting a number.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  RESTORE_ORDER,
  NOT_IN_BUNDLE,
  CREATED_BY,
  MANUAL_SQL,
  parseArgs,
  selectTables,
  chunk,
  planBundle,
  diagnoseInsertError,
  summarize,
  isUsableRestore,
  formatSummary,
} from "./supabase-restore.mjs";

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(FRONTEND, "supabase", "migrations");
const WORKFLOW = join(FRONTEND, "..", ".github", "workflows", "supabase-backup.yml");

const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();

describe("restore ordering", () => {
  it("puts trade_offers before dm_messages — the one real foreign key", () => {
    // 007:82 — dm_messages.trade_id REFERENCES trade_offers(id). Reversing
    // these is a 23503 on every trade-card DM in the bundle.
    expect(RESTORE_ORDER.indexOf("trade_offers")).toBeLessThan(RESTORE_ORDER.indexOf("dm_messages"));
  });

  it("restores a subset in schema order, not in the order the operator typed it", () => {
    expect(selectTables(["dm_messages", "trade_offers"])).toEqual(["trade_offers", "dm_messages"]);
  });

  it("covers exactly the table set the backup workflow captures", () => {
    // Drift in either direction is a silent data-loss bug: a table the backup
    // captures and the restore ignores is dropped on the floor.
    const yml = readFileSync(WORKFLOW, "utf-8");
    const line = yml.split("\n").find((l) => l.trim().startsWith("TABLES="));
    expect(line, "supabase-backup.yml no longer declares TABLES= on one line").toBeTruthy();
    const captured = line.replace(/.*TABLES="/, "").replace(/".*/, "").trim().split(/\s+/);
    expect([...RESTORE_ORDER].sort()).toEqual([...captured].sort());
  });

  it("names a creating migration for every table it restores", () => {
    for (const t of RESTORE_ORDER) {
      expect(CREATED_BY[t], `${t} has no migration attributed to it`).toBeTruthy();
      expect(existsSync(join(MIGRATIONS, CREATED_BY[t])), `${CREATED_BY[t]} is missing`).toBe(true);
    }
  });

  it("does not claim to restore tables that no bundle contains", () => {
    for (const [table] of NOT_IN_BUNDLE) {
      expect(RESTORE_ORDER).not.toContain(table);
    }
  });
});

describe("planBundle keeps absent and empty apart", () => {
  const read = (map) => (t) => map[t] ?? { present: false };

  it("reports a missing file as absent, never as zero rows", () => {
    const [r] = planBundle(["votes"], read({}));
    expect(r.status).toBe("absent");
    expect(r.rows).toBeNull();
  });

  it("reports a captured-but-empty table as empty, with rows present", () => {
    const [r] = planBundle(["votes"], read({ votes: { present: true, rows: [] } }));
    expect(r.status).toBe("empty");
    expect(r.rows).toEqual([]);
  });

  it("reports unparseable and non-array files as unreadable", () => {
    const [bad] = planBundle(["votes"], read({ votes: { present: true, parseError: "Unexpected token" } }));
    expect(bad.status).toBe("unreadable");
    const [notArray] = planBundle(["votes"], read({ votes: { present: true, rows: { wallet: "0x1" } } }));
    expect(notArray.status).toBe("unreadable");
  });

  it("carries rows through for a populated table", () => {
    const rows = [{ wallet: "0xa", week: "2026-W33", token_id: "1" }];
    const [r] = planBundle(["votes"], read({ votes: { present: true, rows } }));
    expect(r.status).toBe("ready");
    expect(r.rows).toEqual(rows);
  });
});

describe("a partial restore is never presented as a restore", () => {
  const ready = (table) => ({ table, status: "ready", rows: [{}] });

  it("treats absent, unreadable and failed as unusable", () => {
    for (const status of ["absent", "unreadable", "failed"]) {
      expect(isUsableRestore([{ table: "votes", status }])).toBe(false);
    }
  });

  it("treats empty and restored as usable", () => {
    expect(isUsableRestore([
      { table: "votes", status: "empty" },
      { table: "messages", status: "restored", rowsWritten: 3 },
    ])).toBe(true);
  });

  it("never prints a success sentence when a table failed", () => {
    const out = formatSummary(
      [{ ...ready("messages"), status: "restored", rowsWritten: 9 }, { table: "votes", status: "absent", rows: null }],
      { apply: true },
    );
    expect(out).toContain("NOT A USABLE RESTORE");
    expect(out).not.toMatch(/rows written/);
  });

  it("says nothing was written in dry-run mode", () => {
    const out = formatSummary([{ ...ready("messages") }], { apply: false });
    expect(out).toContain("nothing was written");
  });

  it("counts only rows actually written", () => {
    const s = summarize([
      { table: "messages", status: "restored", rowsWritten: 40 },
      { table: "votes", status: "failed", rowsWritten: 7 },
      { table: "user_profiles", status: "empty" },
    ]);
    expect(s).toMatchObject({ restored: 1, failed: 1, empty: 1, rows: 47 });
  });
});

describe("error diagnosis points at the cause, not the symptom", () => {
  it("turns a 404 into the migration that has not been applied", () => {
    expect(diagnoseInsertError("dm_messages", 404)).toContain("007_p2p_trades_and_chat.sql");
    expect(diagnoseInsertError("votes", 200, "PGRST205 could not find the table")).toContain("000_base_schema.sql");
  });

  it("names the real precondition for the rate-limit trigger, not just the workaround", () => {
    // The trigger tests EXISTING rows' created_at, so it fires only when the
    // payload omits created_at. A diagnosis that jumps straight to "disable
    // the trigger" would talk operators into disabling a live security check
    // they did not need to touch.
    const msg = diagnoseInsertError("messages", 400, '{"message":"Rate limit exceeded"}');
    expect(msg).toContain("created_at");
    expect(msg).toContain("DISABLE TRIGGER rate_limit_messages");
    expect(msg).toContain("ENABLE TRIGGER rate_limit_messages");
  });

  it("names the service key on an RLS refusal", () => {
    expect(diagnoseInsertError("votes", 403, "42501")).toContain("SUPABASE_SERVICE_KEY");
  });

  it("explains a foreign-key violation in restore-order terms", () => {
    expect(diagnoseInsertError("dm_messages", 409, "23503")).toContain("trade_offers before dm_messages");
  });
});

describe("argument parsing fails closed", () => {
  it("defaults to a dry run", () => {
    expect(parseArgs([]).apply).toBe(false);
    expect(parseArgs([]).allowNonEmpty).toBe(false);
  });

  it("requires --apply to write", () => {
    expect(parseArgs(["--apply"]).apply).toBe(true);
  });

  it("rejects an unknown flag rather than ignoring it", () => {
    expect(() => parseArgs(["--force"])).toThrow(/unknown argument/);
  });

  it("rejects --only naming a table outside the bundle set", () => {
    expect(() => parseArgs(["--only", "analytics_events"])).toThrow(/not in the bundle set/);
  });

  it("rejects a nonsense chunk size", () => {
    expect(() => parseArgs(["--chunk", "0"])).toThrow(/positive integer/);
  });

  it("chunks without dropping or duplicating a row", () => {
    const rows = Array.from({ length: 7 }, (_, i) => i);
    const parts = chunk(rows, 3);
    expect(parts.map((p) => p.length)).toEqual([3, 3, 1]);
    expect(parts.flat()).toEqual(rows);
  });
});

describe("migration hygiene", () => {
  it("gives every migration a unique number", () => {
    // The 2026-08-19 collision: two slices both wrote 016. You apply one, the
    // ledger (or your memory) says "016 done", and the other never lands.
    const seen = new Map();
    const dupes = [];
    for (const f of migrationFiles()) {
      const n = f.slice(0, 3);
      if (seen.has(n)) dupes.push(`${n}: ${seen.get(n)} and ${f}`);
      else seen.set(n, f);
    }
    expect(dupes, "two migrations share a number — one of them will silently never be applied").toEqual([]);
  });

  it("numbers every migration with three leading digits", () => {
    for (const f of migrationFiles()) {
      expect(f, `${f} does not sort with the rest`).toMatch(/^\d{3}_[a-z0-9_]+\.sql$/);
    }
  });

  it("ships a base schema that creates the five hand-made tables", () => {
    const sql = readFileSync(join(MIGRATIONS, "000_base_schema.sql"), "utf-8");
    for (const t of ["messages", "user_profiles", "user_favorites", "user_watchlist", "votes"]) {
      expect(sql, `000_base_schema.sql does not create ${t}`).toMatch(
        new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${t}\\b`),
      );
    }
  });

  it("does not resurrect the permissive write policies 015 exists to drop", () => {
    // 015 §1 DROPs these eight. A base schema that CREATEs them would rebuild
    // the exposure on every fresh project.
    const sql = readFileSync(join(MIGRATIONS, "000_base_schema.sql"), "utf-8");
    const created = sql
      .split("\n")
      .filter((l) => /^\s*CREATE POLICY/.test(l))
      .join("\n");
    for (const name of [
      "Anyone can insert favorites",
      "Anyone can delete favorites",
      "Anyone can upsert own profile",
      "Anyone can update own profile",
      "Anyone can insert watchlist",
      "Anyone can delete watchlist",
      "Anyone can insert votes",
      "Anyone can update own vote",
    ]) {
      expect(created, `000_base_schema.sql re-creates "${name}"`).not.toContain(name);
    }
  });

  it("keeps the anon-readable policies the app's anon SELECTs depend on", () => {
    // Dropping these is 015 §2's open decision. Taking it here would blank the
    // public vote tally and empty every signed-out favourites list — an outage
    // that renders as a legitimate zero.
    const sql = readFileSync(join(MIGRATIONS, "000_base_schema.sql"), "utf-8");
    for (const name of [
      "Anyone can read votes",
      "Anyone can read profiles",
      "Anyone can read favorites",
      "Anyone can read watchlist",
    ]) {
      expect(sql).toContain(`CREATE POLICY "${name}"`);
    }
  });

  it("accounts for every table-creating migration that does not reload the PostgREST cache", () => {
    // Without a reload the table exists and PostgREST keeps answering
    // PGRST205 — the migration looks like it did nothing. 014's header
    // documents that first-hand, and 8 of the 19 files have the defect today.
    //
    // The rule is not "every file must NOTIFY" — most of these are not ours to
    // edit. It is that a file which creates a table without reloading the
    // cache MUST be named in RESTORE.md, because the runbook's closing NOTIFY
    // is the only thing that makes it visible over REST. A new migration
    // fails here until someone adds one line to the runbook.
    const runbook = readFileSync(join(FRONTEND, "supabase", "RESTORE.md"), "utf-8");
    const unaccounted = migrationFiles().filter((f) => {
      const sql = readFileSync(join(MIGRATIONS, f), "utf-8");
      if (!/CREATE TABLE/i.test(sql)) return false;
      if (/NOTIFY pgrst, 'reload schema'/.test(sql)) return false;
      return !runbook.includes(f);
    });
    expect(
      unaccounted,
      "these migrations create a table and never reload the PostgREST schema cache, " +
        "and RESTORE.md does not name them — add them to its cache-reload list",
    ).toEqual([]);
  });

  it("documents the restore order and both hand-application traps", () => {
    const runbook = readFileSync(join(FRONTEND, "supabase", "RESTORE.md"), "utf-8");
    expect(runbook).toContain("008");
    expect(runbook).toContain("004");
    expect(runbook).toMatch(/NOTIFY pgrst, 'reload schema'/);
    // 015 must be named before 014 in the ordered list, which is the whole
    // point of the ordering section.
    expect(runbook.indexOf("015_drop_permissive_policy_overrides.sql")).toBeLessThan(
      runbook.lastIndexOf("014_siwe_nonces.sql"),
    );
  });
});

describe("contingency DDL the script cannot run for you", () => {
  it("gives both halves of the messages trigger dance", () => {
    // Only ever half-applied is the failure that matters: a project left with
    // its rate limiter disabled looks identical to one that never had it.
    expect(MANUAL_SQL.messages.before).toContain("DISABLE TRIGGER");
    expect(MANUAL_SQL.messages.after).toContain("ENABLE TRIGGER");
  });

  it("states the condition under which it applies, not just the remedy", () => {
    expect(MANUAL_SQL.messages.why).toContain("created_at");
  });
});
