// ═══ /api/auth/me — Session Validation Endpoint ═══
// Reads the httpOnly siwe_jwt cookie, verifies it, and returns session info.
// This lets the client check auth status without ever touching the JWT directly.

import { jwtVerify } from "jose";

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

const ALLOWED_ORIGINS = new Set([
  "https://nakamigos.gallery",
  "https://www.nakamigos.gallery",
  "https://tegridyfarms.vercel.app",
]);
if (process.env.NODE_ENV !== "production") {
  ALLOWED_ORIGINS.add("http://localhost:8742");
  ALLOWED_ORIGINS.add("http://localhost:3000");
  ALLOWED_ORIGINS.add("http://localhost:5173");
}

function setCors(req, res) {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS.has(origin) ? origin : "https://nakamigos.gallery");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Vary", "Origin");
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

  if (!JWT_SECRET) {
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

    return res.json({
      authenticated: true,
      wallet: payload.wallet || payload.sub,
      expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
    });
  } catch {
    // Token invalid or expired — clear the stale cookie
    const isProduction = process.env.NODE_ENV === "production";
    const clearParts = [
      `siwe_jwt=`,
      `HttpOnly`,
      `Path=/`,
      `Max-Age=0`,
      `SameSite=Lax`,
    ];
    if (isProduction) clearParts.push("Secure");
    res.setHeader("Set-Cookie", clearParts.join("; "));

    return res.json({ authenticated: false });
  }
}
