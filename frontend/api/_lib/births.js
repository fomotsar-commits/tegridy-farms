// THE BIRTH SOCKET RELAY — our signed hop to the island's enrollment endpoint.
//
//   POST https://memetics.wtf/api/births
//   X-Venue-Signature: <64 lowercase hex> = HMAC-SHA256(secret, raw request body bytes)
//
// ## Why the browser cannot do this itself
//
// The shared secret. One venue, one secret, held server-side and never shipped to a
// client — a signature the browser could produce is a signature anyone can produce, and
// the socket's whole guarantee is that it "answers only a valid signature". So the
// browser posts the six fields here, and THIS file signs them.
//
// ## The four hard facts from the socket's config card, and how each is honoured
//
// 1. SIX KEYS, STRICT. "A seventh field is a 400 naming it, never a silent drop." So we
//    build the outgoing body from an explicit whitelist rather than forwarding what we
//    were given — a client that grows a field must not silently start failing upstream.
//
// 2. SIGN THE EXACT WIRE BYTES. "If your HTTP client re-serializes the JSON between
//    signing and sending, the signature breaks." We serialise ONCE into a Buffer, HMAC
//    that Buffer, and send that same Buffer as the body. `JSON.stringify` is never called
//    twice, and `fetch` is never handed an object.
//
// 3. RETRIES ARE FREE, FOREVER. The same birth answers 200 already_enrolled with the
//    original enrollment_id. So we pass 200 and 202 through as success, and the caller's
//    queue may retry without fear of duplicates.
//
// 4. SHARED RATE LIMIT — /api/* carries 100 requests per minute TOTAL, island-side. Our
//    own global cap here is set well under it so our retry queue can never be the thing
//    that exhausts the island's budget for everybody.
//
// ## Why it lives in the aggregator catchall
//
// Vercel Hobby caps a deployment at 12 serverless functions and we are at 11. Dispatched
// via `?resource=births` behind a lazy dynamic import, so the swap hot path never loads
// it and the function count is unchanged. See api/SERVERLESS_BUDGET.md.

import { createHmac, timingSafeEqual } from "node:crypto";
import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "./bodycap.js";
import { logSafe } from "./logSafe.js";

const BIRTHS_URL = "https://memetics.wtf/api/births";

/** Fast ack is the socket's contract; keep our budget under the platform's. */
const UPSTREAM_TIMEOUT_MS = 6000;

/** The six keys, in the order the card lists them. Nothing else is ever sent. */
const BODY_KEYS = ["ca", "chain", "creator", "birth_block", "gate_decision_id", "record_url"];

const CHAINS = new Set(["base", "ethereum", "solana"]);
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Cap on a single notify body. The six fields are small; anything large is not ours. */
const MAX_BODY_BYTES = 4096;

const ALLOWED_ORIGINS = [
  "https://memetic.fun",
  "https://www.memetic.fun",
  "https://memetics.finance",
  "https://www.memetics.finance",
  "https://tegridyfarms.vercel.app",
];
if (process.env.NODE_ENV === "development") {
  ALLOWED_ORIGINS.push("http://localhost:5173", "http://localhost:3000");
}

/**
 * The hosts a record_url may point at — the hostnames of ALLOWED_ORIGINS, nothing else.
 *
 * Derived rather than written out a second time so adding an origin above cannot leave a
 * venue able to serve the app but unable to sign its own records.
 */
const RECORD_HOSTS = new Set(ALLOWED_ORIGINS.map((o) => new URL(o).hostname));

/**
 * Is this a record_url we are willing to put our venue signature on?
 *
 * Parsed with `new URL` and compared on `hostname` EXACTLY. Never a substring test and
 * never an unanchored regex: `https://memetic.fun.evil.tld/...` contains "memetic.fun",
 * and `includes()` would wave it through. (CodeQL flags that shape at HIGH as
 * js/incomplete-url-substring-sanitization, which is the same defect stated as a rule.)
 *
 * The path must also be the record route for THIS token, so a well-formed pair cannot
 * point the island at some other token's certificate.
 */
function validRecordUrl(rawUrl, chain, ca) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (!RECORD_HOSTS.has(u.hostname)) return false;
  if (u.search || u.hash) return false;
  // `/record/<chain>/<ca>.json` — the exact shape record.js serves.
  const parts = u.pathname.split("/");
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "record") return false;
  if (parts[2] !== chain) return false;
  if (!parts[3].endsWith(".json")) return false;
  const slug = parts[3].slice(0, -".json".length);
  // Per-chain, mirroring record-core.js `normaliseCa` rather than folding both.
  // Solana base58 is CASE-SENSITIVE and uses mixed case meaningfully, so comparing it
  // case-insensitively would let two distinct mints match. EVM hex is case-insensitive
  // and arrives checksummed or lowercased interchangeably, so it must NOT be exact.
  return chain === "solana"
    ? slug === String(ca).trim()
    : slug.toLowerCase() === String(ca).trim().toLowerCase();
}

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/**
 * Is this a well-formed address for this chain?
 *
 * Chain-aware because base58 and hex are different alphabets, and accepting either for
 * either would let a Solana mint be enrolled as an Ethereum contract address.
 */
function validAddress(value, chain) {
  if (typeof value !== "string") return false;
  return chain === "solana" ? SOLANA_ADDRESS_RE.test(value) : ETH_ADDRESS_RE.test(value);
}

/**
 * Validate the six fields BEFORE signing.
 *
 * Rejecting locally rather than letting the island 400 is not politeness — a malformed
 * notify that reaches the socket burns a slot of a rate limit shared with every other
 * request we make, and returns an error our queue would then retry forever.
 *
 * Returns { error, field } or null.
 */
export function validateBirthBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Body must be a JSON object", field: null };
  }
  const extra = Object.keys(body).filter((k) => !BODY_KEYS.includes(k));
  if (extra.length > 0) {
    // Named, never silently dropped — the same contract the socket itself keeps.
    return { error: `Unexpected field: ${extra[0]}`, field: extra[0] };
  }
  for (const k of BODY_KEYS) {
    if (!(k in body)) return { error: `Missing field: ${k}`, field: k };
  }
  if (!CHAINS.has(body.chain)) return { error: "chain must be base, ethereum or solana", field: "chain" };
  if (!validAddress(body.ca, body.chain)) return { error: "ca is not a valid address for this chain", field: "ca" };
  if (!validAddress(body.creator, body.chain)) {
    return { error: "creator is not a valid address for this chain", field: "creator" };
  }
  if (!Number.isInteger(body.birth_block) || body.birth_block < 0) {
    // Chain truth, never approximated: the island anchors the birth from this number.
    return { error: "birth_block must be a non-negative integer", field: "birth_block" };
  }
  if (typeof body.gate_decision_id !== "string" || !body.gate_decision_id) {
    return { error: "gate_decision_id must be a non-empty string", field: "gate_decision_id" };
  }
  if (typeof body.record_url !== "string" || !validRecordUrl(body.record_url, body.chain, body.ca)) {
    // Was: an `^https://` prefix test, which let the venue sign a pointer at ANY host.
    // record.js:2-5 is explicit that the island stores this URL permanently and re-reads
    // it for enrollment, hygiene watch and certification — so a third-party record_url
    // substitutes an attacker-controlled document for the chain-derived one, under our
    // identity, for the life of the enrollment. The venue signs a pointer to its OWN
    // record for THIS token, or it signs nothing.
    return {
      error: "record_url must be an https record URL on this venue for this token",
      field: "record_url",
    };
  }
  return null;
}

/**
 * Serialise the six fields ONCE, in a fixed key order, and return the exact bytes.
 *
 * Exported so a test can prove the signature is taken over the same bytes that are sent.
 * Fixed order because two serialisations of the same object with different key orders are
 * different bytes and therefore different signatures — and the one thing this file cannot
 * afford is for the signed bytes and the sent bytes to be produced by two code paths.
 */
export function canonicalBirthBytes(body) {
  const ordered = {};
  for (const k of BODY_KEYS) ordered[k] = body[k];
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

/** HMAC-SHA256 over the raw bytes, bare lowercase hex, no prefix. */
export function signBirthBytes(secret, bytes) {
  return createHmac("sha256", secret).update(bytes).digest("hex");
}

export async function handleBirths(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // ENFORCE the origin, do not merely advertise it.
  //
  // `setCors` above only SETS Access-Control-Allow-Origin — that is a browser-side
  // control and does nothing to curl. This route dispatches from aggregator.js BEFORE
  // runProxy, so it never inherited aggregator-proxy.js's 403 gate, and everything below
  // (secret, limits, validation, HMAC) was reachable by any unauthenticated client.
  // The socket's entire trust model is "answers only a valid signature", and a signer
  // anyone can reach is a signature anyone can obtain.
  //
  // Placed ABOVE the secret check on purpose: an unauthorized caller must not be able to
  // probe whether MEMETICS_BIRTH_SECRET is configured. Safe for our own client —
  // birthNotify.ts POSTs from the page and browsers attach Origin to every POST,
  // same-origin included.
  const origin = req.headers?.origin || "";
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  const secret = process.env.MEMETICS_BIRTH_SECRET;
  if (!secret) {
    // Explicitly NOT a 500 dressed as success. An unconfigured secret means births are
    // not reaching the island at all, and the caller's queue must keep them so they can
    // be delivered once it is set — the chain and the record are the backfill truth, but
    // only if somebody knows there is a backlog.
    return res.status(503).json({ error: "Birth notify is not configured", code: "no_secret" });
  }

  // Per-IP first, then a global cap set well under the island's shared 100/min so our
  // retry queue can never exhaust their budget for every other call we make.
  const allowed = await checkRateLimit(req, res, { limit: 10, windowSec: 60, identifier: "births" });
  if (!allowed) return;
  const underCap = await checkGlobalLimit(res, {
    limit: Number(process.env.BIRTHS_GLOBAL_RPM) || 40,
    windowSec: 60,
    identifier: "births",
  });
  if (!underCap) return;

  let body = req.body;
  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      return res.status(413).json({ error: "Body too large" });
    }
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Body is not JSON", code: "bad_json", field: null });
    }
  }

  const invalid = validateBirthBody(body);
  if (invalid) {
    return res.status(400).json({ error: invalid.error, code: "invalid_body", field: invalid.field });
  }

  // ONE serialisation. These exact bytes are hashed and these exact bytes are sent.
  const bytes = canonicalBirthBytes(body);
  const signature = signBirthBytes(secret, bytes);

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(BIRTHS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Venue-Signature": signature,
        },
        body: bytes,
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const { text, truncated } = await readBoundedText(resp, MAX_RESPONSE_BYTES);
    let parsed = null;
    if (!truncated && text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    // 202 enrolled and 200 already_enrolled are BOTH success. Collapsing the replay case
    // into an error is what would make a visible-retry queue retry forever on a birth the
    // island already has.
    if (resp.status === 202 || resp.status === 200) {
      return res.status(200).json({
        status: parsed?.status ?? "enrolled",
        enrollment_id: parsed?.enrollment_id ?? null,
        replay: resp.status === 200,
      });
    }

    // 400 is OURS to fix and will never succeed on retry — say so, so the queue can stop
    // rather than grind. 401 likewise: a rotated secret needs an operator, not a retry.
    if (resp.status === 400 || resp.status === 401) {
      return res.status(422).json({
        error: parsed?.error ?? "The island rejected this birth",
        code: parsed?.code ?? "rejected",
        field: parsed?.field ?? null,
        retryable: false,
      });
    }

    return res.status(502).json({ error: "The island's socket is unavailable", retryable: true });
  } catch (err) {
    // AbortError included. An outage is retryable and must say so.
    console.error("births error:", logSafe(err));
    return res.status(502).json({ error: "The island's socket is unavailable", retryable: true });
  }
}

/**
 * Constant-time hex compare, exported for the signature self-test.
 *
 * Not used on the request path (we sign, we do not verify), but the island's card invites
 * a signature self-check and doing that with `===` is how a timing oracle gets introduced
 * to a codebase by accident later.
 */
export function hexEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
