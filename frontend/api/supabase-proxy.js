/**
 * Supabase Write Proxy — forwards SIWE JWT from httpOnly cookie to Supabase
 *
 * The SIWE JWT is stored in an httpOnly cookie (inaccessible to client JS).
 * This proxy reads the cookie, sets it as Supabase's Authorization header,
 * and forwards the request to Supabase's PostgREST API.
 *
 * POST /api/supabase-proxy
 * Body: { table, method, body, match }
 *   - table: "messages" | "user_profiles" | "user_favorites" | "user_watchlist" | "votes"
 *   - method: "INSERT" | "UPDATE" | "DELETE" | "UPSERT"
 *   - body: the row data
 *   - match: (optional) filter for UPDATE/DELETE, e.g. { wallet: "0x..." }
 */

import { jwtVerify } from "jose";
import { checkRateLimit } from "./_lib/ratelimit.js";
import { validateBody } from "./_lib/proxy-schemas.js";

// AUDIT R051 H-2: cap Vercel body parser at 32 KB. The largest legitimate
// row in any of the allowed tables is `messages.text` at 280 chars, so 32 KB
// is comfortably above any real payload while protecting against
// deeply-nested JSON CPU DoS.
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "32kb",
    },
  },
};

const ALLOWED_TABLES = ["messages", "user_profiles", "user_favorites", "user_watchlist", "votes"];

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

// AUDIT R050 MED: env-driven CORS allowlist. Production hosts are hardcoded
// for the common case; ALLOWED_ORIGINS=foo,bar lets ops extend without a
// redeploy. Fail-closed: an origin not in the set gets neither ACAO nor ACAC.
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
  const origin = req.headers?.origin || "";
  const allowed = buildAllowedOrigins();
  // AUDIT R050 + R053 LOW: Vary: Origin is set unconditionally so any
  // intermediary cache keys responses by origin.
  res.setHeader("Vary", "Origin");
  if (allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

export default async function handler(req, res) {
  setCors(req, res);

  // AUDIT R050 MED: OPTIONS preflight — return 200 before auth checks.
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // AUDIT R051 M: stage-1 IP baseline. Cheap throttle that gates the
  // JWT-verify CPU cost; runs before any auth work. 50/min/IP is generous
  // for a co-located NAT cluster while still slowing brute-force attempts.
  const stage1Ok = await checkRateLimit(req, res, {
    limit: 50, windowSec: 60, identifier: "supabase-proxy-ip",
  });
  if (!stage1Ok) return;

  // Extract SIWE JWT from httpOnly cookie
  const jwt = parseCookie(req.headers.cookie, "siwe_jwt");
  if (!jwt) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const { table, method, match } = req.body || {};
  let body = req.body?.body;

  // Validate table name (prevent injection)
  if (!table || !ALLOWED_TABLES.includes(table)) {
    return res.status(400).json({ error: "Invalid table" });
  }

  if (!method || !["INSERT", "UPDATE", "DELETE", "UPSERT"].includes(method)) {
    return res.status(400).json({ error: "Invalid method" });
  }

  // AUDIT API-M8: decode the SIWE JWT so we can enforce wallet/author match
  // on write-bodies below. Signature verification lives here — we don't want
  // to trust an unverified wallet claim from a tampered cookie. On failure
  // return the same 401 shape we return for a missing cookie.
  let jwtClaims = null;
  let verifiedWallet = null;
  if (JWT_SECRET) {
    try {
      const secret = new TextEncoder().encode(JWT_SECRET);
      const { payload } = await jwtVerify(jwt, secret, {
        issuer: "supabase",
        audience: "authenticated",
        algorithms: ["HS256"],
      });
      jwtClaims = { wallet: payload.wallet || payload.sub };
      verifiedWallet = jwtClaims.wallet ? String(jwtClaims.wallet).toLowerCase() : null;
    } catch {
      return res.status(401).json({ error: "Not authenticated" });
    }
  }

  // AUDIT R051 M: stage-2 write bucket — keyed on verified wallet so a NAT
  // cluster doesn't share one budget. Falls back to IP only when JWT verify
  // is skipped (no SUPABASE_JWT_SECRET — non-prod only).
  const stage2Ok = await checkRateLimit(req, res, {
    limit: 20, windowSec: 60, identifier: "supabase-proxy",
    walletAddress: verifiedWallet,
  });
  if (!stage2Ok) return;

  // AUDIT API-M8: shape-validate write bodies before we ever touch upstream.
  // DELETE has no body and is skipped; reads don't hit this endpoint at all.
  if (method === "INSERT" || method === "UPSERT" || method === "UPDATE") {
    const result = validateBody(table, method, body, jwtClaims);
    if (!result.ok) return res.status(400).json({ error: result.error });
    body = result.data;
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(500).json({ error: "Supabase not configured" });
  }

  // Build PostgREST request
  let url = `${supabaseUrl}/rest/v1/${table}`;
  const headers = {
    "apikey": supabaseAnonKey,
    "Authorization": `Bearer ${jwt}`,
    "Content-Type": "application/json",
    "Prefer": method === "UPSERT" ? "resolution=merge-duplicates" : "return=representation",
  };

  // AUDIT API-M2: whitelist match-value characters. Raw interpolation at
  // `eq.${value}` into a PostgREST filter was load-bearing on RLS for real
  // security, but future PostgREST versions could treat combinations like
  // `(`, `)`, `,`, `*`, `:` as operators. Reject anything that isn't a safe
  // column-value literal up-front so the attack surface stays at the RLS
  // layer, not the URL-builder layer.
  const SAFE_MATCH_VALUE = /^[0-9a-zA-Z_.-]{1,256}$/;
  function buildMatchParams(matchObj) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(matchObj)) {
      const str = String(value);
      if (!SAFE_MATCH_VALUE.test(str)) {
        return { error: "Invalid match value" };
      }
      // Also reject column names with anything but [A-Za-z0-9_] — column
      // names should never contain URL-encodable chars.
      if (!/^[A-Za-z0-9_]{1,64}$/.test(key)) {
        return { error: "Invalid match column" };
      }
      params.set(key, `eq.${str}`);
    }
    return { params };
  }

  let fetchMethod;
  let fetchBody;

  switch (method) {
    case "INSERT":
    case "UPSERT":
      fetchMethod = "POST";
      fetchBody = JSON.stringify(body);
      break;
    case "UPDATE":
      fetchMethod = "PATCH";
      fetchBody = JSON.stringify(body);
      if (match) {
        const { params, error } = buildMatchParams(match);
        if (error) return res.status(400).json({ error });
        url += `?${params.toString()}`;
      }
      break;
    case "DELETE":
      fetchMethod = "DELETE";
      if (match) {
        const { params, error } = buildMatchParams(match);
        if (error) return res.status(400).json({ error });
        url += `?${params.toString()}`;
      }
      break;
  }

  try {
    const response = await fetch(url, {
      method: fetchMethod,
      headers,
      body: fetchBody,
    });

    const text = await response.text();
    const status = response.status;

    if (status >= 400) {
      // AUDIT API-M4: don't leak Supabase error bodies (schema info,
      // constraint names, PostgREST internals). Map 5xx to opaque 502 and
      // collapse 4xx into tight categories. Real details logged server-side.
      if (status >= 500) {
        console.error("Supabase upstream 5xx:", status, text.slice(0, 500));
        return res.status(502).json({ error: "Upstream service error" });
      }
      if (status === 401 || status === 403) {
        return res.status(status).json({ error: "Unauthorized" });
      }
      return res.status(status).json({ error: "Request rejected" });
    }

    try {
      return res.status(status).json(JSON.parse(text));
    } catch {
      return res.status(status).json({ ok: true });
    }
  } catch (err) {
    return res.status(500).json({ error: "Supabase request failed" });
  }
}
