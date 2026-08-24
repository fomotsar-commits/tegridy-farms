// Alert-rule store — CRUD for the rules the alert engine evaluates.
//
// WHY THIS LIVES IN THE AGGREGATOR CATCHALL (not a new api/*.js file):
//   Vercel Hobby caps a deployment at 12 serverless functions and we are at 11.
//   This is dispatched from api/aggregator.js via ?resource=alerts behind a LAZY
//   dynamic import, so the swap hot path never loads it and the function count is
//   unchanged. Same rationale as heat.js / launch-radar.js. See
//   api/SERVERLESS_BUDGET.md.
//
// WHAT IT IS NOT:
//   It is not an evaluator and it never will be. A Vercel function runs only when
//   something calls it, so nothing here can watch a rule while the user's tab is
//   closed. That job belongs to the F9 worker (docs/BATTLE_PLAN.md), which does
//   not exist — and because a stored rule that nobody evaluates is the single most
//   dangerous thing this feature could ship, every response carries a `delivery`
//   block stating exactly that, and the UI renders it.
//
// AUTHORITY MODEL:
//   Rows are keyed to the SIWE wallet and the user's OWN JWT is forwarded to
//   PostgREST, so RLS — not this file — decides what a caller may see. The
//   service-role client is used for exactly one thing, the revocation lookup,
//   mirroring api/supabase-proxy.js. Service role never forwards a user write.
//
// THE FAILURE THAT MATTERS:
//   `alert_rules` ships as a migration FILE and is applied by an operator by
//   hand (this repo has no migration ledger). Until it is applied, PostgREST
//   answers 404/PGRST205. Returning `{ rules: [] }` there would tell a user they
//   have no rules when the truth is that no rule could ever have been saved. That
//   case gets its own code — `schema-missing` — and never an empty list.

import { jwtVerify } from "jose";
import { checkRateLimit } from "./ratelimit.js";
import { isOriginAllowed, isRequestOriginAllowed } from "./aggregator-proxy.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "./bodycap.js";
import { logSafe } from "./logSafe.js";

const TABLE = "alert_rules";

/** Mirrors src/lib/alerts/rules.ts. Kept as a literal so a drift test can pin both. */
const ALERT_RULE_KINDS = ["whale-move", "deployer-reputation", "lp-unlock", "launch-live", "heat-tier", "loan-deadline"];

/**
 * Kinds that carry a threshold; every other kind must send null.
 *
 * The two do not share a unit — `whale-move` is USD, `loan-deadline` is hours
 * of lead time before a loan's deadline — so the error text below names the
 * unit rather than assuming dollars.
 */
const THRESHOLD_KINDS = new Set(["whale-move", "loan-deadline"]);

/** What the threshold measures, per kind. Rendered in the rejection message. */
const THRESHOLD_UNIT = { "whale-move": "USD", "loan-deadline": "hours" };

/**
 * Absolute ceiling per wallet, enforced here because a client-side cap is a
 * suggestion. This is NOT the free-tier limit: this file cannot cheaply read
 * PremiumAccess on-chain, so the free/premium split is a UI affordance and the
 * surface must not claim the database enforces it. This number is the hard stop
 * that keeps one wallet from filling the table.
 */
const MAX_RULES_PER_WALLET = 25;

/** Bodies here are three short fields; anything larger is not a rule. */
const MAX_BODY_BYTES = 4096;

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const MIGRATION_STEP =
  "Apply frontend/supabase/migrations/016_alert_rules.sql to the Supabase project. This repo has no migration ledger — migrations are applied by hand — so the table does not exist until an operator runs it.";

const CONFIG_STEP =
  "Set SUPABASE_URL (or VITE_SUPABASE_URL), VITE_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY) and SUPABASE_JWT_SECRET on the deployment. Alert rules are stored per-wallet under RLS and cannot exist without them.";

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

/**
 * What the SERVER can say about delivery. The browser only sees
 * VITE_VAPID_PUBLIC_KEY, so it cannot tell a half-configured deployment (public
 * key set, private key missing) from a working one — and a half-configured
 * deployment is exactly the shape that renders as "push enabled" and delivers
 * nothing. Reported on every response, success or failure.
 */
function deliveryReport() {
  const pushConfigured = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  return {
    pushConfigured,
    // No background worker exists on any deployment. A serverless function runs
    // only when called, so it cannot be one. Hardcoded rather than env-driven:
    // an operator cannot make a worker exist by setting a variable.
    backgroundWorker: false,
    detail: pushConfigured
      ? "A VAPID key pair is set, but nothing runs on a schedule to evaluate stored rules or send to a subscription. Rules are evaluated only while the app is open, and alerts land in the in-app inbox."
      : "No VAPID key pair is set on this deployment and no background worker exists, so no push can be sent. Rules are evaluated only while the app is open, and alerts land in the in-app inbox.",
  };
}

function supabaseConfig() {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!url || !anonKey || !jwtSecret) return null;
  return { url, anonKey, jwtSecret };
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

function validateWrite(body) {
  const action = body?.action;
  if (action === "create") {
    const kind = body.kind;
    if (typeof kind !== "string" || !ALERT_RULE_KINDS.includes(kind)) {
      return { ok: false, error: "Unknown rule type." };
    }
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    if (!EVM_ADDRESS_RE.test(subject)) {
      return { ok: false, error: "Subject must be a 0x-prefixed 40-character address." };
    }
    let threshold = null;
    if (THRESHOLD_KINDS.has(kind)) {
      const raw = typeof body.threshold === "string" ? Number(body.threshold) : body.threshold;
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
        return {
          ok: false,
          error: `This rule type needs a threshold in ${THRESHOLD_UNIT[kind]} greater than zero.`,
        };
      }
      threshold = raw;
    } else if (body.threshold != null) {
      // Rejected, not stripped: a threshold silently dropped from a kind that
      // ignores it would leave the caller believing it applies.
      return { ok: false, error: "This rule type does not take a threshold." };
    }
    return { ok: true, action, kind, subject: subject.toLowerCase(), threshold };
  }
  if (action === "delete" || action === "toggle") {
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!UUID_RE.test(id)) return { ok: false, error: "Invalid rule id." };
    if (action === "toggle" && typeof body.enabled !== "boolean") {
      return { ok: false, error: "Invalid enabled flag." };
    }
    return { ok: true, action, id, enabled: body.enabled === true };
  }
  return { ok: false, error: "Unknown action." };
}

async function postgrest(cfg, jwt, path, init = {}) {
  const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: cfg.anonKey,
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
  const { text, truncated } = await readBoundedText(res, MAX_RESPONSE_BYTES);
  if (truncated) return { status: 502, text: "" };
  return { status: res.status, text };
}

export async function handleAlerts(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isRequestOriginAllowed(req)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  const allowed = await checkRateLimit(req, res, { limit: 30, windowSec: 60, identifier: "alerts" });
  if (!allowed) return;

  const delivery = deliveryReport();

  const cfg = supabaseConfig();
  if (!cfg) {
    // 503, not 200-with-empty-list: a deployment that cannot store rules must not
    // answer the question "what rules do I have?" with "none".
    return res.status(503).json({
      error:
        "This deployment has no rule store configured, so alert rules cannot be read or saved. Nothing here says you have no rules.",
      code: "not-configured",
      operatorStep: CONFIG_STEP,
      delivery,
    });
  }

  const jwt = parseCookie(req.headers.cookie, "siwe_jwt");
  if (!jwt) {
    return res.status(401).json({ error: "Not authenticated", delivery });
  }

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
    return res.status(401).json({ error: "Not authenticated", delivery });
  }
  if (!wallet || !EVM_ADDRESS_RE.test(wallet)) {
    return res.status(401).json({ error: "Not authenticated", delivery });
  }

  // Revocation parity with api/supabase-proxy.js: without this a logged-out JWT
  // keeps writing for its full lifetime. Same fail-closed gates, same reasons.
  const isProdLike =
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "preview" ||
    process.env.VERCEL_ENV === "production";
  if (!jti && isProdLike) {
    return res.status(401).json({ error: "Token version expired — please re-authenticate", delivery });
  }
  if (jti) {
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    if (serviceKey) {
      try {
        const { createClient } = await import("@supabase/supabase-js");
        const svc = createClient(cfg.url, serviceKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: revoked, error: revokedErr } = await svc
          .from("revoked_jwts")
          .select("jti")
          .eq("jti", jti)
          .maybeSingle();
        if (revokedErr) {
          return res.status(503).json({ error: "Authentication temporarily unavailable", delivery });
        }
        if (revoked) {
          return res.status(401).json({ error: "Token revoked", delivery });
        }
      } catch (err) {
        console.error("alerts revocation check failed:", logSafe(err));
        return res.status(503).json({ error: "Authentication temporarily unavailable", delivery });
      }
    } else if (isProdLike) {
      return res.status(503).json({ error: "Auth service not configured", delivery });
    }
  }

  const listPath = `${TABLE}?select=id,kind,subject,threshold,enabled,created_at&order=created_at.desc&limit=${MAX_RULES_PER_WALLET}`;

  async function respondWithList(status = 200) {
    const { status: s, text } = await postgrest(cfg, jwt, listPath, { method: "GET" });
    if (isSchemaMissing(s, text)) {
      return res.status(503).json({
        error:
          "The alert-rule table does not exist on this deployment, so no rule could be read or saved. This is a missing migration, not an empty rule list.",
        code: "schema-missing",
        operatorStep: MIGRATION_STEP,
        delivery,
      });
    }
    if (s >= 400) {
      console.error("alerts list failed:", s, logSafe(text.slice(0, 300)));
      return res.status(502).json({ error: "The rule store could not be read.", delivery });
    }
    let rules;
    try {
      rules = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: "The rule store returned something unreadable.", delivery });
    }
    if (!Array.isArray(rules)) {
      return res.status(502).json({ error: "The rule store returned an unexpected shape.", delivery });
    }
    // No cache header: a per-wallet, auth-scoped list must never sit in a shared
    // edge cache.
    res.setHeader("Cache-Control", "no-store");
    return res.status(status).json({ rules, delivery });
  }

  try {
    if (req.method === "GET") return await respondWithList();

    const raw = req.body;
    const body = typeof raw === "string" ? JSON.parse(raw || "{}") : raw || {};
    if (JSON.stringify(body).length > MAX_BODY_BYTES) {
      return res.status(413).json({ error: "Request body too large", delivery });
    }

    const parsed = validateWrite(body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error, delivery });

    if (parsed.action === "create") {
      // Count first so the ceiling is enforced against what the DATABASE holds,
      // not against what this request happens to know.
      const { status: cs, text: ct } = await postgrest(cfg, jwt, `${TABLE}?select=id`, { method: "GET" });
      if (isSchemaMissing(cs, ct)) {
        return res.status(503).json({
          error:
            "The alert-rule table does not exist on this deployment, so this rule was not saved. It is not stored anywhere and nothing will evaluate it.",
          code: "schema-missing",
          operatorStep: MIGRATION_STEP,
          delivery,
        });
      }
      if (cs >= 400) {
        return res.status(502).json({ error: "The rule store could not be read.", delivery });
      }
      let existing = [];
      try {
        existing = JSON.parse(ct);
      } catch {
        existing = [];
      }
      if (Array.isArray(existing) && existing.length >= MAX_RULES_PER_WALLET) {
        return res.status(409).json({
          error: `This wallet is at the hard ceiling of ${MAX_RULES_PER_WALLET} alert rules. Delete one to add another.`,
          delivery,
        });
      }

      const { status: ws, text: wt } = await postgrest(cfg, jwt, TABLE, {
        method: "POST",
        body: JSON.stringify({
          wallet,
          kind: parsed.kind,
          subject: parsed.subject,
          threshold: parsed.threshold,
          enabled: true,
        }),
      });
      if (isSchemaMissing(ws, wt)) {
        return res.status(503).json({
          error:
            "The alert-rule table does not exist on this deployment, so this rule was not saved.",
          code: "schema-missing",
          operatorStep: MIGRATION_STEP,
          delivery,
        });
      }
      if (ws === 409) {
        return res.status(409).json({ error: "You already have that exact rule.", delivery });
      }
      if (ws >= 400) {
        console.error("alerts create failed:", ws, logSafe(wt.slice(0, 300)));
        return res.status(502).json({ error: "The rule was not saved.", delivery });
      }
      return await respondWithList(201);
    }

    // DELETE / TOGGLE. The `wallet` filter is belt-and-braces on top of RLS: RLS
    // is the authority, but a filter that names the verified wallet means a
    // mis-scoped policy cannot silently widen this endpoint.
    const scope = `${TABLE}?id=eq.${encodeURIComponent(parsed.id)}&wallet=eq.${encodeURIComponent(wallet)}`;
    const { status: ms, text: mt } =
      parsed.action === "delete"
        ? await postgrest(cfg, jwt, scope, { method: "DELETE" })
        : await postgrest(cfg, jwt, scope, {
            method: "PATCH",
            body: JSON.stringify({ enabled: parsed.enabled }),
          });
    if (isSchemaMissing(ms, mt)) {
      return res.status(503).json({
        error: "The alert-rule table does not exist on this deployment, so nothing was changed.",
        code: "schema-missing",
        operatorStep: MIGRATION_STEP,
        delivery,
      });
    }
    if (ms >= 400) {
      console.error("alerts mutate failed:", ms, logSafe(mt.slice(0, 300)));
      return res.status(502).json({ error: "The change was not applied.", delivery });
    }
    return await respondWithList();
  } catch (err) {
    console.error("alerts error:", logSafe(err));
    return res.status(502).json({ error: "The rule store could not be reached.", delivery });
  }
}
