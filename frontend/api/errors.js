// ============================================================
// api/errors.js: the sink for src/lib/errorReporting.ts
//
// WHY THIS EXISTS
// ---------------
// errorReporting.ts has been finished work for a long time: consent-gated,
// scrubbed, de-duplicated, batched, SSRF-guarded, and wired to the error
// boundaries plus `unhandledrejection`. It POSTs to VITE_ERROR_ENDPOINT. That
// variable was never set and no route existed to receive it, so every
// client-side error this app ever raised was dropped. On 2026-09-04 the Alchemy
// key rotated, the frontend and the indexer went dark together, and the operator
// found out from a user. 013_analytics_events.sql opens with the same sentence
// about VITE_ANALYTICS_ENDPOINT: this is the second time the shape has happened.
//
// THE GAP BEFORE THE OPERATOR STEPS (docs/TODO_OPERATOR.md, 2026-10-02)
// --------------------------------------------------------------------
// This route ships before migration 026 is applied and possibly before Upstash
// is configured. Until then it must refuse, cheaply and quietly:
//   * Upstash unset → 503. Without it the aggregate breaker below is a
//     per-instance counter, so the real ceiling is (instances x 600)/min. The
//     other api/ routes degrade instead of refusing (ratelimit.js, 2026-06-09)
//     because users see them; nobody sees this one, so refusing costs nothing.
//   * Supabase unset → 503.
//   * Table missing (PGRST205 until 026 runs) or any insert failure → 503, and
//     this instance stops asking the database for SINK_DOWN_MS, so a crash loop
//     in the field is not a crash loop against Postgres or the logs.
// Every refusal is the same words plus a Retry-After, which the client obeys on
// top of its own doubling backoff. The body never says WHICH thing is missing.
// Nothing here can throw out of the handler: an unexpected failure is a 503 too.
//
// CONSENT
// -------
// The client checks consent when it captures an error AND again when it sends,
// and marks the batch `consent: "granted"`. A batch without that mark (including
// the bare array an earlier draft of this route accepted) is refused whole. The
// server cannot see the visitor's choice, so this is a contract, not proof: it
// guarantees nothing is stored from a code path that never asked.
//
// SCRUB, BEFORE ANYTHING IS STORED
// --------------------------------
// The client scrubs too, but the server is where the privacy promise in
// PrivacyPage §3 and §5 is kept. Each text field goes through, in order:
//   1. every URL → redactRpcUrl (host kept, ids, query values, userinfo and
//      fragment masked). One exception: a file under /assets/ on our own origin,
//      which is a public build file, keeps its path so a stack frame still points
//      at code.
//   2. wallet addresses and long opaque strings: 0x + 40 or more hex anywhere, any
//      run of 32+ letters and digits that contains a digit, and any whole run of
//      32 to 44 base58 characters (a Solana key, mid-trace included).
//   3. logSafe's patterns: JWTs, bearer tokens, 64-hex, mnemonics, key=value secrets.
//   4. any remaining query-string value, on a path with no host.
//   5. THEN the cut to the column ceiling. Cutting first could leave 30 of an
//      address's 40 hex digits behind, which no 40-hex test would catch.
//   6. a last whole-field check with analytics.js's containsAddress.
// The page URL is parsed and passed through redactRpcUrl alone; one that does not
// parse is stored as null rather than as raw text.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import { checkRateLimit, checkGlobalLimit } from "./_lib/ratelimit.js";
import { logSafe } from "./_lib/logSafe.js";
import { redactRpcUrl } from "./_lib/redact-url.js";
import { containsAddress } from "./analytics.js";

// The client sends at most 50 entries of at most ~2 KB each.
export const config = { api: { bodyParser: { sizeLimit: "256kb" } } };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

let _client = null;
function supabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  if (!_client) _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  return _client;
}

function upstashConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

// Origin allowlist: the same function as analytics.js, character for character
// (errors.test.js compares the two), and covered by canonical-origin.test.js and
// origin-allowlist-parity.test.js.
function buildAllowedOrigins() {
  const set = new Set([
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
  // No credentials header: this endpoint neither reads nor sets cookies.
  if (allowed.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/** Column ceilings, matched by the CHECK in 026_error_events.sql. */
const MAX_MESSAGE = 2000;
const MAX_STACK = 2000;
const MAX_URL = 500;
/** Work bound for the scrub: a field is cut to this before any pattern runs. */
const PRE_CAP = 8000;
/** Rows accepted from one POST. The remainder is reported, not 413'd. */
export const MAX_ERRORS_PER_BATCH = 100;

/** Seconds a client should wait when an operator step is missing, and when the table is. */
const RETRY_AFTER_UNCONFIGURED_SEC = 3600;
const RETRY_AFTER_UNAVAILABLE_SEC = 300;
/** After a failed insert, this instance answers 503 without asking the database. */
const SINK_DOWN_MS = 60_000;
/** Timestamps outside this window are not an error this client could have raised. */
const OLDEST_TS = Date.UTC(2024, 0, 1);
const FUTURE_SLACK_MS = 24 * 60 * 60_000;

const ADDRESS_REDACTED = "[ADDRESS-REDACTED]";
const REDACTED = "[REDACTED]";

const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s"'<>()[\]{}`]+/gi;
const POSITION_SUFFIX = /(?::\d+){1,2}$/;
const QUERY_VALUE = /([?&][^\s=&?#"'<>]{1,64}=)[^\s&#"'<>]+/g;
const EVM_HEX = /0x[a-fA-F0-9]{40,}/g;
const LONG_ALNUM = /[A-Za-z0-9]{32,}/g;
const BASE58_RUN = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;

/** One URL found inside error text, scrubbed. A trailing :line:col is kept. */
function scrubUrlInText(raw, ownOrigins) {
  const position = raw.match(POSITION_SUFFIX)?.[0] ?? "";
  const bare = position ? raw.slice(0, -position.length) : raw;
  let u;
  try {
    u = new URL(bare);
  } catch {
    return "[unreadable url]";
  }
  const ownBuildFile = ownOrigins.has(u.origin) && u.pathname.startsWith("/assets/")
    && !u.search && !u.hash && !u.username && !u.password;
  return `${ownBuildFile ? `${u.origin}${u.pathname}` : redactRpcUrl(bare)}${position}`;
}

/**
 * Scrub one free-text field and cut it to `cap`. Returns null for an absent field.
 * The order is load-bearing; see the header. Exported for tests.
 */
export function scrubText(value, cap, ownOrigins = buildAllowedOrigins()) {
  if (typeof value !== "string" || value.length === 0) return null;
  let s = value.slice(0, PRE_CAP);
  s = s.replace(URL_IN_TEXT, (raw) => scrubUrlInText(raw, ownOrigins));
  // Addresses and long runs BEFORE logSafe, because logSafe cuts its output at
  // 2000 characters and an address glued to other text escapes its word-bounded
  // HEX_40, so it would be cut in half first and never matched after.
  s = s.replace(EVM_HEX, ADDRESS_REDACTED);
  s = s.replace(LONG_ALNUM, (run) => (/\d/.test(run) ? REDACTED : run));
  s = s.replace(BASE58_RUN, REDACTED);
  s = logSafe(s);
  s = s.replace(QUERY_VALUE, "$1***");
  s = s.slice(0, cap);
  return containsAddress(s) ? ADDRESS_REDACTED : s;
}

/** The page URL: parsed, redacted, cut. Anything that is not an http(s) URL is null. */
export function scrubPageUrl(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  let u;
  try {
    u = new URL(value.slice(0, PRE_CAP));
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const s = redactRpcUrl(u.href).slice(0, MAX_URL);
  return containsAddress(s) ? ADDRESS_REDACTED : s;
}

/**
 * Validate and scrub one ErrorEntry into a row.
 * Returns `{ ok: true, row }` or `{ ok: false, reason }`. Exported for tests.
 */
export function validateEntry(e, ownOrigins = buildAllowedOrigins()) {
  if (!e || typeof e !== "object" || Array.isArray(e)) {
    return { ok: false, reason: "not-an-object" };
  }
  const { message, stack, componentStack, timestamp, url } = e;

  if (typeof message !== "string" || message.length < 1) {
    return { ok: false, reason: "bad-message" };
  }

  // The client sends Date.now(), a number; an ISO string is accepted too. The
  // window check matters: new Date(1e20).toISOString() throws.
  let ts = NaN;
  if (typeof timestamp === "number") ts = timestamp;
  else if (typeof timestamp === "string") ts = Date.parse(timestamp);
  if (!Number.isFinite(ts) || ts < OLDEST_TS || ts > Date.now() + FUTURE_SLACK_MS) {
    return { ok: false, reason: "bad-timestamp" };
  }

  return {
    ok: true,
    row: {
      message: scrubText(message, MAX_MESSAGE, ownOrigins) || REDACTED,
      stack: scrubText(stack, MAX_STACK, ownOrigins),
      component_stack: scrubText(componentStack, MAX_STACK, ownOrigins),
      url: scrubPageUrl(url),
      occurred_at: new Date(ts).toISOString(),
    },
  };
}

// One log line per instance per missing setting, and one per failed-insert window.
const warned = new Set();
function warnOnce(key, text) {
  if (warned.has(key)) return;
  warned.add(key);
  console.error(text);
}
let sinkDownUntil = 0;

function unavailable(res, retryAfterSec) {
  res.setHeader("Retry-After", String(retryAfterSec));
  return res.status(503).json({ error: "Error sink unavailable" });
}

function badBatch(res, error) {
  return res.status(400).json({ error });
}

export default async function handler(req, res) {
  try {
    return await handle(req, res);
  } catch (err) {
    console.error("[errors] unexpected failure:", logSafe(err));
    if (!res.headersSent) return unavailable(res, RETRY_AFTER_UNAVAILABLE_SEC);
  }
}

async function handle(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Origin-gated like every other write surface. An error endpoint that accepts
  // from anywhere is a free write primitive against our own database.
  const ownOrigins = buildAllowedOrigins();
  if (!ownOrigins.has(req.headers?.origin || "")) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  if (!upstashConfigured()) {
    warnOnce("upstash", "[errors] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set: refusing every batch (fail closed).");
    return unavailable(res, RETRY_AFTER_UNCONFIGURED_SEC);
  }
  const db = supabase();
  if (!db) {
    warnOnce("supabase", "[errors] SUPABASE_URL / SUPABASE_SERVICE_KEY not set: refusing every batch.");
    return unavailable(res, RETRY_AFTER_UNCONFIGURED_SEC);
  }
  if (Date.now() < sinkDownUntil) return unavailable(res, RETRY_AFTER_UNAVAILABLE_SEC);

  // TWO LIMITERS, BECAUSE A CRASH LOOP IS CORRELATED ACROSS IPs. The per-IP limit
  // stops one tab hammering. The aggregate breaker covers the case this route
  // exists for: a broken deploy in which every session errors at once, each from
  // its own IP and each under its own ceiling. checkGlobalLimit is (res, opts) and
  // adds its own "-global" suffix to the identifier.
  const perIp = await checkRateLimit(req, res, { limit: 30, windowSec: 60, identifier: "errors" });
  if (!perIp) return;
  const aggregate = await checkGlobalLimit(res, { limit: 600, windowSec: 60, identifier: "errors" });
  if (!aggregate) return;

  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return badBatch(res, 'Expected { consent: "granted", errors: [...] }');
  }
  if (body.consent !== "granted") return badBatch(res, "Consent required");
  if (!Array.isArray(body.errors)) {
    return badBatch(res, 'Expected { consent: "granted", errors: [...] }');
  }
  const entries = body.errors;
  if (entries.length === 0) return res.status(200).json({ accepted: 0, rejected: 0 });

  // TRUNCATE, DO NOT 413: a crash loop is when batches get big, and that is when
  // the data matters most.
  const overflow = Math.max(0, entries.length - MAX_ERRORS_PER_BATCH);
  const considered = overflow > 0 ? entries.slice(0, MAX_ERRORS_PER_BATCH) : entries;

  const rows = [];
  const rejected = {};
  for (const e of considered) {
    const r = validateEntry(e, ownOrigins);
    if (r.ok) rows.push(r.row);
    else rejected[r.reason] = (rejected[r.reason] || 0) + 1;
  }
  if (overflow > 0) rejected["batch-truncated"] = overflow;

  if (rows.length === 0) {
    return res.status(200).json({ accepted: 0, rejected: considered.length + overflow, reasons: rejected });
  }

  let error;
  try {
    ({ error } = await db.from("error_events").insert(rows));
  } catch (thrown) {
    error = thrown;
  }
  if (error) {
    sinkDownUntil = Date.now() + SINK_DOWN_MS;
    console.error(
      `[errors] insert failed; refusing for ${SINK_DOWN_MS / 1000}s on this instance. ` +
      "PGRST205 means migration 026 has not been applied:",
      logSafe(error),
    );
    return unavailable(res, RETRY_AFTER_UNAVAILABLE_SEC);
  }

  return res.status(200).json({
    accepted: rows.length,
    rejected: considered.length - rows.length + overflow,
    ...(Object.keys(rejected).length ? { reasons: rejected } : {}),
  });
}
