// AUDIT R057 (LOW/INFO): defense-in-depth log sanitizer.
//
// Purpose: scrub secrets from `console.error` output across api/ handlers.
// The findings that drove this:
//   - siwe.js logs `supabase err.message` — could leak constraint/schema hints
//   - ratelimit.js logs `upstash err.message` — could surface URL+token if a
//     future @upstash client formatter changes its toString()
//   - orderbook.js logs `RPC err.message` — defense-in-depth gap if Alchemy
//     URL or auth token ever stringifies into errors
//   - errorReporting.ts already redacts hex-y secrets but NOT key-name patterns
//     like `apiKey=...` or `Authorization: Bearer ...`
//
// Pattern modeled after Sentry's default scrubber: redact by KEY-NAME for the
// common secret header / query / json field names.
//
// Usage:
//   import { logSafe } from './_lib/logSafe.js';
//   try { ... } catch (err) { console.error('label', logSafe(err)); }

// ── Secret value patterns ─────────────────────────────────────────────
// 64-hex (private keys, signed-message digests, sometimes API tokens)
const HEX_64 = /\b0x?[0-9a-fA-F]{64}\b/g;
// 40-hex wallet addresses (de-anonymising even if not strictly secret)
const HEX_40 = /\b0x[0-9a-fA-F]{40}\b/g;
// JWTs (header.payload.signature — eyJ prefix on b64 header)
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
// Bearer tokens
const BEARER = /\b[Bb]earer\s+[A-Za-z0-9._\-+/=]+/g;
// 12-24 word BIP-39 mnemonics
const MNEMONIC = /\b(?:[a-z]{3,12}\s+){11,23}[a-z]{3,12}\b/gi;

// ── Secret KEY-NAME regex (Sentry default style) ──────────────────────
// Used both for HTTP-header-like text and JSON keys.
// Matches: authorization, cookie, x-api-key, api_key, apiKey, api-key,
// secret, token, password, set-cookie, auth.
const SECRET_KEY_RE = /^(authorization|cookie|set-cookie|x[-_]api[-_]?key|api[_-]?key|secret|token|password|auth)$/i;

// Looser version used inside free-text scans — matches "key=value" pairs.
// Captures the key in group 1 and the value in group 2.
// Permits `apikey`, `api_key`, `apiKey`, `api-key`, `authorization`, etc.
const SECRET_KV_RE =
  /\b(authorization|cookie|set-cookie|x[-_]api[-_]?key|api[_-]?key|secret|token|password|auth)\s*[:=]\s*([^\s,;&"']+)/gi;

// Querystring-style: `?key=value` or `&key=value` — same key set, but
// require the leading `?` or `&` so we don't double-redact body kv.
// Not strictly needed (URL parser handles it) but covers free-form URL
// strings that aren't valid URL() inputs.
const SECRET_QS_RE =
  /([?&])(authorization|cookie|x[-_]api[-_]?key|api[_-]?key|secret|token|password|auth)=([^&\s"']+)/gi;

const REDACTED = '[REDACTED]';
const MAX_OUTPUT_LEN = 2000;

/**
 * Sanitize a free-form string. Order matters: redact specific high-confidence
 * patterns first (JWT, bearer, hex), then key=value, then leftover query strings.
 */
function sanitizeString(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  let out = s;
  // Specific token formats first (highest confidence).
  out = out.replace(JWT, REDACTED);
  out = out.replace(BEARER, 'Bearer ' + REDACTED);
  out = out.replace(HEX_64, REDACTED);
  out = out.replace(MNEMONIC, REDACTED);
  // Now key=value patterns — redact only the value, keep the key for debugging.
  out = out.replace(SECRET_KV_RE, (_m, k) => `${k}=${REDACTED}`);
  // Querystring fallback (handles URLs already failed to parse).
  out = out.replace(SECRET_QS_RE, (_m, sep, k) => `${sep}${k}=${REDACTED}`);
  // Wallet addresses last (lowest priority — they may legitimately appear).
  out = out.replace(HEX_40, '0x' + REDACTED);
  // URLs: try to parse-and-redact querystrings even if not in `?key=value` form.
  out = redactUrlsInString(out);
  return out;
}

// AUDIT R048: API-key path-segment shape. Alchemy v1/Etherscan v1 used to
// embed the key as a URL path segment (e.g.
// `https://eth-mainnet.g.alchemy.com/nft/v3/<KEY>/getFloorPrice`). Even though
// R048 moved auth to `Authorization: Bearer`, a future regression — or a
// stale cached error message from the pre-R048 era — could still surface
// the legacy URL shape. Redact any all-caps/digit/underscore segment of
// length ≥ 20 inside an https URL path. This intentionally matches the
// Alchemy / Etherscan / OpenSea key alphabet without touching short slugs.
const KEY_SHAPE_PATH_SEG = /^[A-Z0-9_]{20,}$/;

/**
 * Find URL-like substrings and redact secret-named query params via the URL
 * parser. Catches URLs embedded in larger error messages that the regex
 * approach above might miss (e.g., URLs with non-standard separators).
 */
function redactUrlsInString(s) {
  // Match http/https URLs greedily up to whitespace or quotes.
  return s.replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
    try {
      const u = new URL(raw);
      const params = u.searchParams;
      const keys = [...params.keys()];
      for (const k of keys) {
        if (SECRET_KEY_RE.test(k)) {
          params.set(k, REDACTED);
        }
      }
      // Also redact userinfo (`https://user:pass@host`) — the password slot
      // is a classic credential leak.
      if (u.password) u.password = REDACTED;
      if (u.username && /^(token|key|secret|api)/i.test(u.username)) {
        u.username = REDACTED;
      }
      // AUDIT R048: scrub key-shaped URL path segments (legacy Alchemy /
      // Etherscan v1 path-embedded keys).
      if (u.pathname && u.pathname.includes('/')) {
        const segs = u.pathname.split('/').map((seg) =>
          KEY_SHAPE_PATH_SEG.test(seg) ? REDACTED : seg
        );
        u.pathname = segs.join('/');
      }
      return u.toString();
    } catch {
      return raw;
    }
  });
}

/**
 * Recursively redact key/value pairs in a plain-object / array structure.
 * Returns a NEW object — does not mutate input. Cycle-safe.
 */
function sanitizeObject(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => sanitizeObject(v, seen));
  }

  const out = {};
  for (const k of Object.keys(value)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = sanitizeObject(value[k], seen);
    }
  }
  return out;
}

/**
 * Circular-safe JSON stringify with redaction. Used for non-Error inputs.
 */
function safeStringify(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (key, val) => {
      // Redact by key-name on JSON serialization too — covers nested fields.
      if (typeof key === 'string' && SECRET_KEY_RE.test(key)) {
        return REDACTED;
      }
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      if (typeof val === 'string') return sanitizeString(val);
      return val;
    });
  } catch {
    // Fallback if stringify itself throws (BigInt, exotic prototypes, etc.)
    try { return sanitizeString(String(value)); } catch { return '[Unserializable]'; }
  }
}

/**
 * Convert any thrown value into a sanitized string suitable for logging.
 *
 * Behavior:
 *   - Error instance → sanitized `.message` (preserves debug value, drops secrets)
 *   - Object         → sanitized JSON.stringify (cycle-safe, key-name redacted)
 *   - Primitive      → sanitized String(value)
 *   - undefined/null → '[no error]'
 *
 * Output capped at MAX_OUTPUT_LEN to avoid runaway log lines.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function logSafe(err) {
  if (err === null || err === undefined) return '[no error]';

  let raw;
  if (err instanceof Error) {
    raw = err.message ? sanitizeString(err.message) : err.name || 'Error';
  } else if (typeof err === 'string') {
    raw = sanitizeString(err);
  } else if (typeof err === 'object') {
    const e = /** @type {any} */ (err);
    // If the object carries secret-named fields, serialize the whole thing
    // through key-redaction so we don't drop the redacted view by preferring
    // .message. Otherwise prefer .message (covers PostgrestError shape).
    const hasSecretKey = Object.keys(e).some((k) =>
      /^(authorization|cookie|set-cookie|x[-_]api[-_]?key|api[_-]?key|secret|token|password|auth)$/i.test(k)
    );
    if (!hasSecretKey && typeof e.message === 'string') {
      raw = sanitizeString(e.message);
    } else {
      raw = safeStringify(sanitizeObject(err));
    }
  } else {
    raw = sanitizeString(String(err));
  }

  if (typeof raw !== 'string') raw = String(raw);
  if (raw.length > MAX_OUTPUT_LEN) raw = raw.slice(0, MAX_OUTPUT_LEN) + '…';
  return raw;
}

// Internal helpers exposed for unit testing.
export const __test__ = {
  sanitizeString,
  sanitizeObject,
  safeStringify,
  redactUrlsInString,
  SECRET_KEY_RE,
};
