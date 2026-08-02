// ═══ /api/auth/me — Session Validation Endpoint ═══
// Reads the httpOnly siwe_jwt cookie, verifies it, and returns session info.
// This lets the client check auth status without ever touching the JWT directly.

import { jwtVerify } from "jose";
import { createClient } from "@supabase/supabase-js";
import { checkRateLimit } from "../_lib/ratelimit.js";
// AUDIT FIX FRESH-2026: F-FRESH-4 — shared cookie builder (DRY mirror of siwe.js).
import { buildClearAuthCookie } from "../_lib/authCookie.js";

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// AUDIT API-SEC-LOGOUT: we consult revoked_jwts on every authenticated
// /me call to enforce server-side logout. If Supabase isn't wired up,
// the check is skipped and we fall back to JWT-signature-only auth —
// matches pre-logout-revocation behavior and keeps /me responsive when
// the DB is the thing that's degraded.
// AUDIT FIX FRESH-2026: F9 — fail closed in production when SUPABASE_SERVICE_KEY
//         is missing. Pre-fix the revocation check was silently skipped on a
//         misconfigured prod deploy (or a partial-rollback that dropped the
//         env var) — a stolen token that the user logged out hours ago stayed
//         valid until 24h `exp`. Mirror siwe.js:150-152's hard-503 posture so
//         the misconfiguration is loud at startup, not silent at auth time.
const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

// AUDIT FIX FRESH-2026: F-FRESH-1 + F-FRESH-2 — read NODE_ENV / VERCEL_ENV
//         per-request (not at module load) so a config change takes effect
//         without a cold-start, and so Vercel preview deploys that inherit
//         prod env vars but have NODE_ENV unset still fail closed. Mirrors
//         supabase-proxy.js:182's per-request shape.
function isRevocationRequired() {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "preview" ||
    process.env.VERCEL_ENV === "production"
  );
}

// AUDIT R050 MED + R052 077: env-driven allowlist; no hardcoded
// `nakamigos.gallery` fallback. Production hosts + dev localhost form the
// default; ALLOWED_ORIGINS=foo,bar extends without redeploy.
function buildAllowedOrigins() {
  const set = new Set([
    "https://nakamigos.gallery",
    "https://www.nakamigos.gallery",
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
  // AUDIT R050: Vary always, ACAO + ACAC only when origin is allowlisted.
  res.setHeader("Vary", "Origin");
  if (allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function parseSiweJwt(req) {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;\s*)siwe_jwt=([^;]*)/);
  return match ? match[1] : null;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // AUDIT R052 077: 60/min/IP. /me is a read-only signature-+-Supabase-
  // lookup; per-IP keying is correct because the cookie may be missing or
  // invalid before rate-check, so wallet-keyed limiting isn't available.
  const rlOk = await checkRateLimit(req, res, {
    limit: 60, windowSec: 60, identifier: "auth-me",
  });
  if (!rlOk) return;

  if (!JWT_SECRET) {
    return res.status(503).json({ error: "Auth service not configured" });
  }
  // AUDIT FIX FRESH-2026: F9 — refuse to authenticate in prod / preview when
  //         the revocation lookup cannot run. Closes the silent fail-open where
  //         a missing SUPABASE_SERVICE_KEY left logout-revocation inert.
  if (isRevocationRequired() && supabase === null) {
    return res.status(503).json({ error: "Auth service not configured" });
  }

  const token = parseSiweJwt(req);
  if (!token) {
    return res.json({ authenticated: false });
  }

  try {
    const secret = new TextEncoder().encode(JWT_SECRET);
    // AUDIT API-H2: pin algorithm list. jose v5 defaults reject "none" but
    // explicit pinning defends against future algorithm-confusion attacks if
    // the same JWT_SECRET is ever reused across HS256/RS256 boundaries.
    const { payload } = await jwtVerify(token, secret, {
      issuer: "supabase",
      audience: "authenticated",
      algorithms: ["HS256"],
    });

    // AUDIT API-SEC-LOGOUT: reject revoked JWTs. Tokens issued after the
    // 003_revoked_jwts.sql migration carry a jti claim; on logout we write
    // jti into revoked_jwts. Legacy tokens (pre-migration) have no jti and
    // skip this check — they age out at their 24h exp.
    if (supabase && payload.jti) {
      const { data: revoked, error: revokedErr } = await supabase
        .from("revoked_jwts")
        .select("jti")
        .eq("jti", String(payload.jti))
        .maybeSingle();
      if (revokedErr) {
        console.error("[me] revoked_jwts lookup error:", revokedErr.message);
        // Fail open on DB hiccup — the cost of false-negative auth here is
        // one more /me call that returns authenticated=true for a token
        // that was logged-out. Cookie is still cleared on the client so
        // exposure window is only until next JS re-check.
      } else if (revoked) {
        // Token was explicitly revoked. Treat as unauthenticated and clear
        // the cookie so the browser stops sending it.
        // AUDIT FIX FRESH-2026: F-FRESH-4 — use shared cookie builder so
        //         Secure-flag semantics match siwe.js issuance exactly.
        res.setHeader("Set-Cookie", buildClearAuthCookie());
        return res.json({ authenticated: false });
      }
    }

    return res.json({
      authenticated: true,
      wallet: payload.wallet || payload.sub,
      expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
    });
  } catch {
    // Token invalid or expired — clear the stale cookie.
    // AUDIT FIX FRESH-2026: F-FRESH-4 — use shared cookie builder so
    //         Secure-flag semantics match siwe.js issuance exactly.
    res.setHeader("Set-Cookie", buildClearAuthCookie());

    return res.json({ authenticated: false });
  }
}
