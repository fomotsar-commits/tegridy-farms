// ═══ SIWE (Sign-In with Ethereum) AUTH ENDPOINT ═══
// Implements EIP-4361 authentication for Supabase.
// GET  ?action=nonce    → generate single-use nonce
// POST { message, sig } → verify signature, set httpOnly JWT cookie
// DELETE                 → clear auth cookie (logout)
//
// The JWT is stored in an httpOnly cookie — never exposed to client JS.
// It contains a `wallet` claim used by Supabase RLS policies
// to enforce row-level ownership (e.g., wallet = jwt.wallet).
//
// CSRF threat model (R052 M-076-3):
//   The POST verify-signature endpoint cannot fall victim to classic CSRF
//   because issuance requires:
//     1. SameSite=Strict on the issued cookie (prevents cross-site reuse).
//     2. A valid SIWE signature over a server-issued single-use nonce —
//        the nonce IS the CSRF token; an attacker can't forge one without
//        a fresh GET ?action=nonce + the user's wallet to sign it.
//     3. Origin-pinned credentialed CORS (env-driven allowlist below).
//     4. Required Origin header (M-076-2 fix) — the parsed Origin host is
//        used as the SIWE message's domain claim, so a missing or non-
//        allowlisted Origin fails closed before any signature work.

import { createClient } from "@supabase/supabase-js";
import { SiweMessage } from "siwe";
import { SignJWT, jwtVerify } from "jose";
import { randomUUID } from "crypto";
import { checkRateLimit } from "../_lib/ratelimit.js";

// AUDIT R052 H-076-1: cap Vercel body parser at 8 KB. The verify POST body
// is just `{ message, signature }`; both are bounded — anything over 8 KB
// is either a bug or abuse.
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "8kb",
    },
  },
};

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const TOKEN_EXPIRY_HOURS = 24;
// AUDIT R052 H-076-1: cap message expirationTime at 15 min from now. A
// nonce already expires in 5 min so anything longer has no use.
const MAX_MESSAGE_TTL_MS = 15 * 60 * 1000;

// AUDIT R050 MED + R052 M-076-2: env-driven allowlist; no hardcoded
// `nakamigos.gallery` fallback. Production hosts are in the default set;
// `ALLOWED_ORIGINS=foo,bar` extends without redeploy.
function buildAllowedOrigins() {
  const set = new Set([
    "https://tegridyfarms.xyz",
    "https://www.tegridyfarms.xyz",
    "https://nakamigos.gallery",
    "https://www.nakamigos.gallery",
    "https://tegridyfarms.vercel.app",
  ]);
  if (process.env.NODE_ENV === "development") {
    set.add("http://localhost:8742");
    set.add("http://localhost:3000");
    set.add("http://localhost:5173");
  }
  const env = process.env.ALLOWED_ORIGINS;
  if (env) {
    for (const o of env.split(",").map((s) => s.trim()).filter(Boolean)) {
      set.add(o);
    }
  }
  return set;
}

function setCors(req, res) {
  const origin = req.headers.origin || "";
  const allowed = buildAllowedOrigins();
  // AUDIT R050: Vary: Origin always set; ACAO + ACAC only when origin is
  // allowlisted (fail-closed credentialed CORS — no nakamigos fallback).
  res.setHeader("Vary", "Origin");
  if (allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/**
 * Build a Set-Cookie header value for the SIWE JWT.
 * httpOnly + Secure + SameSite=Lax prevents XSS token theft while allowing
 * same-site navigations to send the cookie automatically.
 */
function buildAuthCookie(token, maxAgeSeconds) {
  // SECURITY FIX: Default to Secure=true, only disable for localhost development.
  // Use NODE_ENV check as primary guard; DISABLE_SECURE_COOKIE as explicit override.
  const isLocalDev = process.env.NODE_ENV !== "production" && process.env.DISABLE_SECURE_COOKIE === "true";
  if (process.env.NODE_ENV === "production" && process.env.DISABLE_SECURE_COOKIE === "true") {
    console.error("SECURITY WARNING: DISABLE_SECURE_COOKIE=true in production — ignoring. Cookie will use Secure flag.");
  }
  const parts = [
    `siwe_jwt=${token}`,
    `HttpOnly`,
    `Path=/`,
    `Max-Age=${maxAgeSeconds}`,
    // AUDIT API-M8: SameSite=Strict (was Lax) to eliminate top-level
    // cross-site navigation cookie leakage. Users following a deep-link
    // from an external origin will need to re-authenticate on first nav
    // — acceptable for an app-level auth cookie.
    `SameSite=Strict`,
  ];
  if (!isLocalDev) parts.push("Secure");
  return parts.join("; ");
}

function buildClearAuthCookie() {
  const isLocalDev = process.env.DISABLE_SECURE_COOKIE === "true";
  const parts = [
    `siwe_jwt=`,
    `HttpOnly`,
    `Path=/`,
    `Max-Age=0`,
    // AUDIT API-M8: SameSite=Strict (was Lax) to eliminate top-level
    // cross-site navigation cookie leakage. Users following a deep-link
    // from an external origin will need to re-authenticate on first nav
    // — acceptable for an app-level auth cookie.
    `SameSite=Strict`,
  ];
  if (!isLocalDev) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Parse the siwe_jwt cookie from the Cookie header.
 */
function parseSiweJwt(req) {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;\s*)siwe_jwt=([^;]*)/);
  return match ? match[1] : null;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!supabase || !JWT_SECRET) {
    return res.status(503).json({ error: "Auth service not configured" });
  }

  // ── GET: Generate nonce ──
  if (req.method === "GET" && req.query.action === "nonce") {
    // AUDIT API-M1: nonce generation writes to the DB; rate-limit to 10/min
    // per IP. A legitimate user calls this at most once per login attempt;
    // higher rates are either retry-bombs or abuse.
    const allowed = await checkRateLimit(req, res, {
      limit: 10, windowSec: 60, identifier: "siwe-nonce",
    });
    if (!allowed) return;

    const nonce = randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + NONCE_TTL_MS).toISOString();

    // Store nonce in DB (service_role only table)
    const { error } = await supabase.from("siwe_nonces").insert({ nonce, expires_at: expiresAt });
    if (error) {
      console.error("Nonce storage error:", error.message);
      return res.status(500).json({ error: "Failed to generate nonce" });
    }

    // Clean up expired nonces opportunistically
    await supabase.from("siwe_nonces").delete().lt("expires_at", new Date().toISOString()).catch(() => {});

    return res.json({ nonce, expiresAt });
  }

  // ── POST: Verify signature + issue JWT ──
  if (req.method === "POST") {
    // AUDIT API-M1: signature verification + JWT issuance is the most
    // expensive auth op. 10 attempts/min/IP is more than enough for a
    // real user who might typo-fail once or twice; blocks online
    // brute-force against stolen nonces.
    const allowed = await checkRateLimit(req, res, {
      limit: 10, windowSec: 60, identifier: "siwe-verify",
    });
    if (!allowed) return;

    // AUDIT R052 M-076-2: Origin parsing hoisted ABOVE message construction.
    // Missing Origin → 400 (CLI tools, server-to-server). Non-allowlisted
    // Origin → 403. The parsed host is used as the SIWE message domain
    // for verification, so we fail closed before any signature work.
    const origin = req.headers.origin || "";
    if (!origin) {
      return res.status(400).json({ error: "Origin header required" });
    }
    const allowedOriginsSet = buildAllowedOrigins();
    if (!allowedOriginsSet.has(origin)) {
      return res.status(403).json({ error: "Origin not allowed" });
    }
    let originHost;
    try { originHost = new URL(origin).host; } catch {
      return res.status(400).json({ error: "Invalid Origin header" });
    }

    const { message, signature } = req.body || {};
    if (!message || !signature) {
      return res.status(400).json({ error: "Missing message or signature" });
    }

    let siweMessage;
    try {
      siweMessage = new SiweMessage(message);
    } catch {
      return res.status(400).json({ error: "Invalid SIWE message format" });
    }

    // Validate domain
    const allowedDomains = [...allowedOriginsSet].map(u => new URL(u).host);
    if (!allowedDomains.includes(siweMessage.domain)) {
      return res.status(403).json({ error: "Domain mismatch" });
    }

    // AUDIT R052 M-076-1: validate siweMessage.uri host against the same
    // allowlist. Closes the phishing UX gap where a relay surfaces a
    // third-party uri to the user's wallet UI.
    if (!siweMessage.uri) {
      return res.status(400).json({ error: "InvalidMessage: uri required" });
    }
    let uriHost;
    try { uriHost = new URL(siweMessage.uri).host; } catch {
      return res.status(400).json({ error: "InvalidMessage: malformed uri" });
    }
    if (!allowedDomains.includes(uriHost)) {
      return res.status(403).json({ error: "URI host mismatch" });
    }

    // Validate chain (mainnet only)
    if (siweMessage.chainId !== 1) {
      return res.status(400).json({ error: "Only Ethereum mainnet (chainId 1) is supported" });
    }

    // AUDIT R052 H-076-1: require expirationTime + notBefore on the parsed
    // SIWE message. Both must be valid ISO 8601, expirationTime must be
    // future and within MAX_MESSAGE_TTL_MS, notBefore must be in the past.
    if (!siweMessage.expirationTime) {
      return res.status(400).json({ error: "InvalidMessage: expirationTime required" });
    }
    if (!siweMessage.notBefore) {
      return res.status(400).json({ error: "InvalidMessage: notBefore required" });
    }
    const expMs = Date.parse(siweMessage.expirationTime);
    const nbMs = Date.parse(siweMessage.notBefore);
    if (!Number.isFinite(expMs)) {
      return res.status(400).json({ error: "InvalidMessage: expirationTime malformed" });
    }
    if (!Number.isFinite(nbMs)) {
      return res.status(400).json({ error: "InvalidMessage: notBefore malformed" });
    }
    const nowMs = Date.now();
    if (expMs <= nowMs) {
      return res.status(400).json({ error: "InvalidMessage: expirationTime in the past" });
    }
    if (expMs - nowMs > MAX_MESSAGE_TTL_MS) {
      return res.status(400).json({ error: "InvalidMessage: expirationTime too far in future (max 15 min)" });
    }
    if (nbMs > nowMs) {
      return res.status(400).json({ error: "InvalidMessage: notBefore in the future" });
    }

    // AUDIT API-SEC-NONCE-RACE: atomically claim the nonce before doing any
    // signature work. Two concurrent verify requests used to both SELECT the
    // same row, both verify, and both issue JWTs; now whoever wins the
    // DELETE claims the nonce and the loser sees an empty result.
    //
    // We predicate the DELETE on `expires_at > now` so an expired nonce is
    // never consumed (the opportunistic cleanup in the nonce endpoint will
    // sweep it on the next request).
    //
    // Note: this consumes the nonce *before* signature verification. If the
    // signature is bad, the nonce is gone and the user must request a new
    // one — the standard SIWE single-use semantics.
    const { data: claimedRows, error: claimErr } = await supabase
      .from("siwe_nonces")
      .delete()
      .eq("nonce", siweMessage.nonce)
      .gt("expires_at", new Date().toISOString())
      .select("nonce, expires_at");

    if (claimErr) {
      console.error("Nonce claim error:", claimErr.message);
      return res.status(500).json({ error: "Auth service error" });
    }
    if (!claimedRows || claimedRows.length === 0) {
      return res.status(400).json({ error: "Invalid or expired nonce" });
    }

    // Verify the SIWE signature.
    // AUDIT API-H1: pass explicit time + domain + nonce into verify() so that
    // siwe-library enforces freshness against the server's clock (not just the
    // message's own optional expirationTime), and rebinds the message to the
    // origin domain + the server-issued nonce as part of signature verification.
    let verifyResult;
    try {
      verifyResult = await siweMessage.verify({
        signature,
        time: new Date().toISOString(),
        domain: originHost,
        nonce: siweMessage.nonce,
      });
    } catch (err) {
      return res.status(400).json({ error: "Signature verification failed" });
    }

    if (!verifyResult.success) {
      return res.status(403).json({ error: "Invalid signature" });
    }

    // Issue custom JWT for Supabase.
    // AUDIT API-SEC-LOGOUT: every token now carries a random `jti` so we
    // can revoke individual sessions server-side on logout. Without jti
    // the logout endpoint could only clear the cookie — a stolen copy of
    // the token stayed valid for the remainder of its 24h lifetime.
    const wallet = siweMessage.address.toLowerCase();
    const now = Math.floor(Date.now() / 1000);
    const exp = now + TOKEN_EXPIRY_HOURS * 3600;
    const jti = randomUUID();

    const secret = new TextEncoder().encode(JWT_SECRET);
    const token = await new SignJWT({
      sub: wallet,
      wallet,
      role: "authenticated",
      aud: "authenticated",
      jti,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .setIssuer("supabase")
      .sign(secret);

    // Set JWT as httpOnly cookie — never exposed to client-side JS
    const maxAge = TOKEN_EXPIRY_HOURS * 3600;
    res.setHeader("Set-Cookie", buildAuthCookie(token, maxAge));

    // Return wallet + expiry (non-sensitive) but NOT the token itself
    return res.json({
      wallet,
      expiresAt: new Date(exp * 1000).toISOString(),
    });
  }

  // ── DELETE: Logout — clear the auth cookie AND revoke the JWT ──
  // AUDIT R052 L-076-4: verify (not decode) the JWT before writing to
  // revoked_jwts. Without signature verification, an attacker could
  // spam the revoked_jwts table with arbitrary jti claims (storage DoS).
  // 5/min rate limit caps legitimate "log out / log back in" cycles.
  if (req.method === "DELETE") {
    const logoutOk = await checkRateLimit(req, res, {
      limit: 5, windowSec: 60, identifier: "siwe-logout",
    });
    if (!logoutOk) return;

    const token = parseSiweJwt(req);
    if (token && supabase) {
      try {
        const secret = new TextEncoder().encode(JWT_SECRET);
        const { payload } = await jwtVerify(token, secret, {
          issuer: "supabase",
          audience: "authenticated",
          algorithms: ["HS256"],
        });
        if (payload?.jti && payload?.exp && Number(payload.exp) > Math.floor(Date.now() / 1000)) {
          await supabase.from("revoked_jwts").insert({
            jti: String(payload.jti),
            exp: new Date(Number(payload.exp) * 1000).toISOString(),
          }).then((r) => {
            // ON CONFLICT DO NOTHING — double-logout is idempotent.
            if (r.error && !/duplicate key/i.test(r.error.message)) {
              console.error("Revoke insert error:", r.error.message);
            }
          });
        }
        // Opportunistic cleanup; ignore errors.
        void supabase.rpc("prune_revoked_jwts").catch(() => {});
      } catch {
        // Invalid signature / expired token — silently drop. Cookie still
        // cleared below; no DB write for forged cookies (R052 L-076-4).
      }
    }
    res.setHeader("Set-Cookie", buildClearAuthCookie());
    return res.json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
