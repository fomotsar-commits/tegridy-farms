// Telegram chat ↔ wallet binding. The ONLY server-side surface the bot has, and
// the reason the bot can exist without ever holding a key.
//
// WHY THIS LIVES IN THE AGGREGATOR CATCHALL (not a new api/*.js file):
//   Vercel Hobby caps a deployment at 12 serverless functions and we are at 11.
//   Dispatched from api/aggregator.js via ?resource=bot-link behind a LAZY dynamic
//   import, so the swap hot path never loads it and the function count is
//   unchanged. Same rationale as alerts.js / referrals.js / heat.js. See
//   api/SERVERLESS_BUDGET.md.
//
// ─── WHAT A BINDING IS ──────────────────────────────────────────────────────
//
//   One Telegram chat proved control of one wallet by signing a SIWE message in
//   the web app. That is the entire grant. It buys read-only answers in chat and
//   nothing else. It is not an authorisation to spend, it is not a delegation, and
//   it cannot be upgraded into one by anything in this file.
//
//   Trojan and Banana Gun both cleared enormous volume on this surface and both
//   were drained through keys their servers held or derived. So the shape here is
//   the product decision, not a hardening pass over it: there is no column, no
//   request field, no response field and no code path in this file that touches
//   key material. `api/__tests__/bot-noncustodial.test.js` fails the build if one
//   appears, in this file, in the bot, or in migration 020.
//
// ─── THE TWO CALLERS, AND WHY THEY AUTHENTICATE DIFFERENTLY ─────────────────
//
//   THE BOT is a server with no browser and no Origin header, so it proves itself
//   with an HMAC over `${timestamp}.${rawBody}` under BOT_LINK_SECRET — the same
//   secret it derives `chat_ref` with. It may do exactly three things: mint a
//   pending code for a chat, ask whether a chat is linked, and destroy a binding.
//   It may NOT bind one. Binding needs a wallet signature, which only the browser
//   can obtain, which is the whole architecture in one sentence.
//
//   THE BROWSER carries the SIWE httpOnly cookie and is origin-gated like every
//   other first-party resource here. It claims a pending code (that claim IS the
//   proof of wallet control), lists its own bindings, and revokes them.
//
//   Note the asymmetry in `revoke`: BOTH callers may destroy a binding and neither
//   can be tricked into creating one. Destroying is always safe — it can only
//   reduce what the bot may answer — so it is deliberately the one mutation that
//   is reachable from either side without the other's consent.
//
// ─── WHY THE TELEGRAM ID NEVER REACHES POSTGRES ─────────────────────────────
//
//   Callers send `chatRef`, already HMAC'd bot-side. A raw Telegram user id is
//   never accepted, never derived here and never stored, so a dump of
//   `telegram_links` is a list of wallets beside opaque digests rather than a
//   wallet-to-person map. Every read below is pinned to ONE chat_ref or to the
//   caller's own rows: there is no endpoint that returns a second row, for the
//   same reason referrals.js has no referrer directory and airdrop.js has no
//   recipient list.
//
// ─── THE FAILURE THAT MATTERS ───────────────────────────────────────────────
//
//   `telegram_links` ships as a migration FILE applied by an operator by hand
//   (this repo has no migration ledger). Until then PostgREST answers
//   404/PGRST205, and answering that with `linked: false` would tell a user their
//   chat is not linked when the truth is that no chat could ever have been linked
//   — and would tell the bot to keep offering `/link` codes that can never be
//   claimed. Every such branch answers 503 `schema-missing` with the operator's
//   next step, and never a shape that reads as an answer about a wallet.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { jwtVerify } from "jose";
import { checkRateLimit } from "./ratelimit.js";
import { isOriginAllowed, isRequestOriginAllowed } from "./aggregator-proxy.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "./bodycap.js";
import { logSafe } from "./logSafe.js";

const TABLE = "telegram_links";

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const CHAT_REF_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Link-code alphabet and shape, mirrored by bot/src/deepLink.js.
 *
 * Crockford-style: no I, L, O, U, 0 or 1. A code is read aloud off a phone screen
 * and typed into a browser, and a code that resolves to nothing because the reader
 * saw an O where an 0 was is indistinguishable, to them, from a bot that lied.
 */
export const LINK_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const LINK_CODE_RE = /^[2-9A-HJ-NP-TV-Z]{10}$/;

/**
 * 10 chars over a 30-char alphabet ≈ 49 bits. The window is ten minutes and the
 * table's UNIQUE constraint makes a duplicate a 409 rather than a collision, so
 * this is sized against online guessing, which the rate limit below already caps.
 */
const LINK_CODE_LENGTH = 10;

/** A code the user must carry from a chat to a browser. Long enough to walk. */
export const LINK_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Replay window for a bot-signed request. Wide enough for clock drift between two
 * hosts we do not control, narrow enough that a captured signature is not a
 * standing credential.
 */
export const BOT_SIGNATURE_SKEW_MS = 120 * 1000;

/** Bodies here are two short fields. Anything larger is not a link request. */
const MAX_BODY_BYTES = 2048;

/** A wallet may hold several chats, but not unbounded ones. */
const MAX_LINKS_PER_WALLET = 10;

const MIGRATION_STEP =
  "Apply frontend/supabase/migrations/020_telegram_links.sql to the Supabase project. This repo has no migration ledger — migrations are applied by hand — so the table does not exist until an operator runs it, and until then no Telegram chat can be linked to any wallet.";

const CONFIG_STEP =
  "Set SUPABASE_URL (or VITE_SUPABASE_URL), VITE_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY), SUPABASE_JWT_SECRET, SUPABASE_SERVICE_KEY and BOT_LINK_SECRET on the deployment. BOT_LINK_SECRET must be the same value the bot process holds — it is what derives chat_ref on both sides.";

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Bot-Timestamp, X-Bot-Signature");
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
    error: `The Telegram link table does not exist on this deployment, so ${what}. This is a missing migration, not a fact about any chat or wallet.`,
    code: "schema-missing",
    operatorStep: MIGRATION_STEP,
  });
}

/**
 * The two fields a bot request may carry, in a fixed order.
 *
 * The signature is taken over THIS, not over the bytes that arrived. Vercel parses
 * the request body before a handler sees it, so verifying "the exact wire bytes"
 * here would mean re-serialising a parsed object and hoping the result is
 * byte-identical to what was signed — which it is, today, in V8, for compact JSON
 * with non-numeric keys in insertion order, and which would silently stop being
 * true on any change to any of those four things. A failure of that kind is total
 * (every bot call 401s) and its cause is invisible.
 *
 * Signing a canonical form of the fields the handler actually ACTS on removes the
 * dependency. Nothing outside these two keys is signed, and nothing outside them is
 * read below, so the signed material and the acted-upon material are the same thing
 * by construction.
 */
export function canonicalBotBody(body) {
  return JSON.stringify({ action: body?.action ?? null, chatRef: body?.chatRef ?? null });
}

/**
 * The string a bot-signed request is authenticated over.
 *
 * The timestamp is INSIDE the signed material — a signature over the body alone is
 * replayable forever, and this endpoint mints credentials.
 */
export function botSigningString(timestamp, rawBody) {
  return `${timestamp}.${rawBody}`;
}

export function signBotRequest(secret, timestamp, rawBody) {
  return createHmac("sha256", secret).update(botSigningString(timestamp, rawBody), "utf8").digest("hex");
}

/** Constant-time hex compare. `===` on a MAC is a timing oracle by construction. */
function hexEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/**
 * Is this request signed by the process holding BOT_LINK_SECRET?
 *
 * Returns a reason string on failure rather than a boolean, because "no secret is
 * configured on this deployment" and "your signature is wrong" need different
 * answers: the first is an operator's problem and the bot must stop retrying, the
 * second is a compromise indicator.
 */
export function verifyBotSignature({ secret, timestamp, signature, rawBody, now = Date.now() }) {
  if (!secret) return { ok: false, code: "not-configured" };
  if (!timestamp || !signature) return { ok: false, code: "unsigned" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, code: "unsigned" };
  if (Math.abs(now - ts * 1000) > BOT_SIGNATURE_SKEW_MS) return { ok: false, code: "stale" };
  return hexEquals(signature, signBotRequest(secret, timestamp, rawBody))
    ? { ok: true }
    : { ok: false, code: "bad-signature" };
}

/**
 * One PostgREST round trip.
 *
 * `key` is the apikey AND the bearer unless a user JWT is supplied. Passing the
 * service key as both is how the three pinned writes reach a row that has no owner
 * yet; passing the user's JWT is how everything else stays under RLS.
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
 * A code is only worth the ~49 bits claimed above if every letter is equally
 * likely, and `byte % 30` is not: 256 is 8*30 + 16, so the first 16 letters of the
 * alphabet come up 9 times per 256 draws and the last 14 come up 8. Measured over
 * 2,000,000 characters that is a 1.14:1 skew, and it costs the code ~0.9 bits of
 * min-entropy -- small, and still the wrong direction for a value that is the whole
 * proof a claim is genuine.
 *
 * Mask to five bits and DISCARD the two values that fall off the end of the
 * alphabet instead. 256 is an exact multiple of 32, so `byte & 31` is uniform over
 * 0..31 with no remainder left to bias it, and the survivors are uniform over all
 * 30. This is nanoid's customRandom in four lines. Each draw keeps 30 bytes in 32
 * and asks for twice what it needs, so the loop runs once except astronomically
 * rarely.
 *
 * The parameter is the byte SOURCE rather than the bytes, so a test can pin the
 * output; the only caller uses the default.
 */
export function generateLinkCode(randomSource = randomBytes) {
  const mask = (1 << Math.ceil(Math.log2(LINK_CODE_ALPHABET.length))) - 1;
  let out = "";
  while (out.length < LINK_CODE_LENGTH) {
    const bytes = randomSource(LINK_CODE_LENGTH * 2);
    for (let i = 0; i < bytes.length && out.length < LINK_CODE_LENGTH; i += 1) {
      const index = bytes[i] & mask;
      if (index < LINK_CODE_ALPHABET.length) out += LINK_CODE_ALPHABET[index];
    }
  }
  return out;
}

// ─── BOT-SIGNED ACTIONS ──────────────────────────────────────────────────────

/**
 * Mint a pending code for one chat.
 *
 * Refuses outright when the chat already holds a binding. The alternative —
 * overwriting the row with a fresh pending code — would mean anybody who got a
 * `/link` typed into an already-linked chat silently detaches the wallet that was
 * there, and the user finds out when their answers stop. Re-linking is `/unlink`
 * then `/link`, in that order, deliberately.
 */
async function botBegin(res, cfg, chatRef) {
  const existing = await postgrest(cfg, {
    key: cfg.serviceKey,
    path: `${TABLE}?select=wallet&chat_ref=eq.${encodeURIComponent(chatRef)}&limit=1`,
    init: { method: "GET" },
  });
  if (isSchemaMissing(existing.status, existing.text)) {
    return schemaMissing(res, "no link code was minted and none could ever be claimed");
  }
  if (existing.status >= 400) {
    console.error("botLink begin read failed:", existing.status, logSafe(existing.text.slice(0, 300)));
    return res.status(502).json({ error: "The link store could not be read, so no code was minted." });
  }
  const rows = parseRows(existing.text);
  if (rows === null) {
    return res.status(502).json({ error: "The link store returned an unexpected shape." });
  }
  const boundWallet = typeof rows[0]?.wallet === "string" ? rows[0].wallet : null;
  if (boundWallet) {
    return res.status(409).json({
      error: "This chat is already linked to a wallet. Unlink it first — a chat points at exactly one wallet.",
      code: "already-linked",
      wallet: boundWallet,
    });
  }

  const code = generateLinkCode();
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS).toISOString();
  const write = await postgrest(cfg, {
    key: cfg.serviceKey,
    // on_conflict=chat_ref: a chat that asks twice replaces its own pending code
    // rather than colliding on the UNIQUE constraint. It cannot reach a row that
    // carries a wallet, because that case returned 409 above.
    path: `${TABLE}?on_conflict=chat_ref`,
    init: {
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      method: "POST",
      body: JSON.stringify({
        chat_ref: chatRef,
        wallet: null,
        linked_at: null,
        link_code: code,
        code_expires_at: expiresAt,
      }),
    },
  });
  if (isSchemaMissing(write.status, write.text)) {
    return schemaMissing(res, "no link code was minted");
  }
  if (write.status === 409) {
    // The UNIQUE on link_code. Astronomically unlikely and still a real branch:
    // reporting success here would hand out a code pointing at somebody else's row.
    return res.status(409).json({ error: "Code collision — ask again.", code: "collision" });
  }
  if (write.status >= 400) {
    console.error("botLink begin write failed:", write.status, logSafe(write.text.slice(0, 300)));
    return res.status(502).json({ error: "The link code was not saved, so it will not resolve." });
  }
  res.setHeader("Cache-Control", "no-store");
  // Echo what the DATABASE stored. A code the user is about to read off a screen
  // must be the code the row carries, not the one this process hoped to write.
  const stored = parseRows(write.text)?.[0];
  return res.status(201).json({
    code: typeof stored?.link_code === "string" ? stored.link_code : code,
    expiresAt: typeof stored?.code_expires_at === "string" ? stored.code_expires_at : expiresAt,
  });
}

/**
 * Is this chat linked, and to what?
 *
 * `{ linked: false }` is an ANSWER and is only ever produced after the store
 * answered. Every failure above it is a non-200, which is what lets the bot say
 * "I could not check" instead of "you are not linked".
 */
async function botStatus(res, cfg, chatRef) {
  const { status, text } = await postgrest(cfg, {
    key: cfg.serviceKey,
    path: `${TABLE}?select=wallet,linked_at&chat_ref=eq.${encodeURIComponent(chatRef)}&limit=1`,
    init: { method: "GET" },
  });
  if (isSchemaMissing(status, text)) {
    return schemaMissing(res, "this chat's link state could not be read");
  }
  if (status >= 400) {
    console.error("botLink status failed:", status, logSafe(text.slice(0, 300)));
    return res.status(502).json({ error: "The link store could not be read, so this chat's state is unknown." });
  }
  const rows = parseRows(text);
  if (rows === null) {
    return res.status(502).json({ error: "The link store returned an unexpected shape." });
  }
  const wallet = typeof rows[0]?.wallet === "string" ? rows[0].wallet : null;
  res.setHeader("Cache-Control", "no-store");
  if (!wallet || !EVM_ADDRESS_RE.test(wallet)) {
    return res.status(200).json({ linked: false });
  }
  return res.status(200).json({ linked: true, wallet, linkedAt: rows[0]?.linked_at ?? null });
}

/**
 * Destroy this chat's binding, whatever state it is in.
 *
 * Reachable by the bot without the wallet's consent on purpose: the holder of the
 * chat can always stop the chat from being answered. The reverse — the bot
 * CREATING a binding without the wallet's consent — is the thing that must be
 * impossible, and it is, because binding requires a signature.
 */
async function botRevoke(res, cfg, chatRef) {
  const { status, text } = await postgrest(cfg, {
    key: cfg.serviceKey,
    path: `${TABLE}?chat_ref=eq.${encodeURIComponent(chatRef)}`,
    init: { method: "DELETE" },
  });
  if (isSchemaMissing(status, text)) {
    return schemaMissing(res, "nothing was unlinked");
  }
  if (status >= 400) {
    console.error("botLink revoke failed:", status, logSafe(text.slice(0, 300)));
    // Never 200. "Unlinked" is a safety claim, and a user who is told their chat
    // is detached when the row is still there will stop watching a live binding.
    return res.status(502).json({ error: "The binding was not removed. It is still in place." });
  }
  res.setHeader("Cache-Control", "no-store");
  const removed = parseRows(text)?.length ?? 0;
  return res.status(200).json({ removed });
}

// ─── BROWSER ACTIONS (SIWE) ──────────────────────────────────────────────────

/**
 * Claim a pending code for the signed-in wallet. THIS is the binding step, and the
 * SIWE cookie behind it is the wallet's proof of control — the only proof the whole
 * architecture accepts.
 *
 * Service role, because the row it updates has no wallet yet and so no owner-keyed
 * policy could admit the write (020's header says the same). The filter is the
 * access control: one unexpired code, and the write refuses to touch a row that
 * already carries a wallet.
 */
async function claimCode(res, cfg, wallet, body) {
  const raw = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!LINK_CODE_RE.test(raw)) {
    return res.status(400).json({
      error: "That is not a link code. Codes are 10 characters, generated by the bot when you send it /link.",
    });
  }
  if (!cfg.serviceKey) {
    return res.status(503).json({
      error: "This deployment cannot complete a Telegram link, so nothing was bound to your wallet.",
      code: "not-configured",
      operatorStep: CONFIG_STEP,
    });
  }

  // Ceiling enforced against what the DATABASE holds. Read under the service role
  // with a pinned wallet filter — the user's own JWT would work through RLS too,
  // but this path already holds the service client and one authority per handler
  // is easier to keep honest than two.
  const count = await postgrest(cfg, {
    key: cfg.serviceKey,
    path: `${TABLE}?select=id&wallet=eq.${encodeURIComponent(wallet)}`,
    init: { method: "GET" },
  });
  if (isSchemaMissing(count.status, count.text)) {
    return schemaMissing(res, "your code was not claimed and no chat was bound");
  }
  if (count.status >= 400) {
    return res.status(502).json({ error: "The link store could not be read, so nothing was bound." });
  }
  if ((parseRows(count.text)?.length ?? 0) >= MAX_LINKS_PER_WALLET) {
    return res.status(409).json({
      error: `This wallet is at the ceiling of ${MAX_LINKS_PER_WALLET} linked chats. Unlink one to add another.`,
    });
  }

  const nowIso = new Date().toISOString();
  const { status, text } = await postgrest(cfg, {
    key: cfg.serviceKey,
    // Three filters, all load-bearing: the exact code, an expiry still in the
    // future, and `wallet=is.null` so a claimed row can never be re-homed onto a
    // different wallet by replaying an old code.
    path:
      `${TABLE}?link_code=eq.${encodeURIComponent(raw)}` +
      `&code_expires_at=gt.${encodeURIComponent(nowIso)}` +
      `&wallet=is.null`,
    init: {
      method: "PATCH",
      body: JSON.stringify({
        wallet,
        linked_at: nowIso,
        // Spent. A code that survives its claim is a code that can be claimed twice.
        link_code: null,
        code_expires_at: null,
      }),
    },
  });
  if (isSchemaMissing(status, text)) {
    return schemaMissing(res, "your code was not claimed and no chat was bound");
  }
  if (status >= 400) {
    console.error("botLink claim failed:", status, logSafe(text.slice(0, 300)));
    return res.status(502).json({ error: "The link was not completed." });
  }
  const rows = parseRows(text);
  if (rows === null) {
    return res.status(502).json({ error: "The link store returned an unexpected shape." });
  }
  res.setHeader("Cache-Control", "no-store");
  if (rows.length === 0) {
    // Expired, already claimed, or never existed. Deliberately one message for all
    // three: distinguishing them turns this into an oracle for guessing codes.
    return res.status(404).json({
      error: "That code is not open. Codes last ten minutes and can be used once — send the bot /link for a new one.",
      code: "code-not-open",
    });
  }
  return res.status(201).json({ linked: true, linkedAt: rows[0]?.linked_at ?? nowIso });
}

/**
 * The caller's own bindings, under their own JWT and therefore under RLS.
 *
 * `chat_ref` is deliberately NOT selected. The owner cannot do anything with the
 * digest, and a response carrying it would put the one value that identifies a
 * Telegram account into browser memory and every intermediate log for no gain.
 */
async function listMine(res, cfg, jwt) {
  const { status, text } = await postgrest(cfg, {
    key: cfg.anonKey,
    jwt,
    path: `${TABLE}?select=id,linked_at&wallet=not.is.null&order=linked_at.desc&limit=${MAX_LINKS_PER_WALLET}`,
    init: { method: "GET" },
  });
  if (isSchemaMissing(status, text)) {
    return schemaMissing(res, "your linked chats could not be read and none could ever have been linked");
  }
  if (status >= 400) {
    console.error("botLink mine failed:", status, logSafe(text.slice(0, 300)));
    return res.status(502).json({ error: "The link store could not be read." });
  }
  const rows = parseRows(text);
  if (rows === null) {
    return res.status(502).json({ error: "The link store returned an unexpected shape." });
  }
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ links: rows });
}

/** Owner-side revocation, under RLS: 020 grants `authenticated` DELETE and nothing else. */
async function revokeMine(res, cfg, jwt, body) {
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid link id." });

  const { status, text } = await postgrest(cfg, {
    key: cfg.anonKey,
    jwt,
    path: `${TABLE}?id=eq.${encodeURIComponent(id)}`,
    init: { method: "DELETE" },
  });
  if (isSchemaMissing(status, text)) {
    return schemaMissing(res, "nothing was unlinked");
  }
  if (status >= 400) {
    console.error("botLink revokeMine failed:", status, logSafe(text.slice(0, 300)));
    return res.status(502).json({ error: "The binding was not removed. It is still in place." });
  }
  const removed = parseRows(text)?.length ?? 0;
  if (removed === 0) {
    // RLS scoped the DELETE to rows this wallet owns, so zero means there was
    // nothing of theirs to delete. Saying "unlinked" here would claim a change
    // that did not happen.
    return res.status(404).json({ error: "No linked chat of yours matched that id, so nothing changed." });
  }
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ removed });
}

// ─── ENTRY ───────────────────────────────────────────────────────────────────

export async function handleBotLink(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = typeof req.body === "string" ? req.body : req.body ? JSON.stringify(req.body) : "";
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return res.status(413).json({ error: "Request body too large" });
  }
  let body = {};
  if (rawBody) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ error: "Body is not JSON" });
    }
  }

  const botSignature = req.headers?.["x-bot-signature"];
  const isBotCall = typeof botSignature === "string" && botSignature.length > 0;

  // The browser gate. Skipped for bot calls, which have no Origin to check and
  // carry a signature instead — never skipped for anything else.
  if (!isBotCall && !isRequestOriginAllowed(req)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  const allowed = await checkRateLimit(req, res, {
    // The bot is one host making many calls for many users, so it gets its own
    // bucket. Sharing the browser's would let a busy chat exhaust the limit for
    // every signed-in user on the same edge.
    limit: isBotCall ? 120 : 30,
    windowSec: 60,
    identifier: isBotCall ? "bot-link-service" : "bot-link",
  });
  if (!allowed) return;

  const cfg = supabaseConfig();
  if (!cfg) {
    // 503, never a shape that reads as an answer. A deployment with no store must
    // not tell a chat it is unlinked, and must not tell a bot to keep minting.
    return res.status(503).json({
      error:
        "This deployment has no Telegram link store configured, so no chat can be linked, read or unlinked. Nothing here says your chat is unlinked.",
      code: "not-configured",
      operatorStep: CONFIG_STEP,
    });
  }

  try {
    if (isBotCall) {
      const verdict = verifyBotSignature({
        secret: process.env.BOT_LINK_SECRET,
        timestamp: req.headers?.["x-bot-timestamp"],
        signature: botSignature,
        rawBody: canonicalBotBody(body),
      });
      if (!verdict.ok) {
        if (verdict.code === "not-configured") {
          return res.status(503).json({
            error: "This deployment has no bot secret configured, so no bot request can be authenticated.",
            code: "not-configured",
            operatorStep: CONFIG_STEP,
          });
        }
        return res.status(401).json({ error: "Bot request not authenticated", code: verdict.code });
      }
      if (!cfg.serviceKey) {
        return res.status(503).json({
          error: "This deployment cannot reach the link store as the service role, so no chat state was read or written.",
          code: "not-configured",
          operatorStep: CONFIG_STEP,
        });
      }

      const chatRef = typeof body.chatRef === "string" ? body.chatRef.trim().toLowerCase() : "";
      if (!CHAT_REF_RE.test(chatRef)) {
        // A caller sending a raw Telegram id instead of a digest lands here, which
        // is the point: the id has no shape that this endpoint accepts.
        return res.status(400).json({ error: "chatRef must be a 64-character lowercase hex digest." });
      }

      if (body.action === "begin") return await botBegin(res, cfg, chatRef);
      if (body.action === "status") return await botStatus(res, cfg, chatRef);
      if (body.action === "revoke") return await botRevoke(res, cfg, chatRef);
      return res.status(400).json({ error: "Unknown action." });
    }

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

    // Revocation parity with alerts.js / referrals.js / supabase-proxy.js: without
    // this a logged-out JWT keeps binding chats for its full lifetime.
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
          console.error("botLink revocation check failed:", logSafe(err));
          return res.status(503).json({ error: "Authentication temporarily unavailable" });
        }
      } else if (isProdLike) {
        return res.status(503).json({ error: "Auth service not configured" });
      }
    }

    if (req.method === "GET") return await listMine(res, cfg, jwt);
    if (body.action === "claim") return await claimCode(res, cfg, wallet, body);
    if (body.action === "revoke") return await revokeMine(res, cfg, jwt, body);
    return res.status(400).json({ error: "Unknown action." });
  } catch (err) {
    console.error("botLink error:", logSafe(err));
    return res.status(502).json({ error: "The Telegram link store could not be reached." });
  }
}
