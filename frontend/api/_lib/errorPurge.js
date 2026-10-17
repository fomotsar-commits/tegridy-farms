// ============================================================
// api/_lib/errorPurge.js: delete error reports older than 30 days, and analytics events
// older than 90 days.
//
// ONE DELETE, TWO TABLES, THREE CALLERS
//   * .github/workflows/error-retention.yml runs scripts/purge-expired-events.mjs every
//     hour, for both tables. This is the purge that keeps the Privacy page's "kept for 30
//     days" (error reports) and "kept for 90 days" (analytics events), "then deleted
//     automatically", when nothing new arrives. It uses the SUPABASE_URL and
//     SUPABASE_SERVICE_KEY repository secrets supabase-backup.yml already uses, so it needs
//     no new secret and adds no public route.
//   * api/errors.js and api/analytics.js each purge their own table after a stored batch,
//     at most once an hour per instance: the backstop for when GitHub's scheduler is late
//     or down.
//
// WHY FETCH AND NOT supabase-js: the workflow runs this with bare node and no npm
// install, so this file and errorPolicy.js import nothing from node_modules. The request
// is the one supabase-js would build for `.delete({ count: "exact" }).lt(...)`.
//
// IT ALWAYS CARRIES ITS FILTER. `received_at=lt.<now minus the retention>`: received_at is
// set by the database on insert in both tables, so a browser's clock cannot make a row
// outlive its retention. There is no code path that sends a DELETE without the filter.
//
// IT NEVER THROWS. Every outcome is a value: { ok, deleted, cutoff, ... }. `deleted` is
// null when the database did not say how many rows went. A table that does not exist yet
// (PostgREST's PGRST205: error_events before migration 026, analytics_events before 013)
// is ok with nothing deleted, because nothing can have been stored; any other refusal is
// not ok, including 42501, a key with no DELETE on the table (analytics_events before 027).
// ============================================================

import { analyticsRetentionCutoff, errorRetentionCutoff } from "./errorPolicy.js";

export const ERROR_EVENTS_TABLE = "error_events";
export const ANALYTICS_EVENTS_TABLE = "analytics_events";

function timeoutSignal(ms) {
  // AbortSignal.timeout is in Node 18+; guarded so a host without it still runs, unbounded.
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
}

// The row count from a Content-Range header ("*" then "/N", or "0-2/N"). Anything else: null.
function parseCount(header) {
  const m = /\/(\d+)\s*$/.exec(header || "");
  return m ? Number(m[1]) : null;
}

async function readCode(res) {
  try {
    const body = await res.json();
    return body && typeof body.code === "string" ? body.code : null;
  } catch {
    return null;
  }
}

/** Delete every row of `table` whose received_at is before `cutoffFor(nowMs)`. */
async function purgeReceivedBefore(table, cutoffFor, {
  supabaseUrl,
  serviceKey,
  nowMs = Date.now(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  if (!supabaseUrl || !serviceKey) return { ok: false, reason: "not-configured", deleted: 0 };

  let base;
  try {
    base = new URL(supabaseUrl);
  } catch {
    return { ok: false, reason: "bad-url", deleted: 0 };
  }
  // The service key bypasses every RLS policy: it goes over https or not at all.
  if (base.protocol !== "https:") return { ok: false, reason: "bad-url", deleted: 0 };

  const cutoff = cutoffFor(nowMs);
  const url = `${base.origin}/rest/v1/${table}?received_at=lt.${encodeURIComponent(cutoff)}`;

  let res;
  try {
    res = await fetchImpl(url, {
      method: "DELETE",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer: "return=minimal, count=exact",
      },
      signal: timeoutSignal(timeoutMs),
    });
  } catch {
    return { ok: false, reason: "unreachable", deleted: 0, cutoff };
  }

  if (res.ok) return { ok: true, deleted: parseCount(res.headers.get("content-range")), cutoff };

  const code = await readCode(res);
  if (res.status === 404 && code === "PGRST205") {
    return { ok: true, deleted: 0, tableMissing: true, cutoff };
  }
  return { ok: false, reason: `http-${res.status}`, code, deleted: 0, cutoff };
}

/**
 * Delete every row of error_events received more than 30 days before `nowMs`.
 *
 * @param {{ supabaseUrl?: string, serviceKey?: string, nowMs?: number,
 *           fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 */
export function purgeExpiredErrorEvents(opts) {
  return purgeReceivedBefore(ERROR_EVENTS_TABLE, errorRetentionCutoff, opts);
}

/**
 * Delete every row of analytics_events received more than 90 days before `nowMs`.
 *
 * @param {{ supabaseUrl?: string, serviceKey?: string, nowMs?: number,
 *           fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 */
export function purgeExpiredAnalyticsEvents(opts) {
  return purgeReceivedBefore(ANALYTICS_EVENTS_TABLE, analyticsRetentionCutoff, opts);
}
