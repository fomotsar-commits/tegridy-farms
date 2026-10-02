#!/usr/bin/env node
// Delete error reports older than 30 days from error_events.
//
// Run every hour by .github/workflows/error-retention.yml, with the SUPABASE_URL and
// SUPABASE_SERVICE_KEY repository secrets that supabase-backup.yml already uses. By hand,
// from the repo root, with those two set in the environment:
//   node frontend/scripts/purge-error-events.mjs
//
// The exit code is the alarm: GitHub mails the owner when a scheduled run fails. So a run
// that could not delete is exit 1, and the one green run that deleted nothing on purpose is
// the table not existing yet (before migration 026), when nothing can have been stored.
// The delete itself is api/_lib/errorPurge.js, the same one api/errors.js runs as a
// backstop. Nothing here prints the key, or any row.

import { pathToFileURL } from "node:url";
import { purgeExpiredErrorEvents } from "../api/_lib/errorPurge.js";
import { ERROR_RETENTION_DAYS } from "../api/_lib/errorPolicy.js";

const REQUIRED = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"];

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
      `::error title=Error retention not configured::Missing repo secrets: ${missing.join(" ")}. ` +
        `Nothing was deleted, so error reports older than ${ERROR_RETENTION_DAYS} days may still be stored. ` +
        "Set them under Settings > Secrets and variables > Actions (the same two supabase-backup.yml uses).",
    );
    return 1;
  }

  const r = await purgeExpiredErrorEvents({
    supabaseUrl: env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_KEY,
    nowMs,
    fetchImpl,
    timeoutMs: 60_000,
  });

  if (r.ok && r.tableMissing) {
    log(
      "::notice title=error_events does not exist yet::Migration 026 has not been applied, so no error " +
        "report can have been stored and there is nothing to delete.",
    );
    return 0;
  }
  if (r.ok) {
    const n = r.deleted === null ? "an unknown number of" : String(r.deleted);
    log(`Deleted ${n} error report(s) received before ${r.cutoff} (older than ${ERROR_RETENTION_DAYS} days).`);
    return 0;
  }
  error(
    `::error title=Error retention purge failed::${r.reason}${r.code ? ` (${r.code})` : ""}. ` +
      `Error reports older than ${ERROR_RETENTION_DAYS} days may still be stored. ` +
      "http-401 or http-403: the SUPABASE_SERVICE_KEY secret is wrong or rotated. " +
      "unreachable: Supabase did not answer; the next hourly run tries again.",
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
