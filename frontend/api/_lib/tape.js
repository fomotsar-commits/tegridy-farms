// Named-tape resource adapter — wave seven, element N.
//
// The room's trade tape identifies a buyer by a truncated wallet address. This
// turns the ones the island knows into names: handle, tier, days held. Rows the
// island does not know are returned unchanged, which is the element's own rule.
//
// WHY THIS LIVES IN THE AGGREGATOR CATCHALL (not a new api/*.js file):
//   Dispatched from api/aggregator.js via ?resource=tape behind a LAZY dynamic
//   import, so the swap hot-path never loads it and the function count is
//   unchanged. Same rationale as heat.js and flames.js. The 12-function cap is
//   lifted on Pro, so this is a CONTRACT choice rather than a platform one:
//   the island ruled the tape gets its own door so the rate limit stops biting.
//
// WHY IT MUST BE SERVER-SIDE, and why it is not just N calls from the browser:
//   The heat oracle answers with a CORS lock, so the browser cannot read it at
//   all. And fanning twelve reads out from the page would spend heat's own
//   20/min bucket twelve rows at a time — one room render would 429 the next.
//   This is the fan-out, bounded and cached, behind ONE request from the page.
//
// THE STRIP, and it is the point of this file as much as it is of flames.js:
//   The island's heat envelope carries far more than a name — the whole
//   per-token breakdown of a stranger's wallet, every contract they hold and
//   when they first held it. A tape row needs three fields. Forwarding the rest
//   would publish a buyer's entire portfolio next to their trade, to anyone who
//   opens a room.
//
//   So the reducer below is an ALLOWLIST of three keys, for the same reason
//   flames.js uses one: a denylist forwards whatever the island adds next,
//   silently. A missing field is a visible bug; a published portfolio is not.
//
//   `x_pfp` is NOT forwarded here either, for flames.js's reason: an off-origin
//   avatar is a CSP entry and every viewer's IP handed to whoever hosts it.
//
// FAILURE LEAVES THE ROW. A wallet whose read fails, times out, or comes back
// unparseable resolves to `null` and the row is returned WITHOUT a name. It is
// never dropped, never retried into the caller's latency, and never rendered as
// "unnamed" when the truth is "we could not ask" — the tape shows the address it
// always showed. An outage must never read as a fact about a person.

import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { isOriginAllowed, isRequestOriginAllowed } from "./aggregator-proxy.js";
import { readBoundedText } from "./bodycap.js";
import { logSafe } from "./logSafe.js";

// ── Config ───────────────────────────────────────────────────────────────
// Bound as a module constant. NOTHING from `req` reaches the host except a
// validated address, which is the SSRF boundary for this file.
const HEAT_BASE = "https://memetics.wtf/api/heat";

// Below the browser's own ceiling for the same reason heat.js states: if this
// were >= the client's abort, a hanging island would always surface as the
// browser's timeout and our honest 502 would be dead code.
const UPSTREAM_TIMEOUT_MS = 4500;

// One tape is twelve rows (usePoolTrades' default limit), so twelve is the whole
// job rather than a page size. Clamped hard: an unbounded list is an
// amplification lever pointed at a third party's quota, with our egress
// reputation on it.
const MAX_ADDRESSES = 12;

// FOUR IN FLIGHT. Not twelve: the island is one small service and a room render
// should look like a visitor, not a scraper. Not one: twelve serial reads at
// 4.5s worst case exceeds the platform's patience and the page's.
const CONCURRENCY = 4;

// A stranger's flame is ~200 bytes. Cap far under bodycap's default so a
// mistaken upstream cannot make us buffer a megabyte per row.
const MAX_BYTES = 64 * 1024;

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The only three fields a tape row may learn about a stranger. */
const PUBLIC_TAPE_KEYS = ["x_handle", "tier", "held_since_unix"];

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/** Reduce one upstream heat envelope to what a tape row may paint. */
function toPublicName(envelope) {
  const out = {};
  if (!envelope || typeof envelope !== "object") return out;
  for (const key of PUBLIC_TAPE_KEYS) {
    if (key in envelope) out[key] = envelope[key];
  }
  // `as_of` rides along because DAYS cannot be computed without it: the island's
  // reckoning is held_since -> as_of, never our clock. A row that carried
  // held_since alone would force the browser to date it against `Date.now()`,
  // which drifts per viewer and would make two people see different days for the
  // same buyer.
  if (typeof envelope.as_of_unix === "number") out.as_of_unix = envelope.as_of_unix;
  return out;
}

function isSupported(address) {
  return ETH_ADDRESS_RE.test(address) || SOLANA_ADDRESS_RE.test(address);
}

/** One address -> its public name, or null. NEVER throws. */
async function readOne(address) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const resp = await fetch(`${HEAT_BASE}/${address}`, {
      headers: { Accept: "application/json" },
      signal: ac.signal,
    });
    if (!resp.ok) return null;
    // `{ text, truncated }`, not a string. A truncated body is a failure, not a
    // partial name: JSON.parse on half an envelope throws anyway, and treating
    // it as one would be reading a stranger's identity out of a broken read.
    const { text, truncated } = await readBoundedText(resp, MAX_BYTES);
    if (truncated) return null;
    const parsed = JSON.parse(text);
    const named = toPublicName(parsed);
    // A flame with no handle is not a name. Returning the tier alone would put a
    // stranger's standing beside their trade without them ever having asked to
    // be on the board — the island's naming is opt-in at its own door.
    if (!named.x_handle) return null;
    return named;
  } catch {
    // Timeout, abort, non-JSON, oversized body: all the same answer. The row
    // keeps its address.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Read every address with at most CONCURRENCY in flight. Order is preserved. */
async function readAll(addresses) {
  const out = new Array(addresses.length).fill(null);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= addresses.length) return;
      out[i] = await readOne(addresses[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, addresses.length) }, worker),
  );
  return out;
}

// ── Handler ────────────────────────────────────────────────────────────────
export async function handleTape(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ENFORCE the origin — setCors only sets a header. Without the 403 we are the
  // open proxy the island's CORS lock exists to prevent, and this one fans out
  // twelve upstream reads per call.
  if (!isRequestOriginAllowed(req)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  // ITS OWN BUCKET, which is the whole reason the island gave the tape a door.
  // Sharing heat's 20/min would let one room render spend twelve of it and 429
  // the next visitor's instrument. Lower than flames' 30 because each call here
  // costs up to twelve upstream reads, not one.
  const allowed = await checkRateLimit(req, res, {
    limit: 10,
    windowSec: 60,
    identifier: "tape",
  });
  if (!allowed) return;

  // windowSec is REQUIRED. ratelimit.js builds Upstash's window as `${windowSec} s`;
  // without it production answered every tape read with a 500 ("Unable to parse
  // window size: undefined s") while the in-memory limiter used off Vercel took the
  // undefined silently. rateLimitWindows.test.js now pins this for every caller.
  const underCap = await checkGlobalLimit(res, {
    limit: Number(process.env.TAPE_GLOBAL_RPM) || 120,
    windowSec: 60,
    identifier: "tape",
  });
  if (!underCap) return;

  const raw = typeof req.query.addresses === "string" ? req.query.addresses : "";
  // De-duplicated BEFORE the clamp, so a tape where one buyer takes six rows
  // spends one upstream read and still fills its twelve.
  const wanted = [...new Set(raw.split(",").map((a) => a.trim()).filter(Boolean))]
    .filter(isSupported)
    .slice(0, MAX_ADDRESSES);

  if (wanted.length === 0) {
    // Not an error: a tape whose rows carry no wallet is a real state, and an
    // empty answer is the honest one. 200 so the caller renders its rows.
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({ names: {} });
  }

  try {
    const results = await readAll(wanted);
    const names = {};
    wanted.forEach((address, i) => {
      if (results[i]) names[address] = results[i];
    });
    // Five minutes, like the board. A name changes at the island's door, not per
    // trade, so a fresher window would spend the island's quota for nothing.
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({ names });
  } catch (e) {
    // Only an unexpected fault reaches here — readOne swallows its own. Answer
    // 200 with no names rather than 502: the tape's rows are already on screen
    // and are not this call's to invalidate.
    logSafe("tape: unexpected failure", e);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ names: {} });
  }
}
