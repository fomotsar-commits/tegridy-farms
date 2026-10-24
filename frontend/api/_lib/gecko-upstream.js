// gecko-upstream: the one door both GeckoTerminal readers go through
// (`_lib/gecko-read.js` and `_lib/pool-market.js`), and the budget that door keeps.
//
// WHY (found 2026-10-14). A visitor clicking through several bungalows in a row
// got "rate-limiting, try again" on the chart and the trades list, while any one
// bungalow on its own loaded fine. Each bungalow costs three upstream reads (the
// market strip, the candles, the trades), each one a different URL, so the edge
// cache cannot help a first walk through the island. GeckoTerminal's keyless API
// allows about 30 calls a minute, and the two readers between them let through
// 360 a minute (240 + 120) with a 45 second cache. GeckoTerminal refused, and the
// refusal went straight to the screen.
//
// WHAT HAPPENS TO ONE READ, in order:
//  1. A copy this instance read recently enough is answered from memory. No
//     upstream call and no budget spent, the same as an edge-cache hit.
//  2. After GeckoTerminal refuses us (429), nothing here asks it again until the
//     cool-down ends. Asking again at once is how a rate limit turns into a ban.
//  3. Both readers draw on ONE budget per minute, under GeckoTerminal's own
//     limit, shared across every instance through the same Upstash limiter the
//     rest of api/ uses. A read past the budget is not sent.
//  4. When a read cannot be sent, or is refused, a caller that asked for it (the
//     request header X-Gecko-Stale-Ok: 1) gets the last good copy instead, marked
//     `X-Gecko-Stale: 1`. A caller that did not ask gets the refusal: an alert or
//     a display price has nowhere to say how old a number is, so it must never be
//     handed an old one that looks new.
//
// EVERY 200 carries `X-Gecko-Fetched-At` (epoch ms): when this copy was read from
// GeckoTerminal. It is an absolute time on purpose. The edge caches it together
// with the body, so it stays true however the answer reached the page (fresh, an
// edge hit, an edge copy served while it refreshes, or a kept copy from here).
//
// This module performs the FETCH ONLY and forwards the raw JSON:API envelope.
// Every parse stays in the caller's own validated reader in src/.

import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "./bodycap.js";
import { logSafe } from "./logSafe.js";

// The host is a module constant so it can never come from the request.
export const GECKO_BASE = "https://api.geckoterminal.com/api/v2";

// ── The budget ─────────────────────────────────────────────────────────────
// GeckoTerminal's keyless ceiling: about 30 calls a minute (CoinGecko's help
// centre; GeckoTerminal's own API page now quotes 10 for the free tier, which the
// cool-down below absorbs if it is the true figure). The env var can only LOWER
// the budget: a typo or an old value must never lift it past the real limit.
export const GECKO_KEYLESS_PER_MINUTE = 30;
const DEFAULT_BUDGET_PER_MINUTE = 25; // five under the ceiling, for the other GeckoTerminal callers in api/

export function upstreamBudgetPerMinute(env = process.env) {
  const n = Math.floor(Number(env.GECKO_UPSTREAM_RPM));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_BUDGET_PER_MINUTE;
  return Math.min(n, GECKO_KEYLESS_PER_MINUTE);
}

// One identifier for both readers, so the budget is one number and not two.
const BUDGET_ID = "geckoterminal-upstream";

// ── How long an answer stays fresh ──────────────────────────────────────────
// Used for the edge's s-maxage and for this instance's own copy. Candles over
// hours and days, and the list of pools a token trades in, do not need to be
// fresh to the second; a trade tape, a pool's market strip, a pool list and a
// display price get a minute. `stale-while-revalidate` equals the fresh window,
// so an answer reaches a page at most two windows old, and the page can always
// read its true age from X-Gecko-Fetched-At.
const FRESH_SECONDS = [
  [/\/ohlcv\/day$/, 600],
  [/\/ohlcv\/hour$/, 300],
  [/\/tokens\/[^/]+\/pools$/, 600],
];
const DEFAULT_FRESH_SECONDS = 60;

export function freshSecondsFor(path) {
  for (const [re, seconds] of FRESH_SECONDS) if (re.test(path)) return seconds;
  return DEFAULT_FRESH_SECONDS;
}

// ── The kept copies (this instance only) ────────────────────────────────────
// Bounded by count and by bytes; the oldest written goes first. A copy older
// than KEEP_SECONDS is never served, even marked.
const KEEP_SECONDS = 6 * 60 * 60;
const MAX_KEPT = 256;
const MAX_KEPT_BYTES = 24 * 1024 * 1024;
const kept = new Map(); // key -> { json, fetchedAt, bytes }
let keptBytes = 0;

function readKept(key, now) {
  const entry = kept.get(key);
  if (!entry) return null;
  if (now - entry.fetchedAt > KEEP_SECONDS * 1000) {
    kept.delete(key);
    keptBytes -= entry.bytes;
    return null;
  }
  return entry;
}

function writeKept(key, entry) {
  const old = kept.get(key);
  if (old) {
    kept.delete(key);
    keptBytes -= old.bytes;
  }
  kept.set(key, entry);
  keptBytes += entry.bytes;
  while (kept.size > MAX_KEPT || keptBytes > MAX_KEPT_BYTES) {
    const [oldestKey, oldest] = kept.entries().next().value;
    kept.delete(oldestKey);
    keptBytes -= oldest.bytes;
  }
}

// ── The cool-down after GeckoTerminal says 429 ──────────────────────────────
const COOL_DOWN_DEFAULT_SECONDS = 60;
const COOL_DOWN_MIN_SECONDS = 10;
const COOL_DOWN_MAX_SECONDS = 300;
let coolUntil = 0;

function startCoolDown(upstream, now) {
  const asked = Number(upstream.headers?.get?.("retry-after"));
  const seconds = Number.isFinite(asked) && asked > 0 ? asked : COOL_DOWN_DEFAULT_SECONDS;
  const clamped = Math.min(COOL_DOWN_MAX_SECONDS, Math.max(COOL_DOWN_MIN_SECONDS, seconds));
  coolUntil = Math.max(coolUntil, now + clamped * 1000);
}

/** Test seam: the kept copies and the cool-down are module state. */
export function __resetGeckoUpstreamForTests() {
  kept.clear();
  keptBytes = 0;
  coolUntil = 0;
}

// A hung upstream must not hold the function open; the browser gives up at 8s.
const UPSTREAM_TIMEOUT_MS = 8_000;

// ── Headers this door speaks ────────────────────────────────────────────────
export const STALE_OK_REQUEST_HEADER = "x-gecko-stale-ok";
export const FETCHED_AT_HEADER = "X-Gecko-Fetched-At";
export const STALE_HEADER = "X-Gecko-Stale";

/** For each reader's CORS answer, so a cross-origin dev page can send and read them. */
export const GECKO_CORS_ALLOW_HEADERS = "Content-Type, X-Gecko-Stale-Ok";
export const GECKO_CORS_EXPOSE_HEADERS = "X-Gecko-Fetched-At, X-Gecko-Stale, Retry-After";

function wantsKeptCopy(req) {
  return String(req.headers?.[STALE_OK_REQUEST_HEADER] ?? "") === "1";
}

/**
 * A stand-in response for the shared limiters. checkRateLimit / checkGlobalLimit
 * answer the visitor themselves when they refuse; this lets them decide WITHOUT
 * answering, so a refused read can still be served a kept copy.
 */
function verdictSink() {
  const headers = {};
  const res = {
    setHeader(k, v) { headers[k] = v; return res; },
    status() { return res; },
    json() { return res; },
    end() { return res; },
  };
  return { res, headers, retryAfter: () => Number(headers["Retry-After"]) || null };
}

function sendCopy(res, entry, { sMaxAge, swr }) {
  res.setHeader(FETCHED_AT_HEADER, String(entry.fetchedAt));
  res.setHeader("Cache-Control", `s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`);
  return res.status(200).json(entry.json);
}

function sendKeptAfterRefusal(res, entry) {
  res.setHeader(FETCHED_AT_HEADER, String(entry.fetchedAt));
  res.setHeader(STALE_HEADER, "1");
  // Never cached at the edge: the next visitor should get a fresh read the
  // moment one can be sent, and a caller that did not ask must never see this.
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(entry.json);
}

/**
 * Serve one GeckoTerminal read through the budget, the cool-down and the kept
 * copies. The caller has already checked origin, method and the path allowlist.
 *
 * @param {object} req
 * @param {object} res
 * @param {{ path: string, query?: string, accept?: string, perIpLimit: number, identifier: string }} opts
 */
export async function serveGeckoRead(req, res, opts) {
  const { path, query = "", accept = "application/json", perIpLimit, identifier } = opts;
  const freshSeconds = freshSecondsFor(path);
  const url = `${GECKO_BASE}${path}${query ? `?${query}` : ""}`;
  const key = `${accept} ${url}`;
  const now = Date.now();
  const copy = readKept(key, now);
  const keptOk = wantsKeptCopy(req);

  // 1. Fresh enough from memory: no upstream call, no budget spent.
  const ageMs = copy ? now - copy.fetchedAt : Infinity;
  if (copy && ageMs < freshSeconds * 1000) {
    const sMaxAge = Math.max(1, Math.floor((freshSeconds * 1000 - ageMs) / 1000));
    return sendCopy(res, copy, { sMaxAge, swr: freshSeconds });
  }

  // A read that cannot be sent: the kept copy if the caller asked and one exists,
  // otherwise a 429 the readers in src/ already word as "try again in a moment".
  const refuse = (retryAfterSec, error) => {
    if (keptOk && copy) return sendKeptAfterRefusal(res, copy);
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterSec))));
    return res.status(429).json({ error });
  };
  // A read that was sent and failed some other way.
  const failed = (status, error) => {
    if (keptOk && copy) return sendKeptAfterRefusal(res, copy);
    return res.status(status).json({ error });
  };

  // 2. GeckoTerminal asked us to wait.
  if (now < coolUntil) {
    return refuse((coolUntil - now) / 1000, "GeckoTerminal is rate-limiting; waiting before asking again");
  }

  // 3. One caller's share, then everyone's budget.
  const perIp = verdictSink();
  const ipOk = await checkRateLimit(req, perIp.res, { limit: perIpLimit, windowSec: 60, identifier });
  for (const [k, v] of Object.entries(perIp.headers)) {
    if (k.startsWith("X-RateLimit-")) res.setHeader(k, v);
  }
  if (!ipOk) return refuse(perIp.retryAfter() ?? 60, "Too many requests");

  const budget = verdictSink();
  const budgetOk = await checkGlobalLimit(budget.res, {
    limit: upstreamBudgetPerMinute(),
    windowSec: 60,
    identifier: BUDGET_ID,
  });
  if (!budgetOk) return refuse(budget.retryAfter() ?? 60, "This minute's GeckoTerminal budget is spent");

  // 4. The read itself. One attempt, never retried here.
  let upstream;
  try {
    upstream = await fetch(url, {
      headers: { Accept: accept },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`${identifier} error:`, logSafe(err));
    return failed(502, "Failed to read upstream");
  }

  if (upstream.status === 429) {
    startCoolDown(upstream, Date.now());
    return refuse((coolUntil - Date.now()) / 1000, "Upstream HTTP 429");
  }
  // A 404 is an answer ("no pool there"), not a refusal: no kept copy stands in for it.
  if (upstream.status === 404) return res.status(404).json({ error: "Upstream HTTP 404" });
  if (!upstream.ok) return failed(502, `Upstream HTTP ${upstream.status}`);

  const { text, truncated } = await readBoundedText(upstream, MAX_RESPONSE_BYTES);
  if (truncated) return failed(502, "Upstream response too large");

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return failed(502, "Upstream response was not JSON");
  }

  const entry = { json, fetchedAt: Date.now(), bytes: text.length };
  writeKept(key, entry);
  // The edge header is what keeps upstream at about one read per URL per window
  // however many people are reading. Set ONLY on a 200: caching a failure would
  // pin the outage in front of every visitor for the whole window.
  return sendCopy(res, entry, { sMaxAge: freshSeconds, swr: freshSeconds });
}
