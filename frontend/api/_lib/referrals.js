// Referral-code store — the short `/?r=code` form of a referral link.
//
// WHY THIS LIVES IN THE AGGREGATOR CATCHALL (not a new api/*.js file):
//   Vercel Hobby caps a deployment at 12 serverless functions and we are at 11.
//   This is dispatched from api/aggregator.js via ?resource=referrals behind a
//   LAZY dynamic import, so the swap hot path never loads it and the function
//   count is unchanged. Same rationale as alerts.js / heat.js. See
//   api/SERVERLESS_BUDGET.md.
//
// ─── WHAT THIS IS NOT ───────────────────────────────────────────────────────
//
//   It is not the referral ledger and it must never become one. Who referred
//   whom, what they earned, and what they can claim are ReferralSplitter's
//   state, read from chain by src/hooks/useReferralStanding.ts. This file maps a
//   short string to a wallet. If a future edit adds an `earnings` or
//   `referredCount` field to any response here, there are two accounts of the
//   same money and the UI will show the fast one — which is this one, which is
//   the one nobody can verify.
//
//   It is not an attribution recorder. Attribution is first-touch in the
//   VISITOR's browser (src/lib/referrals/attribution.ts) and then permanent
//   on-chain via `setReferrer`. Nothing here writes who referred whom, so
//   nothing here can be spoofed into paying the wrong wallet.
//
//   It is not a referrer directory. There is deliberately no endpoint that
//   returns more than one row — see the pinned filter below.
//
// ─── THE FAILURE THAT MATTERS ───────────────────────────────────────────────
//
//   `referral_codes` ships as a migration FILE applied by an operator by hand
//   (this repo has no migration ledger). Until then PostgREST answers
//   404/PGRST205. Two responses would be catastrophic there and neither exists
//   below:
//
//     `{ address: null }`  — telling a visitor who followed a REAL short link
//                            that their referrer does not exist. They then link
//                            nobody, permanently (setReferrer is one-time), and
//                            the person who actually recruited them is never
//                            paid a cent.
//     `{ code: null }`     — telling an owner they have minted nothing when the
//                            truth is that nothing could ever have been minted.
//
//   Both get `code: "schema-missing"` with the operator's next step attached.
//   Note that the whole store being absent degrades to a WORKING feature, not a
//   broken one: `/?ref=0xabc…` links need no server at all, and the share
//   surface mints those by default.
//
// ─── AUTHORITY, AND WHY THE ONE PUBLIC READ IS SHAPED THE WAY IT IS ─────────
//
//   `mine` and `claim` forward the caller's OWN SIWE JWT to PostgREST, so RLS —
//   not this file — decides what they touch. Same shape as alerts.js.
//
//   `resolve` is PUBLIC: a visitor resolving somebody else's link has no session
//   and never will. It runs under the service role with a PINNED filter —
//   exactly one code, one column out — rather than behind a public SELECT
//   policy, because a `USING (true)` policy on this table is readable straight
//   from the browser with the published anon key and turns it into a
//   downloadable list of every referrer's wallet. That is the same shape
//   airdrop.js refuses to expose a recipient list for. That single query string
//   is shape-pinned by api/__tests__/referrals-surface-parity.test.js; do not add
//   a second, wider one.

import { jwtVerify } from "jose";
import { checkRateLimit } from "./ratelimit.js";
import { isOriginAllowed, isRequestOriginAllowed } from "./aggregator-proxy.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "./bodycap.js";
import { logSafe } from "./logSafe.js";

const TABLE = "referral_codes";

/** Mirrors REF_CODE_RE in src/lib/referrals/attribution.ts and the CHECK in
 *  migration 019. Kept as a literal so the parity test can pin all three. */
const REF_CODE_RE = /^[a-z0-9]{4,12}$/;

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** Bodies here are one short field. Anything larger is not a code claim. */
const MAX_BODY_BYTES = 2048;

const MIGRATION_STEP =
  "Apply frontend/supabase/migrations/019_referral_codes.sql to the Supabase project. This repo has no migration ledger — migrations are applied by hand — so the table does not exist until an operator runs it. Referral links of the form /?ref=0x... keep working without it; only the shorter /?r=code form needs it.";

const CONFIG_STEP =
  "Set SUPABASE_URL (or VITE_SUPABASE_URL), VITE_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY), SUPABASE_JWT_SECRET and SUPABASE_SERVICE_KEY on the deployment. Codes are stored per-wallet under RLS, and code resolution runs under the service role with a pinned single-row filter.";

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    // The SIWE JWT rides in an httpOnly cookie, so the browser needs this to
    // send it at all.
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

function supabaseConfig() {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!url || !anonKey || !jwtSecret) return null;
  return { url, anonKey, jwtSecret, serviceKey: process.env.SUPABASE_SERVICE_KEY || null };
}

/** True when PostgREST is telling us the table is not there — never a real empty read. */
function isSchemaMissing(status, text) {
  if (status !== 404 && status !== 400) return false;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return status === 404;
  }
  const code = typeof body?.code === "string" ? body.code : "";
  const message = typeof body?.message === "string" ? body.message : "";
  return (
    code === "PGRST205" ||
    code === "PGRST202" ||
    code === "42P01" ||
    /schema cache/i.test(message) ||
    /does not exist/i.test(message)
  );
}

function schemaMissing(res, what) {
  return res.status(503).json({
    error: `The referral-code table does not exist on this deployment, so ${what}. This is a missing migration, not an answer about any wallet.`,
    code: "schema-missing",
    operatorStep: MIGRATION_STEP,
  });
}

/**
 * One PostgREST round trip.
 *
 * `key` is the apikey AND the bearer unless a user JWT is supplied. Passing the
 * service key as both is how the single public read bypasses RLS; passing the
 * user's JWT as the bearer is how everything else stays under it.
 */
async function postgrest(cfg, { key, jwt, path, init = {} }) {
  const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${jwt || key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
  const { text, truncated } = await readBoundedText(res, MAX_RESPONSE_BYTES);
  if (truncated) return { status: 502, text: "" };
  return { status: res.status, text };
}

function parseRows(text) {
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    return null;
  }
  return Array.isArray(rows) ? rows : null;
}

/**
 * THE PINNED QUERY — exactly one code in, at most one wallet out.
 *
 * `code=eq.<one code>` with `limit=1` and `select=wallet`. This runs under the
 * SERVICE ROLE, which bypasses RLS, so this filter is the entire access control
 * for the table's public face. There is no unfiltered variant and no
 * `select=*`: widening either one turns "who owns THIS code" into an
 * enumeration of every referrer's wallet.
 */
async function handleResolve(req, res, cfg) {
  const raw = String(req.query.code || "").trim().toLowerCase();
  if (!REF_CODE_RE.test(raw)) {
    // A 400 with no `code` field classifies client-side as `rejected`, which
    // renders as "that is not a code" — distinct from "the store could not
    // answer", which is what every branch below produces.
    return res.status(400).json({ error: "That referral code is not a valid shape, so it was not looked up." });
  }
  if (!cfg.serviceKey) {
    return res.status(503).json({
      error:
        "This deployment cannot resolve short referral links, so nothing is claimed about who this code belongs to. A /?ref=0x... link resolves with no server at all.",
      code: "not-configured",
      operatorStep: CONFIG_STEP,
    });
  }

  const { status, text } = await postgrest(cfg, {
    key: cfg.serviceKey,
    path: `${TABLE}?select=wallet&code=eq.${encodeURIComponent(raw)}&limit=1`,
    init: { method: "GET" },
  });
  if (isSchemaMissing(status, text)) {
    return schemaMissing(res, "this short link could not be resolved");
  }
  if (status >= 400) {
    console.error("referrals resolve failed:", status, logSafe(text.slice(0, 300)));
    return res.status(502).json({ error: "The referral-code store could not be read, so this link was not resolved." });
  }
  const rows = parseRows(text);
  if (rows === null) {
    return res.status(502).json({ error: "The referral-code store returned an unexpected shape." });
  }

  const wallet = typeof rows[0]?.wallet === "string" ? rows[0].wallet : null;
  // A short-lived shared cache is safe here and only here: the answer is the
  // same for every visitor and carries no session. `mine` does not get one.
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  // 200 with `address: null` is an ANSWER — the store looked and the code is not
  // registered. Every failure above returns a non-200, which is what lets the
  // client tell "that code is not real" from "we could not ask".
  return res.status(200).json({ address: wallet && EVM_ADDRESS_RE.test(wallet) ? wallet : null });
}

async function handleMine(res, cfg, jwt) {
  const { status, text } = await postgrest(cfg, {
    key: cfg.anonKey,
    jwt,
    path: `${TABLE}?select=code&limit=1`,
    init: { method: "GET" },
  });
  if (isSchemaMissing(status, text)) {
    return schemaMissing(res, "your short code could not be read and none could ever have been minted");
  }
  if (status >= 400) {
    console.error("referrals mine failed:", status, logSafe(text.slice(0, 300)));
    return res.status(502).json({ error: "The referral-code store could not be read." });
  }
  const rows = parseRows(text);
  if (rows === null) {
    return res.status(502).json({ error: "The referral-code store returned an unexpected shape." });
  }
  res.setHeader("Cache-Control", "no-store");
  // 200 with `code: null` means the store answered and this wallet has minted
  // nothing. RLS scopes the SELECT to the caller's own row, so no filter is
  // needed here for correctness — note the reverse is NOT true for `resolve`,
  // which bypasses RLS and rests entirely on its filter.
  return res.status(200).json({ code: typeof rows[0]?.code === "string" ? rows[0].code : null });
}

async function handleClaim(res, cfg, jwt, wallet, body) {
  const code = typeof body?.code === "string" ? body.code.trim().toLowerCase() : "";
  if (!REF_CODE_RE.test(code)) {
    return res.status(400).json({ error: "A code must be 4-12 characters, lowercase letters and digits only." });
  }

  const { status, text } = await postgrest(cfg, {
    key: cfg.anonKey,
    jwt,
    path: TABLE,
    init: {
      // A wallet holds exactly one code (UNIQUE on `wallet`), so re-minting is an
      // UPDATE of that row rather than a second one. `merge-duplicates` makes the
      // mint idempotent — but it can NOT take a code already owned by a DIFFERENT
      // wallet, because `code` is the primary key and that collision surfaces as
      // the 409 below rather than as a silent re-home.
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      method: "POST",
      body: JSON.stringify({ code, wallet }),
    },
  });
  if (isSchemaMissing(status, text)) {
    return schemaMissing(res, "your code was not saved and no short link will resolve");
  }
  if (status === 409) {
    return res.status(409).json({
      error: "That code is already taken by another wallet. Pick a different one — a code points at exactly one payee.",
    });
  }
  if (status >= 400) {
    console.error("referrals claim failed:", status, logSafe(text.slice(0, 300)));
    return res.status(502).json({ error: "Your code was not saved." });
  }
  const rows = parseRows(text);
  res.setHeader("Cache-Control", "no-store");
  // Echo what the DATABASE stored, not what was asked for. If the write landed
  // differently from the request, the caller must be shown the row that exists —
  // they are about to paste it into a link.
  return res.status(201).json({ code: typeof rows?.[0]?.code === "string" ? rows[0].code : code });
}

export async function handleReferrals(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isRequestOriginAllowed(req)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  const allowed = await checkRateLimit(req, res, { limit: 30, windowSec: 60, identifier: "referrals" });
  if (!allowed) return;

  const cfg = supabaseConfig();
  if (!cfg) {
    // 503, not 200-with-nothing. A deployment with no store must not answer
    // "does this code exist?" with "no" — a visitor who followed a real link
    // would then link nobody, permanently, and the recruiter is never paid.
    return res.status(503).json({
      error:
        "This deployment has no referral-code store configured, so short links cannot be resolved or minted. A /?ref=0x... link still works and needs no server.",
      code: "not-configured",
      operatorStep: CONFIG_STEP,
    });
  }

  try {
    const action = req.method === "POST" ? "claim" : String(req.query.action || "");

    // PUBLIC — checked before the auth gate, deliberately, so a signed-out
    // visitor can resolve the link that brought them here.
    if (action === "resolve") return await handleResolve(req, res, cfg);
    if (action !== "mine" && action !== "claim") {
      return res.status(400).json({ error: "Unknown action." });
    }

    // AUTHENTICATED — everything past here is about the caller's own row.
    const jwt = parseCookie(req.headers.cookie, "siwe_jwt");
    if (!jwt) return res.status(401).json({ error: "Not authenticated" });

    let wallet = null;
    let jti = null;
    try {
      const secret = new TextEncoder().encode(cfg.jwtSecret);
      const { payload } = await jwtVerify(jwt, secret, {
        issuer: "supabase",
        audience: "authenticated",
        algorithms: ["HS256"],
      });
      wallet = payload.wallet || payload.sub ? String(payload.wallet || payload.sub).toLowerCase() : null;
      jti = payload.jti ? String(payload.jti) : null;
    } catch {
      return res.status(401).json({ error: "Not authenticated" });
    }
    if (!wallet || !EVM_ADDRESS_RE.test(wallet)) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    // Revocation parity with alerts.js / supabase-proxy.js: without this a
    // logged-out JWT keeps writing for its full lifetime.
    const isProdLike =
      process.env.NODE_ENV === "production" ||
      process.env.VERCEL_ENV === "preview" ||
      process.env.VERCEL_ENV === "production";
    if (!jti && isProdLike) {
      return res.status(401).json({ error: "Token version expired — please re-authenticate" });
    }
    if (jti) {
      if (cfg.serviceKey) {
        try {
          const { createClient } = await import("@supabase/supabase-js");
          const svc = createClient(cfg.url, cfg.serviceKey, {
            auth: { persistSession: false, autoRefreshToken: false },
          });
          const { data: revoked, error: revokedErr } = await svc
            .from("revoked_jwts")
            .select("jti")
            .eq("jti", jti)
            .maybeSingle();
          if (revokedErr) {
            return res.status(503).json({ error: "Authentication temporarily unavailable" });
          }
          if (revoked) {
            return res.status(401).json({ error: "Token revoked" });
          }
        } catch (err) {
          console.error("referrals revocation check failed:", logSafe(err));
          return res.status(503).json({ error: "Authentication temporarily unavailable" });
        }
      } else if (isProdLike) {
        return res.status(503).json({ error: "Auth service not configured" });
      }
    }

    if (action === "mine") return await handleMine(res, cfg, jwt);

    const raw = req.body;
    const body = typeof raw === "string" ? JSON.parse(raw || "{}") : raw || {};
    if (JSON.stringify(body).length > MAX_BODY_BYTES) {
      return res.status(413).json({ error: "Request body too large" });
    }
    return await handleClaim(res, cfg, jwt, wallet, body);
  } catch (err) {
    console.error("referrals error:", logSafe(err));
    return res.status(502).json({ error: "The referral-code store could not be reached." });
  }
}
