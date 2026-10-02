// ============================================================
// api/_lib/errorPurge.js: delete error reports older than 30 days.
//
// ONE DELETE, TWO CALLERS
//   * .github/workflows/error-retention.yml runs scripts/purge-error-events.mjs every
//     hour. This is the purge that keeps the Privacy page's "kept for 30 days, then
//     deleted automatically" when no new report arrives. It uses the SUPABASE_URL and
//     SUPABASE_SERVICE_KEY repository secrets supabase-backup.yml already uses, so it
//     needs no new secret and adds no public route.
//   * api/errors.js calls it after a stored batch, at most once an hour per instance:
//     the backstop for when GitHub's scheduler is late or down.
//
// WHY FETCH AND NOT supabase-js: the workflow runs this with bare node and no npm
// install, so this file and errorPolicy.js import nothing from node_modules. The request
// is the one supabase-js would build for `.delete({ count: "exact" }).lt(...)`.
//
// IT ALWAYS CARRIES ITS FILTER. `received_at=lt.<now minus 30 days>`: received_at is set
// by the database on insert, so a browser's clock cannot make a report outlive its 30
// days. There is no code path that sends a DELETE without the filter.
//
// IT NEVER THROWS. Every outcome is a value: { ok, deleted, cutoff, ... }. `deleted` is
// null when the database did not say how many rows went. A table that does not exist yet
// (PostgREST's PGRST205, before migration 026) is ok with nothing deleted, because
// nothing can have been stored; any other refusal is not ok.
// ============================================================

import { errorRetentionCutoff } from "./errorPolicy.js";

export const ERROR_EVENTS_TABLE = "error_events";

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

/**
 * Delete every row of error_events received more than 30 days before `nowMs`.
 *
 * @param {{ supabaseUrl?: string, serviceKey?: string, nowMs?: number,
 *           fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 */
export async function purgeExpiredErrorEvents({
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

  const cutoff = errorRetentionCutoff(nowMs);
  const url = `${base.origin}/rest/v1/${ERROR_EVENTS_TABLE}?received_at=lt.${encodeURIComponent(cutoff)}`;

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
