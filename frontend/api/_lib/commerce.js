// Invoice store, settlement record, and the one webhook attempt this venue can
// honestly make.
//
// WHY THIS LIVES IN THE AGGREGATOR CATCHALL (not a new api/*.js file):
//   Vercel Hobby caps a deployment at 12 serverless functions and we are at 11.
//   This is dispatched from api/aggregator.js via ?resource=commerce behind a
//   LAZY dynamic import, so the swap hot path never loads it and the function
//   count is unchanged. Same rationale as referrals.js / alerts.js / heat.js.
//   See api/SERVERLESS_BUDGET.md.
//
// ─── WHAT THIS IS NOT ───────────────────────────────────────────────────────
//
//   NOT CUSTODIAL, AND STRUCTURALLY INCAPABLE OF BECOMING SO. No key is held,
//   derived or accepted anywhere in this file. A payment is two transactions the
//   BUYER signs in their own wallet against the plan built in
//   src/lib/commerce/settlement.ts; the merchant is the direct recipient. This
//   endpoint stores what a merchant published and what a browser claims
//   happened. If a future edit adds a signer, a private key, a relayer or a
//   "we'll broadcast it for you" path, it has crossed the one line no revenue
//   argument justifies crossing.
//
//   NOT AN ORACLE. `action=settle` writes `verification: "client-reported"` and
//   nothing else, because nothing here reads a receipt. A merchant releasing
//   goods on this row alone is releasing them on a stranger's assertion, and the
//   row says exactly that in the field a merchant reads. Do NOT add a
//   `verified: true` default, and do not let the client choose the value.
//
//   NOT A DIRECTORY. There is deliberately no endpoint that lists invoices, and
//   no endpoint that lists merchants. The one public read is service-role with a
//   PINNED single-row filter — one id in, one invoice out — for the same reason
//   referrals.js has no referrer roster and airdrop.js has no recipient list. A
//   listable invoice table is a downloadable ledger of who sells what to whom
//   for how much. That query shape is pinned by
//   api/__tests__/commerce-surface-parity.test.js; do not add a wider one.
//
// ─── THE WEBHOOK, AND WHY IT PROMISES SO LITTLE ─────────────────────────────
//
//   THERE IS NO KEEPER ON THIS VENUE. A serverless function runs only when
//   something calls it, so there is no queue, no backoff and no second attempt.
//   Delivery is ONE inline POST inside the settle request. If it fails, it has
//   failed permanently and the response says so — `retries: "none"` is not a
//   placeholder for a retry policy that arrives later, it is the policy.
//
//   A merchant must therefore treat the webhook as a nudge and the settlements
//   read as the source of truth. Every response repeats that.
//
//   Unsigned delivery is not offered. Without COMMERCE_WEBHOOK_SECRET the POST
//   is not attempted at all, because a webhook a merchant cannot verify is one
//   anybody on the internet can forge, and forging it is how a merchant gets
//   told a payment landed that did not.

import { createHmac } from "node:crypto";
import { jwtVerify } from "jose";
import { checkRateLimit } from "./ratelimit.js";
import { isOriginAllowed } from "./aggregator-proxy.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "./bodycap.js";
import { logSafe } from "./logSafe.js";

const INVOICE_TABLE = "commerce_invoices";
const SETTLEMENT_TABLE = "commerce_settlements";

/** Mirrors INVOICE_ID_RE in src/lib/commerce/invoice.ts and the CHECK in 021. */
const INVOICE_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;
const UINT_RE = /^\d{1,78}$/;

/** Invoices are a dozen short fields. Anything larger is not an invoice. */
const MAX_BODY_BYTES = 4096;

/** Longest an invoice may stay payable — mirrors MAX_INVOICE_TTL_SECONDS. */
const MAX_TTL_SECONDS = 24 * 60 * 60;

/**
 * The exact column list of the one public read.
 *
 * Written as a literal, not built from a loop: this string IS the access
 * control for the table's public face, since the service role bypasses RLS.
 * Note what is absent — `webhook_url` never leaves the server, because a
 * merchant's callback endpoint is theirs and a public read of it is a free
 * target list.
 */
const PUBLIC_INVOICE_COLUMNS =
  "id,merchant,chain_id,settle_token,settle_symbol,settle_decimals,settle_amount,memo,expires_at,created_at";

const MIGRATION_STEP =
  "Apply frontend/supabase/migrations/021_commerce.sql to the Supabase project. This repo has no migration ledger — migrations are applied by hand — so the tables do not exist until an operator runs it. No invoice can be published or resolved until then.";

const CONFIG_STEP =
  "Set SUPABASE_URL (or VITE_SUPABASE_URL), VITE_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY), SUPABASE_JWT_SECRET and SUPABASE_SERVICE_KEY on the deployment. Invoices are stored per-merchant under RLS; the single public invoice read runs under the service role with a pinned one-row filter.";

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
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
  // 503, never a 404. A deployment with no table must not answer "does this
  // invoice exist?" with "no": a buyer following a real payment link would be
  // told the merchant's invoice is not real, and the merchant would see a
  // customer who never tried to pay.
  return res.status(503).json({
    error: `The commerce tables do not exist on this deployment, so ${what}. This is a missing migration, not an answer about any invoice.`,
    code: "schema-missing",
    operatorStep: MIGRATION_STEP,
  });
}

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

/** DB row → the wire shape src/lib/commerce/invoice.ts parses. */
function rowToInvoice(row) {
  return {
    id: row.id,
    merchant: row.merchant,
    chainId: Number(row.chain_id),
    settleToken: row.settle_token,
    settleSymbol: row.settle_symbol,
    settleDecimals: Number(row.settle_decimals),
    // uint256 stays a decimal STRING across the wire. A JSON number would lose
    // its low digits above 2^53, and this is the figure a buyer signs for.
    settleAmount: String(row.settle_amount),
    memo: row.memo ?? "",
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
  };
}

// ─── Webhook delivery ────────────────────────────────────────────────────────

/**
 * Reject a callback URL this server should not be made to fetch.
 *
 * This is an SSRF gate, and it is deliberately strict rather than clever: https
 * only, a registrable hostname only, and no IP literal of any kind. A hostname
 * can of course still resolve to a private address, which this cannot see
 * without a resolver — so delivery also runs with `redirect: "manual"`, a short
 * timeout, and a response body that is read to a tiny cap and then discarded.
 * Nothing a callback returns is ever forwarded to a caller.
 */
export function webhookUrlProblem(raw) {
  if (typeof raw !== "string" || raw.length === 0) return "no URL";
  if (raw.length > 400) return "the URL is too long";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "the URL does not parse";
  }
  if (url.protocol !== "https:") return "only https callbacks are delivered to";
  if (url.username || url.password) return "credentials in the URL are not accepted";
  const host = url.hostname.toLowerCase();
  // Bare IP literals are refused outright — v4 dotted quads, and anything with
  // a colon or brackets, which only a v6 literal has. A hostname is required so
  // the request at least goes through public DNS.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[")) {
    return "an IP literal is not accepted as a callback host";
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return "that host is not reachable from outside this deployment";
  }
  if (!host.includes(".")) return "a fully-qualified hostname is required";
  return null;
}

const WEBHOOK_TIMEOUT_MS = 3000;

/**
 * One attempt. No retry, no queue, no schedule — see the header.
 *
 * Always resolves with an outcome; never throws into the settle path, because a
 * merchant's broken endpoint must not turn a recorded settlement into a 500 the
 * buyer reads as "your payment was not recorded".
 */
async function deliverWebhook(url, payload) {
  const secret = process.env.COMMERCE_WEBHOOK_SECRET || "";
  if (!secret) {
    return {
      attempted: false,
      delivered: false,
      retries: "none",
      detail:
        "No webhook signing secret is configured on this deployment, so nothing was sent. An unsigned callback is one anybody could forge, and a forged one tells a merchant a payment landed that did not.",
    };
  }
  const problem = webhookUrlProblem(url);
  if (problem) {
    return {
      attempted: false,
      delivered: false,
      retries: "none",
      detail: `The registered callback was not called because ${problem}.`,
    };
  }

  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Memetic-Signature": `sha256=${signature}`,
        "X-Memetic-Delivery": "single-attempt",
      },
      body,
      redirect: "manual",
      signal: ac.signal,
    });
    // Read and discard, bounded — never forwarded anywhere.
    await readBoundedText(res, 4096);
    return {
      attempted: true,
      delivered: res.status >= 200 && res.status < 300,
      retries: "none",
      detail:
        res.status >= 200 && res.status < 300
          ? "Delivered on the single attempt this venue makes. There is no keeper here, so there is no second one."
          : `The callback answered ${res.status}. There is no keeper on this venue, so it will NOT be retried — poll the settlements read instead.`,
    };
  } catch {
    return {
      attempted: true,
      delivered: false,
      retries: "none",
      detail:
        "The callback could not be reached within 3s. There is no keeper on this venue, so it will NOT be retried — poll the settlements read instead.",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/**
 * THE PINNED QUERY — exactly one id in, at most one invoice out.
 *
 * `id=eq.<one id>` with `limit=1` and an explicit column list. This runs under
 * the SERVICE ROLE, which bypasses RLS, so this filter is the entire access
 * control for the table's public face. There is no unfiltered variant, no
 * `select=*`, and no merchant-scoped listing: widening any of the three turns
 * "what is THIS invoice" into a downloadable ledger of every merchant's sales.
 */
async function handleInvoice(req, res, cfg) {
  const id = String(req.query.id || "").trim().toLowerCase();
  if (!INVOICE_ID_RE.test(id)) {
    return res.status(400).json({ error: "That is not a valid invoice id, so nothing was looked up." });
  }
  if (!cfg.serviceKey) {
    return res.status(503).json({
      error:
        "This deployment cannot resolve invoices, so nothing is claimed about whether this one exists.",
      code: "not-configured",
      operatorStep: CONFIG_STEP,
    });
  }

  const { status, text } = await postgrest(cfg, {
    key: cfg.serviceKey,
    path: `${INVOICE_TABLE}?select=${PUBLIC_INVOICE_COLUMNS}&id=eq.${encodeURIComponent(id)}&limit=1`,
    init: { method: "GET" },
  });
  if (isSchemaMissing(status, text)) {
    return schemaMissing(res, "this invoice could not be looked up");
  }
  if (status >= 400) {
    console.error("commerce invoice read failed:", status, logSafe(text.slice(0, 300)));
    return res.status(502).json({ error: "The invoice store could not be read, so this invoice was not resolved." });
  }
  const rows = parseRows(text);
  if (rows === null) {
    return res.status(502).json({ error: "The invoice store returned an unexpected shape." });
  }
  if (rows.length === 0) {
    // The ONE branch that is an answer rather than a failure, and the client
    // is required to tell it apart from every branch above. See store.ts.
    return res.status(404).json({ error: "No invoice is published under that id.", code: "not-found" });
  }

  // No shared cache. An invoice is short-lived and a stale copy served from an
  // edge cache is a price the merchant has already withdrawn.
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ invoice: rowToInvoice(rows[0]) });
}

function invoiceBodyProblems(body, nowSeconds) {
  const problems = [];
  const id = typeof body?.id === "string" ? body.id.trim().toLowerCase() : "";
  if (!INVOICE_ID_RE.test(id)) problems.push("id must be 8-64 characters of lowercase letters, digits and hyphens");
  if (!EVM_ADDRESS_RE.test(String(body?.settleToken || ""))) problems.push("settleToken must be a 20-byte address");
  if (!UINT_RE.test(String(body?.settleAmount || ""))) problems.push("settleAmount must be a decimal integer string");
  else if (BigInt(String(body.settleAmount)) <= 0n) problems.push("settleAmount must be greater than zero");
  const chainId = Number(body?.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) problems.push("chainId must be a positive integer");
  const decimals = Number(body?.settleDecimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) problems.push("settleDecimals must be 0-36");
  const symbol = typeof body?.settleSymbol === "string" ? body.settleSymbol.trim() : "";
  if (symbol.length === 0 || symbol.length > 32) problems.push("settleSymbol must be 1-32 characters");
  const memo = typeof body?.memo === "string" ? body.memo : "";
  if (memo.length > 200) problems.push("memo must be at most 200 characters");
  const expiresAt = Number(body?.expiresAt);
  if (!Number.isInteger(expiresAt) || expiresAt <= nowSeconds) problems.push("expiresAt must be in the future");
  else if (expiresAt - nowSeconds > MAX_TTL_SECONDS) problems.push("expiresAt may be at most 24 hours away");
  if (body?.webhookUrl != null) {
    const problem = webhookUrlProblem(String(body.webhookUrl));
    if (problem) problems.push(`webhookUrl rejected: ${problem}`);
  }
  return problems;
}

async function handleCreate(res, cfg, jwt, wallet, body) {
  const now = Math.floor(Date.now() / 1000);
  const problems = invoiceBodyProblems(body, now);
  if (problems.length > 0) {
    return res.status(400).json({ error: `This invoice was not published: ${problems.join("; ")}.` });
  }

  // The merchant is the AUTHENTICATED WALLET, never a field in the body. A
  // caller-supplied payee would let anyone publish an invoice that pays somebody
  // else — collecting nothing, but burning that id for its real owner and
  // putting a stranger's address under this venue's name.
  const row = {
    id: String(body.id).trim().toLowerCase(),
    merchant: wallet,
    chain_id: Number(body.chainId),
    settle_token: String(body.settleToken).toLowerCase(),
    settle_symbol: String(body.settleSymbol).trim(),
    settle_decimals: Number(body.settleDecimals),
    settle_amount: String(body.settleAmount),
    memo: typeof body.memo === "string" ? body.memo : "",
    expires_at: Number(body.expiresAt),
    created_at: now,
    webhook_url: body.webhookUrl ? String(body.webhookUrl) : null,
  };

  const { status, text } = await postgrest(cfg, {
    key: cfg.anonKey,
    jwt,
    path: INVOICE_TABLE,
    init: { method: "POST", body: JSON.stringify(row) },
  });
  if (isSchemaMissing(status, text)) {
    return schemaMissing(res, "your invoice was not published and no payment link will resolve");
  }
  if (status === 409) {
    return res.status(409).json({
      error: "An invoice already exists under that id. Pick a different one — an id points at exactly one debt.",
    });
  }
  if (status >= 400) {
    console.error("commerce create failed:", status, logSafe(text.slice(0, 300)));
    return res.status(502).json({ error: "Your invoice was not published." });
  }
  const rows = parseRows(text);
  if (!rows || rows.length === 0) {
    return res.status(502).json({ error: "The invoice store did not echo the row it stored." });
  }
  res.setHeader("Cache-Control", "no-store");
  // Echo what the DATABASE stored, not what was asked for. The merchant is
  // about to paste this into a link and a buyer is going to sign against it.
  return res.status(201).json({ invoice: rowToInvoice(rows[0]) });
}

/**
 * Record a claimed settlement.
 *
 * PUBLIC on purpose: a buyer paying somebody else's invoice has no session with
 * this venue and never will. What that costs is bounded and stated rather than
 * hidden — anyone can assert a hash against an id, so the row is written as
 * `client-reported` and NOTHING here upgrades it. The uniqueness constraint on
 * (invoice_id, tx_hash) stops the same claim being written twice, and the rate
 * limit stops a flood; neither of those makes a claim true, and the merchant's
 * read says so on every row.
 */
async function handleSettle(res, cfg, body) {
  const invoiceId = typeof body?.invoiceId === "string" ? body.invoiceId.trim().toLowerCase() : "";
  const txHash = typeof body?.txHash === "string" ? body.txHash.trim() : "";
  const payer = typeof body?.payer === "string" ? body.payer.trim().toLowerCase() : "";

  if (!INVOICE_ID_RE.test(invoiceId)) {
    return res.status(400).json({ error: "That is not a valid invoice id." });
  }
  if (!TX_HASH_RE.test(txHash)) {
    return res.status(400).json({ error: "That is not a 32-byte transaction hash." });
  }
  if (!EVM_ADDRESS_RE.test(payer)) {
    return res.status(400).json({ error: "That is not a 20-byte payer address." });
  }
  if (!cfg.serviceKey) {
    return res.status(503).json({
      error: "This deployment cannot record settlements, so nothing was written and nothing is claimed.",
      code: "not-configured",
      operatorStep: CONFIG_STEP,
    });
  }

  const insert = await postgrest(cfg, {
    key: cfg.serviceKey,
    path: SETTLEMENT_TABLE,
    init: {
      method: "POST",
      body: JSON.stringify({
        invoice_id: invoiceId,
        tx_hash: txHash,
        payer,
        // Hardcoded. Not read from the body, and there is no branch that sets
        // anything else: nothing in this file reads a receipt, so nothing in
        // this file may write a word that means one was read.
        verification: "client-reported",
        recorded_at: Math.floor(Date.now() / 1000),
      }),
    },
  });
  if (isSchemaMissing(insert.status, insert.text)) {
    return schemaMissing(res, "your payment was not recorded here");
  }
  if (insert.status === 409) {
    return res.status(200).json({
      verification: "client-reported",
      duplicate: true,
      webhook: {
        attempted: false,
        delivered: false,
        retries: "none",
        detail: "This hash was already recorded against this invoice, so no second callback was sent.",
      },
      notice: SETTLE_NOTICE,
    });
  }
  if (insert.status >= 400) {
    console.error("commerce settle failed:", insert.status, logSafe(insert.text.slice(0, 300)));
    return res.status(502).json({ error: "Your payment was not recorded here. The transaction itself is unaffected." });
  }

  // The callback URL is read server-side and never returned to anyone.
  let webhook = {
    attempted: false,
    delivered: false,
    retries: "none",
    detail: "This invoice has no callback registered, so nothing was sent.",
  };
  const lookup = await postgrest(cfg, {
    key: cfg.serviceKey,
    path: `${INVOICE_TABLE}?select=webhook_url,merchant,settle_amount,settle_token,chain_id&id=eq.${encodeURIComponent(invoiceId)}&limit=1`,
    init: { method: "GET" },
  });
  const invoiceRows = lookup.status < 400 ? parseRows(lookup.text) : null;
  const invoiceRow = invoiceRows?.[0] ?? null;
  if (invoiceRow?.webhook_url) {
    webhook = await deliverWebhook(invoiceRow.webhook_url, {
      type: "settlement.reported",
      invoiceId,
      txHash,
      payer,
      chainId: Number(invoiceRow.chain_id),
      settleToken: invoiceRow.settle_token,
      settleAmount: String(invoiceRow.settle_amount),
      verification: "client-reported",
      notice: SETTLE_NOTICE,
    });
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(201).json({ verification: "client-reported", duplicate: false, webhook, notice: SETTLE_NOTICE });
}

const SETTLE_NOTICE =
  "This record is a browser's claim that a transaction was broadcast. Nothing on this deployment read a receipt, so it is NOT a confirmation of payment. Check the hash on a block explorer before releasing anything.";

/** A merchant reads the claims made against THEIR invoices, under RLS. */
async function handleSettlements(req, res, cfg, jwt) {
  const invoiceId = String(req.query.id || "").trim().toLowerCase();
  if (!INVOICE_ID_RE.test(invoiceId)) {
    return res.status(400).json({ error: "That is not a valid invoice id." });
  }
  const { status, text } = await postgrest(cfg, {
    key: cfg.anonKey,
    jwt,
    path: `${SETTLEMENT_TABLE}?select=invoice_id,tx_hash,payer,verification,recorded_at&invoice_id=eq.${encodeURIComponent(invoiceId)}&order=recorded_at.desc&limit=50`,
    init: { method: "GET" },
  });
  if (isSchemaMissing(status, text)) {
    return schemaMissing(res, "the claims against this invoice could not be read");
  }
  if (status >= 400) {
    console.error("commerce settlements read failed:", status, logSafe(text.slice(0, 300)));
    return res.status(502).json({ error: "The settlement record could not be read." });
  }
  const rows = parseRows(text);
  if (rows === null) {
    return res.status(502).json({ error: "The settlement record returned an unexpected shape." });
  }
  res.setHeader("Cache-Control", "no-store");
  // 200 with an empty list means RLS answered and this merchant's invoice has
  // no claims against it. Every failure above is a non-200, which is what lets
  // the client tell "nobody has paid" from "we could not ask".
  return res.status(200).json({ settlements: rows, notice: SETTLE_NOTICE });
}

export async function handleCommerce(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!isOriginAllowed(req.headers?.origin || "")) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  const allowed = await checkRateLimit(req, res, { limit: 30, windowSec: 60, identifier: "commerce" });
  if (!allowed) return;

  const cfg = supabaseConfig();
  if (!cfg) {
    return res.status(503).json({
      error:
        "This deployment has no invoice store configured, so invoices cannot be published or resolved. Nothing here is a statement about any invoice.",
      code: "not-configured",
      operatorStep: CONFIG_STEP,
    });
  }

  try {
    const action = String(req.query.action || (req.method === "POST" ? "" : "invoice"));

    // PUBLIC — checked before the auth gate, deliberately. A buyer resolving a
    // payment link has no session, and a payer recording their own transaction
    // has none either.
    if (action === "invoice") return await handleInvoice(req, res, cfg);
    if (action === "settle") {
      const raw = req.body;
      const body = typeof raw === "string" ? JSON.parse(raw || "{}") : raw || {};
      if (JSON.stringify(body).length > MAX_BODY_BYTES) {
        return res.status(413).json({ error: "Request body too large" });
      }
      return await handleSettle(res, cfg, body);
    }
    if (action !== "create" && action !== "settlements") {
      return res.status(400).json({ error: "Unknown action." });
    }

    // AUTHENTICATED — publishing a debt under this venue's name, and reading who
    // claims to have paid it.
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

    // Revocation parity with alerts.js / referrals.js: without this a logged-out
    // JWT keeps publishing invoices for its full lifetime.
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
          console.error("commerce revocation check failed:", logSafe(err));
          return res.status(503).json({ error: "Authentication temporarily unavailable" });
        }
      } else if (isProdLike) {
        return res.status(503).json({ error: "Auth service not configured" });
      }
    }

    if (action === "settlements") return await handleSettlements(req, res, cfg, jwt);

    const raw = req.body;
    const body = typeof raw === "string" ? JSON.parse(raw || "{}") : raw || {};
    if (JSON.stringify(body).length > MAX_BODY_BYTES) {
      return res.status(413).json({ error: "Request body too large" });
    }
    return await handleCreate(res, cfg, jwt, wallet, body);
  } catch (err) {
    console.error("commerce error:", logSafe(err));
    return res.status(502).json({ error: "The invoice store could not be reached." });
  }
}
