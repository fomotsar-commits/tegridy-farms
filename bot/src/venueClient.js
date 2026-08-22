// The bot's network boundary to memetic.fun. Two kinds of call go through here and
// they are authenticated differently, which is the architecture showing through.
//
//   PRIVILEGED (link/status/unlink) — signed with BOT_LINK_SECRET. The venue side
//   is frontend/api/_lib/botLink.js; the signing string is built by the same
//   formula on both ends and `venueClient.test.js` proves it by importing the
//   verifier from the API and feeding it what this file produced. A drift between
//   the two would show up as every bot call 401ing, which is at least loud — but
//   only if something checks, so something does.
//
//   PUBLIC (heat) — no credential. It is a read anyone may make.
//
// ON THE ORIGIN HEADER. The venue's resources enforce a browser origin allowlist.
// This process is not a browser and does not pretend otherwise: it sends the venue
// origin because that gate is a browser control (it stops a third-party PAGE from
// spending our upstream quota) and satisfying it is what any first-party server
// client must do. The gate is NOT what authenticates the privileged calls — the
// HMAC is — and nothing here is admitted by the header alone.
//
// FAIL-CLOSED, always. Every function returns a discriminated result and none of
// them ever returns an empty-looking success. "The venue did not answer" and "the
// answer is no" are different facts about a user's wallet and the command layer
// renders them as different sentences.

import { createHmac } from "node:crypto";

/** Under any platform's default, so a hung venue surfaces as our own honest error. */
export const VENUE_TIMEOUT_MS = 8000;

/** A link/status response is a few short fields. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * The two fields a bot request carries, in a fixed order.
 *
 * Must stay byte-identical to `canonicalBotBody` in frontend/api/_lib/botLink.js —
 * that side rebuilds this string from the PARSED body, because Vercel parses before
 * a handler sees the request and re-serialising is not guaranteed to reproduce the
 * wire bytes. This form is what is signed AND what is sent, so the two are the same
 * either way.
 */
export function canonicalBotBody(body) {
  return JSON.stringify({ action: body?.action ?? null, chatRef: body?.chatRef ?? null });
}

/** Must stay byte-identical to `botSigningString` in frontend/api/_lib/botLink.js. */
export function botSigningString(timestamp, rawBody) {
  return `${timestamp}.${rawBody}`;
}

export function signBotRequest(secret, timestamp, rawBody) {
  return createHmac("sha256", secret).update(botSigningString(timestamp, rawBody), "utf8").digest("hex");
}

/**
 * @typedef {{ok: true, data: object}} VenueOk
 * @typedef {{ok: false, reason: string, detail: string, operatorStep?: string}} VenueFail
 */

/** `reason` values. The command layer branches on these, never on a message string. */
export const VENUE_FAIL = Object.freeze({
  /** The bot host could not reach the venue, or it timed out or 5xx'd. */
  UNREACHABLE: "unreachable",
  /** The venue answered, and the answer was an error about this request. */
  REJECTED: "rejected",
  /** The venue answered 200 with something we cannot trust. */
  MALFORMED: "malformed",
  /** The venue is missing a migration or a variable. An operator's problem. */
  NOT_READY: "not-ready",
});

async function readJson(res) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    return text.length > MAX_RESPONSE_BYTES ? null : safeParse(text);
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return safeParse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8"));
}

function safeParse(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/**
 * One signed call.
 *
 * `fetchImpl` is injected so tests exercise the real signing and the real response
 * handling without a network. Production passes nothing and gets global fetch.
 */
export async function callBotLink(cfg, action, { fetchImpl = fetch, now = Date.now } = {}) {
  if (!cfg.linkSecret) {
    // Cannot happen through index.js (fatalConfigProblems refuses to boot without
    // it) and is still a real branch, because a caller that constructs its own
    // config must not silently sign with "undefined".
    return {
      ok: false,
      reason: VENUE_FAIL.NOT_READY,
      detail: "This bot has no BOT_LINK_SECRET, so it cannot prove itself to the venue and made no request.",
    };
  }
  const rawBody = canonicalBotBody(action);
  const timestamp = String(Math.floor(now() / 1000));
  const signature = signBotRequest(cfg.linkSecret, timestamp, rawBody);

  const url = `${cfg.venueOrigin}/api/aggregator?resource=bot-link`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), VENUE_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: cfg.venueOrigin,
        "X-Bot-Timestamp": timestamp,
        "X-Bot-Signature": signature,
      },
      body: rawBody,
      signal: ac.signal,
    });
  } catch {
    return {
      ok: false,
      reason: VENUE_FAIL.UNREACHABLE,
      detail: "The venue did not answer, so nothing was read or changed.",
    };
  } finally {
    clearTimeout(timer);
  }

  const body = await readJson(res);
  if (res.status >= 500 && res.status !== 503) {
    return { ok: false, reason: VENUE_FAIL.UNREACHABLE, detail: "The venue could not answer." };
  }
  if (res.status === 503 || body?.code === "schema-missing" || body?.code === "not-configured") {
    // 503 is the venue telling us it is not set up — a missing migration or a
    // missing variable. Never collapsed into "unreachable": one needs an operator
    // to run a file, the other needs nobody to do anything.
    return {
      ok: false,
      reason: VENUE_FAIL.NOT_READY,
      detail: typeof body?.error === "string" ? body.error : "The venue is not configured for Telegram linking.",
      operatorStep: typeof body?.operatorStep === "string" ? body.operatorStep : undefined,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: VENUE_FAIL.REJECTED,
      detail: typeof body?.error === "string" ? body.error : "The venue rejected that request.",
      code: typeof body?.code === "string" ? body.code : undefined,
      wallet: typeof body?.wallet === "string" ? body.wallet : undefined,
    };
  }
  if (!body) {
    return { ok: false, reason: VENUE_FAIL.MALFORMED, detail: "The venue answered with something unreadable." };
  }
  return { ok: true, data: body };
}

export const beginLink = (cfg, chatRef, opts) => callBotLink(cfg, { action: "begin", chatRef }, opts);
export const readLink = (cfg, chatRef, opts) => callBotLink(cfg, { action: "status", chatRef }, opts);
export const revokeLink = (cfg, chatRef, opts) => callBotLink(cfg, { action: "revoke", chatRef }, opts);

/**
 * Heat standing for one address, forwarded by the venue from Jungle Bay Island.
 *
 * SCOPE, mirroring api/_lib/heat.js's own boundary: Heat is the ISLAND'S
 * measurement of held time. This bot forwards it. It does not average it, re-tier
 * it, or render it in yield language, and `degrees` is not a price, a yield or a
 * score of ours.
 */
export async function readHeat(cfg, address, { fetchImpl = fetch } = {}) {
  const url = `${cfg.venueOrigin}/api/aggregator?resource=heat&address=${encodeURIComponent(address)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), VENUE_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: "application/json", Origin: cfg.venueOrigin }, signal: ac.signal });
  } catch {
    return {
      ok: false,
      reason: VENUE_FAIL.UNREACHABLE,
      detail: "The heat oracle could not be reached, so nothing is known about this wallet's standing right now.",
    };
  } finally {
    clearTimeout(timer);
  }

  const body = await readJson(res);
  if (res.status === 400) {
    return { ok: false, reason: VENUE_FAIL.REJECTED, detail: "That is not an address the oracle recognises." };
  }
  if (!res.ok) {
    // A 502 here means the island is down. Reporting a low or absent reading
    // instead would be a claim about how long somebody has held, made by a
    // process that failed to ask.
    return {
      ok: false,
      reason: VENUE_FAIL.UNREACHABLE,
      detail: "The heat oracle is unavailable. This is not a reading of zero — nothing was measured.",
    };
  }
  if (!body || typeof body.degrees !== "number") {
    return { ok: false, reason: VENUE_FAIL.MALFORMED, detail: "The heat oracle answered with something unreadable." };
  }
  return { ok: true, data: body };
}
