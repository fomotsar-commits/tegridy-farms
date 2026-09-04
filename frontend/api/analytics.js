// ═══ /api/analytics — first-party analytics sink ═══
//
// WHY THIS EXISTS
// ---------------
// `frontend/src/lib/analytics.ts` has been built, consent-gated and sanitised
// for a long time, but `VITE_ANALYTICS_ENDPOINT` was never set, so every event
// it batched was dropped on the floor. The protocol therefore has NO traffic
// number of any kind — no uniques, no funnel, no denominator under any claim
// about adoption. This is the missing half.
//
// WHY A DEDICATED FUNCTION (Vercel Hobby caps serverless functions at 12)
// ----------------------------------------------------------------------
// Neither existing candidate fits, and forcing it into one would be worse than
// spending a slot:
//   * `v1/index.js` is a READ-ONLY NFT data API keyed on `?route=`. Adding a
//     write path there mixes methods, rate-limit profiles and body handling.
//   * `supabase-proxy.js` REQUIRES a SIWE JWT so PostgREST applies RLS as the
//     user. Analytics is anonymous BY DESIGN — the entire point is measuring
//     visitors who never connect a wallet, and those have no JWT.
// This takes the count from 10 to 11 of 12.
//
// PRIVACY — this endpoint enforces a PUBLISHED promise
// ----------------------------------------------------
// PrivacyPage.tsx §3 tells every visitor that event records "do NOT include
// your wallet address". That is a claim, and claims in this repo are supposed
// to be backed by something that fails closed. So an event whose properties
// contain anything address-shaped is REJECTED, and the response reports how
// many were rejected rather than silently dropping them — a silent scrub would
// make a leak invisible, which is the failure mode, not the fix.
//
// Migration `013_analytics_events.sql` carries an EVM-address CHECK as a
// database backstop. It deliberately does NOT carry a base58 check; see that
// file for why substring matching is the wrong tool there.

import { createClient } from "@supabase/supabase-js";
import { checkRateLimit } from "./_lib/ratelimit.js";
import { logSafe } from "./_lib/logSafe.js";

// The client batches up to 200 events; each is small. 64 KB is generous for a
// full batch and still bounds a hostile caller.
export const config = { api: { bodyParser: { sizeLimit: "64kb" } } };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

let _client = null;
function supabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  if (!_client) _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  return _client;
}

// Origin allowlist — same shape as every other gated surface here, and covered
// by `__tests__/canonical-origin.test.js`, which fails the build if the
// canonical origin is missing OR if a domain the project does not own appears.
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

const EVM_ADDRESS = /0x[a-fA-F0-9]{40}/;
// Whole-value base58 test. Anchored, so a long ordinary string containing a
// 32-char alphanumeric run does NOT trip it — that substring behaviour is
// exactly why this check lives here and not in a database CHECK constraint.
const SOLANA_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * True if any string anywhere in `value` looks like a wallet address.
 * Walks nested objects/arrays because `properties` is caller-shaped.
 * Exported for tests — the privacy promise is the thing most worth pinning.
 */
export function containsAddress(value, depth = 0) {
  if (depth > 6) return false; // bounded: a hostile payload can nest arbitrarily
  if (typeof value === "string") {
    return EVM_ADDRESS.test(value) || SOLANA_PUBKEY.test(value.trim());
  }
  if (Array.isArray(value)) return value.some((v) => containsAddress(v, depth + 1));
  if (value && typeof value === "object") {
    // AUDIT FIX TF-034: scan KEYS as well as values. `properties` is
    // caller-shaped, so an address can just as easily be a key
    // (`{"0xabc…": 1}`) as a value — and a key-only address used to sail
    // straight through this gate into the analytics table.
    return (
      Object.keys(value).some((k) => containsAddress(k, depth + 1)) ||
      Object.values(value).some((v) => containsAddress(v, depth + 1))
    );
  }
  return false;
}

const MAX_EVENTS_PER_BATCH = 200;

/**
 * Validate one event. Returns `{ ok: true, row }` or `{ ok: false, reason }`.
 * Exported for tests.
 */
export function validateEvent(e) {
  if (!e || typeof e !== "object") return { ok: false, reason: "not-an-object" };
  const { event, properties, sessionId, timestamp } = e;

  if (typeof event !== "string" || event.length < 1 || event.length > 64) {
    return { ok: false, reason: "bad-event-name" };
  }
  if (typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > 128) {
    return { ok: false, reason: "bad-session-id" };
  }
  const props = properties === undefined ? {} : properties;
  if (props === null || typeof props !== "object" || Array.isArray(props)) {
    return { ok: false, reason: "bad-properties" };
  }
  // The session id is opaque by construction (see analytics.ts) — but if a
  // caller ever puts an address there, it is still an address.
  // AUDIT FIX TF-033: the event NAME was never scanned. It is a caller-supplied
  // string of up to 64 chars, which comfortably holds a 42-char EVM address or a
  // 32-44 char Solana pubkey, and it is stored verbatim in the `event` column —
  // outside the reach of the properties-only DB backstop.
  if (containsAddress(event) || containsAddress(sessionId) || containsAddress(props)) {
    return { ok: false, reason: "address-shaped-value" };
  }

  const ts = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad-timestamp" };

  return {
    ok: true,
    row: {
      event,
      properties: props,
      session_id: sessionId,
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

  // Origin-gated like every other write surface. An analytics endpoint that
  // accepts from anywhere is a free write primitive against our own database.
  const origin = req.headers?.origin || "";
  if (!buildAllowedOrigins().has(origin)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  // Higher than the auth endpoints because a single tab legitimately flushes
  // every 10s, and a burst on navigation is normal.
  const allowed = await checkRateLimit(req, res, {
    limit: 60, windowSec: 60, identifier: "analytics",
  });
  if (!allowed) return;

  const db = supabase();
  if (!db) {
    // Say so rather than 200-ing into the void. A sink that reports success
    // while storing nothing is how this project ended up with no traffic
    // number in the first place.
    return res.status(503).json({ error: "Analytics sink not configured" });
  }

  const events = req.body?.events;
  if (!Array.isArray(events)) return res.status(400).json({ error: "Expected { events: [] }" });
  if (events.length === 0) return res.status(200).json({ accepted: 0, rejected: 0 });
  if (events.length > MAX_EVENTS_PER_BATCH) {
    return res.status(413).json({ error: `Batch too large (max ${MAX_EVENTS_PER_BATCH})` });
  }

  const rows = [];
  const rejected = {};
  for (const e of events) {
    const r = validateEvent(e);
    if (r.ok) rows.push(r.row);
    else rejected[r.reason] = (rejected[r.reason] || 0) + 1;
  }

  if (rows.length === 0) {
    return res.status(200).json({ accepted: 0, rejected: events.length, reasons: rejected });
  }

  const { error } = await db.from("analytics_events").insert(rows);
  if (error) {
    console.error("[analytics] insert failed:", logSafe(error.message));
    // 503 rather than 500: the client re-queues (bounded at 200) and a later
    // flush succeeds once the migration is applied or the blip passes.
    return res.status(503).json({ error: "Analytics sink unavailable" });
  }

  return res.status(200).json({
    accepted: rows.length,
    rejected: events.length - rows.length,
    ...(Object.keys(rejected).length ? { reasons: rejected } : {}),
  });
}
