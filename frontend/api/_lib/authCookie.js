// AUDIT FIX FRESH-2026: F-FRESH-4 — shared source-of-truth for the SIWE
// auth-cookie builder + clearer. Previously each endpoint (siwe.js, me.js)
// inlined its own Set-Cookie construction with subtly-divergent gates on the
// `Secure` flag (`buildAuthCookie` checked NODE_ENV + DISABLE_SECURE_COOKIE
// but `buildClearAuthCookie` in siwe.js used DISABLE_SECURE_COOKIE alone, and
// the me.js inline clears used a third shape). Battle-tested pattern: Express
// `res.clearCookie()` and connect-session-cookie-parser mirror the issuance
// flags exactly. Single function, both callers import it.

const COOKIE_NAME = "siwe_jwt";
const COOKIE_PATH = "/";
const COOKIE_SAMESITE = "Strict";

// Match `Secure` flag against the issuance gate: only drop `Secure` in
// non-production AND with the explicit DISABLE_SECURE_COOKIE override. This
// is the canonical mirror — clearing a cookie with different flags than its
// issuance is the drift class that F-FRESH-4 closes.
function isLocalDev() {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.DISABLE_SECURE_COOKIE === "true"
  );
}

/**
 * Build the Set-Cookie value that issues a fresh SIWE JWT.
 * @param {string} jwt the signed JWT
 * @param {number} maxAgeSec lifetime in seconds (caller's choice — typically 24h)
 * @returns {string} Set-Cookie header value
 */
export function buildAuthCookie(jwt, maxAgeSec) {
  if (process.env.NODE_ENV === "production" && process.env.DISABLE_SECURE_COOKIE === "true") {
    console.error("SECURITY WARNING: DISABLE_SECURE_COOKIE=true in production — ignoring. Cookie will use Secure flag.");
  }
  const parts = [
    `${COOKIE_NAME}=${jwt}`,
    `HttpOnly`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${maxAgeSec}`,
    `SameSite=${COOKIE_SAMESITE}`,
  ];
  if (!isLocalDev()) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Build the Set-Cookie value that clears the SIWE JWT. Flags MUST mirror
 * `buildAuthCookie` (browsers match cookies by name+domain+path, but flag
 * symmetry avoids drift confusion for future maintainers).
 * @returns {string} Set-Cookie header value
 */
export function buildClearAuthCookie() {
  const parts = [
    `${COOKIE_NAME}=`,
    `HttpOnly`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=0`,
    `SameSite=${COOKIE_SAMESITE}`,
  ];
  if (!isLocalDev()) parts.push("Secure");
  return parts.join("; ");
}
