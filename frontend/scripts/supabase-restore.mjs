#!/usr/bin/env node
/**
 * Supabase data restore — loads a decrypted backup bundle back into a
 * rebuilt schema.
 *
 * THIS SCRIPT RESTORES DATA. IT DOES NOT BUILD SCHEMA.
 * It talks to PostgREST, which cannot run DDL. The schema has to exist first,
 * in the order supabase/RESTORE.md gives, and this script REFUSES to write
 * into a project where it does not — a 404 on a table is reported as
 * "schema-missing" and names the migration that creates it, never as an empty
 * table it could helpfully fill.
 *
 * WHY IT IS DEFENSIVE BY DEFAULT
 *   The bundle contains signed Seaport orders (native_orders, trade_offers).
 *   A signature is a bearer instrument and the row is its only copy, so the
 *   failure that matters is not "the restore errored" — it is "the restore
 *   reported success having skipped a table". Every rule below exists to make
 *   that state unreachable:
 *
 *     - Dry run is the default. Writing needs --apply.
 *     - A table file MISSING from the bundle is a failure, and is reported as
 *       "absent" — never folded into "0 rows restored", which is what an empty
 *       table legitimately looks like.
 *     - A non-empty target table aborts the run. Re-running a restore into
 *       live rows either duplicates them or silently loses the conflicting
 *       ones to ON CONFLICT; both are worse than stopping.
 *     - Partial success is failure. Any table failing exits non-zero and the
 *       word "complete" is never printed.
 *
 * USAGE
 *   node scripts/supabase-restore.mjs --bundle ./backup            # dry run
 *   node scripts/supabase-restore.mjs --bundle ./backup --apply    # writes
 *
 *   SUPABASE_URL          https://<project-ref>.supabase.co
 *   SUPABASE_SERVICE_KEY  service-role key. Required: RLS would otherwise
 *                         refuse every row, since a restore has no user JWT
 *                         and every owner policy keys on one.
 *
 *   The bundle is the decrypted contents of the weekly artifact
 *   (.github/workflows/supabase-backup.yml):
 *     gpg --decrypt --batch --passphrase "$BACKUP_PASSPHRASE" \
 *       supabase-backup-<date>.tar.gz.gpg | tar -xz
 *   which yields backup/<table>.json — one JSON array per table.
 *
 * FLAGS
 *   --bundle <dir>     directory holding <table>.json    (default ./backup)
 *   --apply            actually write. Without it, nothing is sent.
 *   --allow-nonempty   proceed into tables that already hold rows. Read the
 *                      warning it prints before using it.
 *   --only <a,b>       restore a subset. Order is still enforced.
 *   --chunk <n>        rows per POST (default 500)
 *
 * The pure helpers below are exported and covered by
 * scripts/supabase-restore.test.mjs — this directory IS collected by vitest
 * (vitest.config.ts include is project-wide), unlike repo-root scripts/.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";

// ─────────────────────────────────────────────────────────────────────
// The table set. Deliberately identical to TABLES in
// .github/workflows/supabase-backup.yml — a restore that expects a table the
// backup never captured would fail every run, and one that ignores a table
// the backup DOES capture would drop it on the floor. If that list changes,
// this one changes with it.
//
// ORDER IS A FOREIGN KEY ORDER, not an alphabetical one. There is exactly one
// real edge in the schema: dm_messages.trade_id REFERENCES trade_offers(id)
// (007:82). Everything else is independent; trade_offers is placed early and
// dm_messages last so the edge can never be violated regardless of --only.
// ─────────────────────────────────────────────────────────────────────
export const RESTORE_ORDER = Object.freeze([
  "native_orders",
  "trade_offers",
  "push_subscriptions",
  "revoked_jwts",
  "messages",
  "user_profiles",
  "user_favorites",
  "user_watchlist",
  "votes",
  "dm_messages",
]);

/**
 * Tables that exist in the schema and are NOT in any backup bundle, with the
 * reason. Printed on every run so a restore never leaves the operator
 * believing the database came back whole.
 *
 * siwe_nonces is a deliberate exclusion (5-minute TTL; dead before any
 * restore could run). The other five are DRIFT: the backup's table list was
 * written against the API surface as it stood and has not grown with
 * migrations 013/016/017/018. Their data is not recoverable from any bundle.
 */
export const NOT_IN_BUNDLE = Object.freeze([
  ["siwe_nonces", "intentional — 5-minute TTL auth nonces, dead before any restore"],
  ["analytics_events", "DRIFT — migration 013 shipped after the backup list was written"],
  ["alert_rules", "DRIFT — migration 016"],
  ["api_keys", "DRIFT — migration 017. Keys are hashes; issuance is unrecoverable either way"],
  ["airdrop_manifests", "DRIFT — migration 018"],
  ["airdrop_manifest_entries", "DRIFT — migration 018. A lost manifest makes a funded campaign unclaimable"],
  ["schema_migrations", "the ledger describes THIS project's history, not the backup's"],
]);

/** Which migration creates each table — used to make a 404 actionable. */
export const CREATED_BY = Object.freeze({
  native_orders: "002_native_orders_trades_push.sql",
  trade_offers: "002_native_orders_trades_push.sql",
  push_subscriptions: "002_native_orders_trades_push.sql",
  revoked_jwts: "003_revoked_jwts.sql",
  dm_messages: "007_p2p_trades_and_chat.sql",
  messages: "000_base_schema.sql",
  user_profiles: "000_base_schema.sql",
  user_favorites: "000_base_schema.sql",
  user_watchlist: "000_base_schema.sql",
  votes: "000_base_schema.sql",
});

/**
 * CONTINGENCY statements, not routine ones — and the distinction is the point.
 *
 * `messages` carries a BEFORE INSERT trigger enforcing a 5-second per-author
 * cooldown (000_base_schema.sql §1, from 004 §5). Its predicate tests the
 * created_at of rows ALREADY in the table, not NEW.created_at, so a restore
 * carrying each row's original timestamp — which the bundle does and this
 * script posts verbatim — never trips it.
 *
 * It trips only when created_at is missing from the payload and the column
 * DEFAULT fires, which is what a hand-written INSERT or a column-filtered
 * import produces. Then the second row of every author raises "Rate limit
 * exceeded" and the table comes back holding one message per person.
 *
 * So these are printed by diagnoseInsertError WHEN that error appears, and not
 * as a step. Telling an operator to disable a live security trigger they did
 * not need to disable is its own incident, and re-enabling is the half people
 * forget.
 */
export const MANUAL_SQL = Object.freeze({
  messages: {
    before: "ALTER TABLE public.messages DISABLE TRIGGER rate_limit_messages;",
    after: "ALTER TABLE public.messages ENABLE TRIGGER rate_limit_messages;",
    why: "the 5s/author cooldown fires only if created_at is absent from the payload",
  },
});

// ─────────────────────────────────────────────────────────────────────
// Pure helpers (unit-tested)
// ─────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = {
    bundle: "./backup",
    apply: false,
    allowNonEmpty: false,
    only: null,
    chunkSize: 500,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--allow-nonempty") out.allowNonEmpty = true;
    else if (a === "--bundle") out.bundle = argv[++i];
    else if (a === "--chunk") out.chunkSize = Number(argv[++i]);
    else if (a === "--only") {
      out.only = String(argv[++i] || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(out.chunkSize) || out.chunkSize < 1) {
    throw new Error("--chunk must be a positive integer");
  }
  if (out.only) {
    const unknown = out.only.filter((t) => !RESTORE_ORDER.includes(t));
    if (unknown.length) throw new Error(`--only names tables that are not in the bundle set: ${unknown.join(", ")}`);
  }
  return out;
}

/** Tables to act on, always in RESTORE_ORDER regardless of how --only was typed. */
export function selectTables(only) {
  if (!only) return [...RESTORE_ORDER];
  return RESTORE_ORDER.filter((t) => only.includes(t));
}

export function chunk(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * What the bundle offers for each table, BEFORE anything is written.
 *
 * The three outcomes are kept apart on purpose. "absent" (no file) and
 * "empty" (a file containing []) are different facts about the backup, and
 * collapsing them is how a restore reports success over a table it never saw.
 *
 * @param {string[]} tables
 * @param {(t: string) => { present: boolean, rows?: unknown[], parseError?: string }} read
 */
export function planBundle(tables, read) {
  return tables.map((table) => {
    const r = read(table);
    if (!r.present) {
      return { table, status: "absent", rows: null, detail: `no ${table}.json in the bundle` };
    }
    if (r.parseError) {
      return { table, status: "unreadable", rows: null, detail: r.parseError };
    }
    if (!Array.isArray(r.rows)) {
      return { table, status: "unreadable", rows: null, detail: `${table}.json is not a JSON array` };
    }
    if (r.rows.length === 0) {
      return { table, status: "empty", rows: [], detail: "the backup captured this table and it held no rows" };
    }
    // No detail: the row count is already the column next to it.
    return { table, status: "ready", rows: r.rows, detail: null };
  });
}

/** Read one table file. Separated from planBundle so the plan stays pure. */
export function readTableFile(bundleDir, table) {
  const path = join(bundleDir, `${table}.json`);
  if (!existsSync(path)) return { present: false };
  try {
    return { present: true, rows: JSON.parse(readFileSync(path, "utf-8")) };
  } catch (err) {
    return { present: true, parseError: err?.message || String(err) };
  }
}

/**
 * Turn a PostgREST failure into something the operator can act on. The raw
 * body is a Postgres error; the point of this function is to name the CAUSE
 * the schema already predicts, so nobody re-derives it at 3am.
 */
export function diagnoseInsertError(table, status, bodyText = "") {
  const body = String(bodyText);
  if (status === 404 || body.includes("PGRST205")) {
    return `table does not exist — apply ${CREATED_BY[table] ?? "its migration"} first, then NOTIFY pgrst, 'reload schema'`;
  }
  if (body.includes("Rate limit exceeded")) {
    return (
      `the ${table} rate-limit trigger rejected the load. It fires only when created_at is missing from ` +
      `the payload — check the bundle rows carry it before reaching for the trigger. If they genuinely do not: ` +
      `${MANUAL_SQL.messages.before} … then ${MANUAL_SQL.messages.after}`
    );
  }
  if (status === 401 || status === 403 || body.includes("42501")) {
    return "permission denied — a restore must use SUPABASE_SERVICE_KEY; RLS refuses every row without a user JWT";
  }
  if (body.includes("23503")) {
    return "foreign key violation — a referenced row is missing; restore trade_offers before dm_messages";
  }
  if (body.includes("23505")) {
    return "duplicate key — the target table already holds these rows; this is why --allow-nonempty exists and why it is not the default";
  }
  return `HTTP ${status}: ${body.slice(0, 300)}`;
}

export function summarize(results) {
  const by = (s) => results.filter((r) => r.status === s);
  return {
    ready: by("ready").length,
    restored: by("restored").length,
    empty: by("empty").length,
    absent: by("absent").length,
    unreadable: by("unreadable").length,
    failed: by("failed").length,
    skipped: by("skipped").length,
    rows: results.reduce((n, r) => n + (r.rowsWritten || 0), 0),
  };
}

/**
 * The exit verdict. A restore is usable only when NOTHING was absent,
 * unreadable or failed — "we got most of it" is indistinguishable from "we got
 * the part you did not need", which is the exact rule the backup workflow
 * already enforces on the way out.
 */
export function isUsableRestore(results) {
  return !results.some((r) => r.status === "absent" || r.status === "unreadable" || r.status === "failed");
}

const plural = (n) => `${n} row${n === 1 ? "" : "s"}`;

export function formatSummary(results, { apply }) {
  const s = summarize(results);
  const lines = [];
  lines.push("");
  lines.push(apply ? "── restore result ──" : "── dry run — nothing was written ──");
  for (const r of results) {
    const n = r.rowsWritten != null ? plural(r.rowsWritten) : r.rows ? plural(r.rows.length) : "—";
    lines.push(`  ${r.status.padEnd(11)} ${r.table.padEnd(20)} ${n}${r.detail ? `  (${r.detail})` : ""}`);
  }
  lines.push("");
  if (!isUsableRestore(results)) {
    lines.push(
      `NOT A USABLE RESTORE: ${s.absent} absent, ${s.unreadable} unreadable, ${s.failed} failed. ` +
        "Do not treat this database as restored.",
    );
  } else if (apply) {
    lines.push(`All ${results.length} tables accounted for; ${s.rows} rows written.`);
  } else {
    lines.push(`All ${results.length} tables accounted for. Re-run with --apply to write.`);
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────
// I/O
// ─────────────────────────────────────────────────────────────────────

async function countRows(url, key, table) {
  const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" },
  });
  if (res.status === 404) return { missing: true };
  if (!res.ok) return { error: diagnoseInsertError(table, res.status, await res.text()) };
  // PostgREST returns `Content-Range: 0-0/N` (or `*/N`) with count=exact.
  const range = res.headers.get("content-range") || "";
  const total = Number(range.split("/")[1]);
  return { count: Number.isFinite(total) ? total : null };
}

async function insertChunk(url, key, table, rows) {
  const res = await fetch(`${url}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(diagnoseInsertError(table, res.status, await res.text()));
  return rows.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readFileSync(new URL(import.meta.url), "utf-8").split("*/")[0]);
    return 0;
  }

  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY || "";

  if (!existsSync(args.bundle)) {
    console.error(`Bundle directory not found: ${args.bundle}`);
    console.error("Decrypt the weekly artifact first — see supabase/RESTORE.md step 1.");
    return 1;
  }

  const tables = selectTables(args.only);
  const results = planBundle(tables, (t) => readTableFile(args.bundle, t));

  // Files in the bundle we are not restoring. Naming them is the difference
  // between "we restored everything" and "we restored everything we know how
  // to restore".
  const stray = readdirSync(args.bundle)
    .filter((f) => f.endsWith(".json"))
    .map((f) => basename(f, ".json"))
    .filter((t) => !RESTORE_ORDER.includes(t));

  console.log(`Bundle: ${args.bundle}`);
  console.log(`Target: ${url || "(SUPABASE_URL unset)"}`);
  console.log(`Mode:   ${args.apply ? "APPLY — rows will be written" : "dry run"}`);
  console.log("");
  console.log("Not in any bundle, and therefore not restorable from one:");
  for (const [t, why] of NOT_IN_BUNDLE) console.log(`  ${t.padEnd(26)} ${why}`);
  if (stray.length) {
    console.log("");
    console.log(`Files in the bundle this script does not restore: ${stray.join(", ")}`);
    console.log("  (add them to RESTORE_ORDER, with their foreign-key position, or delete them from the bundle)");
  }

  if (!args.apply) {
    console.log(formatSummary(results, { apply: false }));
    return isUsableRestore(results) ? 0 : 1;
  }

  if (!url || !key) {
    console.error("\nSUPABASE_URL and SUPABASE_SERVICE_KEY must both be set to --apply.");
    console.error("The service key is required: RLS owner policies key on a user JWT a restore does not have.");
    return 1;
  }

  // Preflight: every table must exist, and be empty unless overridden. Done
  // for ALL tables before writing ANY, so a run cannot half-land.
  let blocked = false;
  for (const r of results) {
    if (r.status === "absent" || r.status === "unreadable") {
      console.error(`\nPREFLIGHT: ${r.table} — ${r.detail}`);
      blocked = true;
      continue;
    }
    const probe = await countRows(url, key, r.table);
    if (probe.missing) {
      console.error(`\nPREFLIGHT: ${r.table} does not exist in the target. ${diagnoseInsertError(r.table, 404)}`);
      blocked = true;
    } else if (probe.error) {
      console.error(`\nPREFLIGHT: ${r.table} — ${probe.error}`);
      blocked = true;
    } else if (probe.count > 0 && !args.allowNonEmpty) {
      console.error(
        `\nPREFLIGHT: ${r.table} already holds ${probe.count} rows. Restoring into it would duplicate or collide.` +
          "\n  Empty it deliberately, or pass --allow-nonempty if you have decided the collision is acceptable.",
      );
      blocked = true;
    }
  }
  if (blocked) {
    console.error("\nAborted before writing anything. Nothing in the target changed.");
    return 1;
  }

  // Advisory, deliberately not a step: see MANUAL_SQL's comment for why these
  // are printed as a contingency rather than as an instruction to follow.
  for (const [table, sql] of Object.entries(MANUAL_SQL)) {
    const r = results.find((x) => x.table === table && x.status === "ready");
    if (!r) continue;
    const missingTs = r.rows.filter((row) => row?.created_at == null).length;
    if (missingTs === 0) continue;
    console.log(`\n⚠️  ${missingTs} of ${r.rows.length} ${table} rows have no created_at — ${sql.why}.`);
    console.log("    If the load fails with 'Rate limit exceeded', this is why. PostgREST cannot run DDL,");
    console.log(`    so you would need, by hand:  ${sql.before}  …restore…  ${sql.after}`);
  }

  for (const r of results) {
    if (r.status !== "ready") continue;
    let written = 0;
    try {
      for (const part of chunk(r.rows, args.chunkSize)) {
        written += await insertChunk(url, key, r.table, part);
        process.stdout.write(`\r  ${r.table}: ${written}/${r.rows.length}`);
      }
      process.stdout.write("\n");
      r.status = "restored";
      r.rowsWritten = written;
      r.detail = null;
    } catch (err) {
      process.stdout.write("\n");
      r.status = "failed";
      r.rowsWritten = written;
      // A partial table is worse than a failed one, so say which it was.
      r.detail = `${err.message}${written ? ` — ${written} of ${r.rows.length} rows had already landed; this table is now PARTIAL` : ""}`;
    }
  }

  console.log(formatSummary(results, { apply: true }));
  return isUsableRestore(results) ? 0 : 1;
}

// Only run when invoked directly, so the test file can import the helpers.
// pathToFileURL, not string concatenation — on Windows the argv path is
// backslashed and drive-lettered, and a hand-built file:// URL does not match.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err?.message || err);
      process.exit(1);
    });
}
