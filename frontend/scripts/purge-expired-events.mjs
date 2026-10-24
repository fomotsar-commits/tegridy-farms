#!/usr/bin/env node
// Delete error reports older than 30 days from error_events, and analytics events older
// than 90 days from analytics_events.
//
// Run every hour by .github/workflows/error-retention.yml, with the SUPABASE_URL and
// SUPABASE_SERVICE_KEY repository secrets that supabase-backup.yml already uses. By hand,
// from the repo root, with those two set in the environment:
//   node frontend/scripts/purge-expired-events.mjs
//
// The exit code is the alarm: GitHub mails the owner when a scheduled run fails. So a run
// that could not delete from either table is exit 1, and the one green run that deleted
// nothing on purpose is a table not existing yet (error_events before migration 026,
// analytics_events before 013), when nothing can have been stored in it. Each table is
// purged on its own: one failing never stops the other. The deletes themselves are
// api/_lib/errorPurge.js, the same ones api/errors.js and api/analytics.js run as a
// backstop. Nothing here prints the key, or any row.

import { pathToFileURL } from "node:url";
import { purgeExpiredAnalyticsEvents, purgeExpiredErrorEvents } from "../api/_lib/errorPurge.js";
import { ANALYTICS_RETENTION_DAYS, ERROR_RETENTION_DAYS } from "../api/_lib/errorPolicy.js";

const REQUIRED = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"];

/** One entry per table. `grantedBy` is the migration that lets service_role DELETE there. */
const PURGES = [
  {
    table: "error_events",
    one: "error report",
    many: "Error reports",
    days: ERROR_RETENTION_DAYS,
    createdBy: "026",
    grantedBy: "026_error_events.sql",
    purge: purgeExpiredErrorEvents,
  },
  {
    table: "analytics_events",
    one: "analytics event",
    many: "Analytics events",
    days: ANALYTICS_RETENTION_DAYS,
    createdBy: "013",
    grantedBy: "027_analytics_events_retention.sql",
    purge: purgeExpiredAnalyticsEvents,
  },
];

/** Purge one table and report it. True when nothing past its retention can be left. */
async function purgeOne(p, { env, fetchImpl, nowMs, log, error }) {
  const r = await p.purge({
    supabaseUrl: env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_KEY,
    nowMs,
    fetchImpl,
    timeoutMs: 60_000,
  });

  if (r.ok && r.tableMissing) {
    log(
      `::notice title=${p.table} does not exist yet::Migration ${p.createdBy} has not been applied, so no ` +
        `${p.one} can have been stored and there is nothing to delete.`,
    );
    return true;
  }
  if (r.ok) {
    const n = r.deleted === null ? "an unknown number of" : String(r.deleted);
    log(`Deleted ${n} ${p.one}(s) received before ${r.cutoff} (older than ${p.days} days).`);
    return true;
  }
  const hint =
    r.code === "42501"
      ? `42501: the key was accepted but may not delete from ${p.table}. Apply ` +
        `frontend/supabase/migrations/${p.grantedBy} in the Supabase SQL editor.`
      : "http-401 or http-403: the SUPABASE_SERVICE_KEY secret is wrong or rotated. " +
        "unreachable: Supabase did not answer; the next hourly run tries again.";
  error(
    `::error title=${p.many} retention purge failed::${r.reason}${r.code ? ` (${r.code})` : ""}. ` +
      `${p.many} older than ${p.days} days may still be stored. ${hint}`,
  );
  return false;
}

export async function main({
  env = process.env,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  log = console.log,
  error = console.error,
} = {}) {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) {
    error(
      `::error title=Retention not configured::Missing repo secrets: ${missing.join(" ")}. ` +
        `Nothing was deleted, so ${PURGES.map((p) => `${p.many.toLowerCase()} older than ${p.days} days`).join(" and ")} ` +
        "may still be stored. Set them under Settings > Secrets and variables > Actions " +
        "(the same two supabase-backup.yml uses).",
    );
    return 1;
  }

  let allOk = true;
  for (const p of PURGES) {
    // In turn, never short-circuited: a failure on one table still purges the next.
    if (!(await purgeOne(p, { env, fetchImpl, nowMs, log, error }))) allOk = false;
  }
  return allOk ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
