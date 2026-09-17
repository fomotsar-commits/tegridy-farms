// ============================================================
// api/errors.js — the sink for src/lib/errorReporting.ts
//
// WHY THIS EXISTS
// ---------------
// errorReporting.ts has been finished work for a long time: consent-gated,
// PII-scrubbed, de-duplicated, batched, SSRF-guarded, and wired to sixteen
// error boundaries plus `unhandledrejection`. It POSTs to
// VITE_ERROR_ENDPOINT. That variable was never set and no route ever existed
// to receive it, so every client-side error this app has ever raised was
// dropped on the floor. On 2026-09-04 the Alchemy key rotated, the frontend
// and the indexer went dark together, and the operator found out from a user.
//
// This is the SECOND time the same shape has bitten this project — read the
// header of 013_analytics_events.sql, which opens with the identical sentence
// about VITE_ANALYTICS_ENDPOINT never being set. Built-but-unwired is a
// failure mode this codebase has now, demonstrably, produced twice.
//
// WHAT THE CLIENT ACTUALLY SENDS — and why this route is tolerant
// --------------------------------------------------------------
// A verbatim copy of api/analytics.js would reject 100% of real traffic, on
// THREE independent axes:
//   1. ENVELOPE. flush() posts `JSON.stringify(toSend)` — a BARE ARRAY
//      (errorReporting.ts). analytics.js requires `{ events: [...] }`.
//   2. FIELDS. ErrorEntry is { message, stack?, componentStack?, timestamp,
//      url }. There is no `event` and no `sessionId`, so analytics's
//      validateEvent() fails on bad-event-name and bad-session-id.
//   3. TIMESTAMP TYPE. errorReporting sends `Date.now()` — a NUMBER.
//      analytics sends an ISO string and does
//      `typeof timestamp === "string" ? Date.parse(...) : NaN`.
//
// The SERVER absorbs all three rather than the client changing shape. The
// deciding fact: `tegridy_error_log` in localStorage is WRITE-ONLY — nothing
// in the tree ever replays it (its only readers are its own writer, merging
// before it writes back, and a test). So a 4xx here is not a delayed delivery,
// it is PERMANENT LOSS of the errors we built this to capture. A tolerant
// reader costs a few lines; a strict one silently destroys the payload.
//
// TWO RULES THIS ROUTE FOLLOWS THAT ANALYTICS DOES NOT
// ----------------------------------------------------
// Both exist because an error batch is unrecoverable where an analytics batch
// is merely a lost sample:
//
//   * AN OVERSIZE BATCH IS TRUNCATED, NEVER 413'd. The client has NO batch
//     cap — MAX_BUFFER=50 bounds only the localStorage merge (`slice(-50)`),
//     while `batch.push()` is unbounded. A crash loop legitimately produces a
//     batch of hundreds, which is exactly when the data matters most. We
//     insert what fits and report the rest in `reasons`.
//
//   * AN ADDRESS-SHAPED VALUE IS REDACTED, NEVER DISCARDED. containsAddress's
//     EVM_ADDRESS is UNANCHORED (`/0x[a-fA-F0-9]{40}/`) while logSafe's HEX_40
//     is word-bounded (`/\b0x[0-9a-fA-F]{40}\b/g`), so a 40-hex run embedded
//     in a longer token survives the scrub and still trips the gate. Dropping
//     the row there would throw away a stack trace over a substring. We blank
//     the offending field and keep the rest.
//
// URLs ARE THE REAL SOURCE OF ADDRESSES, AND THE CLIENT DOES NOT SCRUB THEM.
// sanitizeUrl() clears only `search` and `hash`; it never runs the scrub over
// the path. App.tsx routes include `read/:address`, so
// `/read/0x1489…456E` arrives here with a live 40-hex address in the path.
// That is not a client bug to warn about — it is this route's job, which is
// why url redactions are counted separately from message/stack ones.
//
// PRIVACY. Same bar as analytics_events and then some: no wallet column, no
// session id (ErrorEntry has none — the record is LESS linkable than
// PrivacyPage §3 currently claims), and a fail-closed redaction pass before
// insert. The table is added to PrivacyPage §5's enumerated list in the same
// change; §5 is a closed list and a table missing from it is a broken promise.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import { checkRateLimit, checkGlobalLimit } from "./_lib/ratelimit.js";
import { logSafe } from "./_lib/logSafe.js";
import { containsAddress } from "./analytics.js";

// Errors are chattier than analytics events — a stack trace is the biggest
// field this project posts anywhere — and a crash loop is the case we most
// need to survive. 256 KB holds a large batch of full traces.
export const config = { api: { bodyParser: { sizeLimit: "256kb" } } };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

let _client = null;
function supabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  if (!_client) _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  return _client;
}

// Origin allowlist — same shape as every other gated surface here, and covered
// by `__tests__/canonical-origin.test.js` and `origin-allowlist-parity.test.js`,
// which fail the build if the canonical origin is missing OR if a domain the
// project does not own appears.
function buildAllowedOrigins() {
  const set = new Set([
    "https://memetic.fun",
    "https://www.memetic.fun",
    "https://memetics.finance",
    "https://www.memetics.finance",
    "https://tegridyfarms.vercel.app",
  ]);
  if (process.env.NODE_ENV === "development") {
    set.add("http://localhost:8742");
    set.add("http://localhost:3000");
    set.add("http://localhost:5173");
  }
  const env = process.env.ALLOWED_ORIGINS;
  if (env) for (const o of env.split(",").map((s) => s.trim()).filter(Boolean)) set.add(o);
  return set;
}

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  const allowed = buildAllowedOrigins();
  res.setHeader("Vary", "Origin");
  // No credentials header: this endpoint neither reads nor sets cookies, and a
  // credentialed grant it does not need is a grant it should not have.
  if (allowed.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/** Column ceilings. Longer values are truncated, never rejected. */
const MAX_MESSAGE = 2000;
const MAX_STACK = 8000;
const MAX_URL = 500;
/** Rows accepted from one POST. The remainder is reported, not 413'd. */
export const MAX_ERRORS_PER_BATCH = 100;

const REDACTED = "[ADDRESS-REDACTED]";

/**
 * Fail-closed backstop over one already-scrubbed string.
 *
 * Returns the value unchanged, or REDACTED when it still looks like it holds
 * an address. Deliberately whole-field: a partial rewrite would have to guess
 * boundaries that logSafe's word-anchored pass already declined to guess, and
 * a stack trace with one blanked frame is worth more than no stack trace.
 * Exported for tests — the privacy promise is the thing most worth pinning.
 */
export function redactIfAddressed(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  return containsAddress(value) ? REDACTED : value;
}

/**
 * Accept the two envelopes: a bare array (what the client posts today) and
 * `{ errors: [...] }` (a named shape, so a future client need not stay bare).
 * Anything else is not an error batch. Exported for tests.
 */
export function extractEntries(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object" && Array.isArray(body.errors)) return body.errors;
  return null;
}

/**
 * Validate and normalise one ErrorEntry into a row.
 * Returns `{ ok: true, row, redactedFields }` or `{ ok: false, reason }`.
 * Exported for tests.
 */
export function validateEntry(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) {
    return { ok: false, reason: "not-an-object" };
  }
  const { message, stack, componentStack, timestamp, url } = e;

  // The message is the only field the client guarantees; everything else is
  // optional on ErrorEntry.
  if (typeof message !== "string" || message.length < 1) {
    return { ok: false, reason: "bad-message" };
  }

  // The client sends Date.now() — a number. An ISO string is accepted too so
  // this route does not care which client generation is talking to it.
  let ts = NaN;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) ts = timestamp;
  else if (typeof timestamp === "string") ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad-timestamp" };

  const redactedFields = [];
  const take = (v, cap, name) => {
    if (typeof v !== "string" || v.length === 0) return null;
    const cut = v.length > cap ? v.slice(0, cap) : v;
    const safe = redactIfAddressed(cut);
    if (safe !== cut) redactedFields.push(name);
    return safe;
  };

  return {
    ok: true,
    redactedFields,
    row: {
      message: take(message, MAX_MESSAGE, "message") ?? REDACTED,
      stack: take(stack, MAX_STACK, "stack"),
      component_stack: take(componentStack, MAX_STACK, "componentStack"),
      url: take(url, MAX_URL, "url"),
      occurred_at: new Date(ts).toISOString(),
    },
  };
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Origin-gated like every other write surface. An error endpoint that
  // accepts from anywhere is a free write primitive against our own database.
  const origin = req.headers?.origin || "";
  if (!buildAllowedOrigins().has(origin)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  // TWO LIMITERS, BECAUSE A CRASH LOOP IS CORRELATED ACROSS IPs.
  //
  // The per-IP limit stops one tab hammering. It does nothing about the case
  // this route exists for: a broken deploy in which EVERY session starts
  // erroring at once, each from a different IP, every one of them under its
  // own per-IP ceiling. checkGlobalLimit is the aggregate breaker for exactly
  // that shape, and without it the first bad deploy would take the database
  // down alongside the frontend.
  //
  // OPERATIONAL CAVEAT, stated because it changes what this guarantees:
  // checkGlobalLimit falls back to a PER-INSTANCE in-memory counter when
  // Upstash is unconfigured. Across N serverless instances the effective
  // ceiling is then N x the number below, not the number below. Confirm
  // UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are set before turning
  // VITE_ERROR_ENDPOINT on.
  const perIp = await checkRateLimit(req, res, {
    limit: 30, windowSec: 60, identifier: "errors",
  });
  if (!perIp) return;

  const globalOk = await checkGlobalLimit(req, res, {
    limit: 600, windowSec: 60, identifier: "errors-global",
  });
  if (!globalOk) return;

  const db = supabase();
  if (!db) {
    // Say so rather than 200-ing into the void. A sink that reports success
    // while storing nothing is the exact failure this route was written to
    // end, and answering 200 here would rebuild it one layer down.
    return res.status(503).json({ error: "Error sink not configured" });
  }

  const entries = extractEntries(req.body);
  if (!entries) {
    return res.status(400).json({ error: "Expected an array of error entries" });
  }
  if (entries.length === 0) return res.status(200).json({ accepted: 0, rejected: 0 });

  // TRUNCATE, DO NOT 413. See the header: the client has no batch cap, a crash
  // loop is when batches get big, and there is no replay — so a 413 destroys
  // precisely the evidence we most wanted.
  const overflow = Math.max(0, entries.length - MAX_ERRORS_PER_BATCH);
  const considered = overflow > 0 ? entries.slice(0, MAX_ERRORS_PER_BATCH) : entries;

  const rows = [];
  const rejected = {};
  // Counted apart from the others on purpose: `url` never passes through the
  // client's scrub (sanitizeUrl clears only search+hash), so a redaction there
  // is this route working as designed. A redaction in message/stack/
  // componentStack means the CLIENT scrub let something through, which is a
  // real signal and the only one worth warning about.
  let urlRedactions = 0;
  let fieldRedactions = 0;

  for (const e of considered) {
    const r = validateEntry(e);
    if (!r.ok) {
      rejected[r.reason] = (rejected[r.reason] || 0) + 1;
      continue;
    }
    for (const f of r.redactedFields) {
      if (f === "url") urlRedactions += 1;
      else fieldRedactions += 1;
    }
    rows.push(r.row);
  }
  if (overflow > 0) rejected["batch-truncated"] = overflow;

  if (fieldRedactions > 0) {
    // Not the url case — this one means the client-side scrub missed something.
    console.warn(
      `[errors] redacted ${fieldRedactions} address-shaped value(s) from message/stack fields`,
    );
  }

  if (rows.length === 0) {
    return res.status(200).json({ accepted: 0, rejected: considered.length, reasons: rejected });
  }

  const { error } = await db.from("error_events").insert(rows);
  if (error) {
    console.error("[errors] insert failed:", logSafe(error.message));
    return res.status(503).json({ error: "Error sink unavailable" });
  }

  return res.status(200).json({
    accepted: rows.length,
    rejected: considered.length - rows.length + overflow,
    ...(Object.keys(rejected).length ? { reasons: rejected } : {}),
    ...(urlRedactions || fieldRedactions ? { redacted: urlRedactions + fieldRedactions } : {}),
  });
}
