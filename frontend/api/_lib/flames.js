// Flames-board resource adapter — the network boundary for Jungle Bay Island's
// public leaderboard (memetics.wtf, keyless, read-only).
//
// WHY THIS LIVES IN THE AGGREGATOR CATCHALL (not a new api/*.js file):
//   Vercel Hobby caps a deployment at 12 serverless functions and we are at 11.
//   Dispatched from api/aggregator.js via ?resource=flames behind a LAZY dynamic
//   import, so the swap hot-path never loads it and the function count is
//   unchanged. Same rationale as heat.js. See api/SERVERLESS_BUDGET.md.
//
// WHY IT MUST BE SERVER-SIDE:
//   Same CORS lock as the heat oracle — the upstream answers with
//   `Access-Control-Allow-Origin: https://junglebayisland.lat`, so a browser fetch
//   from our origin is blocked and there is no client-side workaround. Proxying
//   here also keeps the browser talking only to `'self'`, so vercel.json's
//   connect-src needs no new host.
//
// THE STRIP IS THE POINT OF THIS FILE (read before extending):
//   The island's board serves two keys that must never reach a public surface:
//     `person_id`    a stable UUID identifying ONE HUMAN across every wallet
//                    they have linked at the island's door.
//     `wallet_count` how many wallets that human has linked (observed up to 14).
//   Together they de-anonymise the board: they turn "this flame holds 18 tokens"
//   into "this named person controls 14 wallets, and here is their id". The
//   island's law is that neither is ever painted, and stripping HERE makes that
//   law structural instead of a promise a component could forget.
//
//   The strip is an ALLOWLIST, not a denylist, and that is deliberate. The
//   directive's reference implementation used `({ wallet_count, person_id,
//   ...rest }) => rest`. That holds only for the two keys we know about today: if
//   the island ever adds a third identifying field, a denylist forwards it to a
//   public board silently, while an allowlist drops it loudly (a missing field is
//   a visible bug; a leaked identity is not). Adding a key below is a review
//   decision, not a typo.
//
//   `x_pfp` IS served upstream and is deliberately NOT forwarded. It is an
//   off-origin avatar URL: painting it would need a new CSP img-src entry and
//   would leak every board viewer's IP to whoever hosts the image. If the board
//   ever wants avatars, that is its own change with its own review.
//
// SCOPE / HONESTY BOUNDARY:
//   The board is THE ISLAND'S ranking, not ours. We forward it; we do not
//   re-rank, re-tier, recompute or sum it. `degrees` is held-time — NOT yield,
//   NOT points, NOT a price. A failed read is never a zero and never an empty
//   board presented as an empty island: upstream 404 means the board is off, and
//   the card unmounts rather than rendering "nobody is here".

import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { isOriginAllowed, isRequestOriginAllowed } from "./aggregator-proxy.js";
import { readBoundedText } from "./bodycap.js";
import { logSafe } from "./logSafe.js";

// ── Config ───────────────────────────────────────────────────────────────
// Bound as a module constant. NOTHING from `req` may reach the host — only the
// two clamped query values below are interpolated, which is the SSRF boundary
// for this file.
const FLAMES_BASE = "https://memetics.wtf/api/flames";

// Same reasoning as heat.js: stay well under Vercel's default so a hanging
// upstream surfaces as an honest 502 from us rather than a platform timeout.
const UPSTREAM_TIMEOUT_MS = 4500;

// The board is bounded data, unlike a wallet's breakdown: 500 flames of ~200
// bytes is ~100 kB. Cap far tighter than bodycap's 5 MB default so a compromised
// or mistaken upstream cannot make us buffer megabytes for a leaderboard.
const MAX_BYTES = 256 * 1024;

// The instrument reads the whole board (limit=500) for its insertion rank; the
// home card reads 5 and the Island lobby 25. Clamp hard — an unbounded `limit`
// is an amplification lever pointed at a third party's quota.
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 10;

// The exact shape the venue is allowed to see. See the strip note in the header.
const PUBLIC_FLAME_KEYS = [
  "x_username",
  "degrees",
  "tier",
  "held_since_unix",
  "token_count",
];

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  // Single source of truth with the enforcement gate (aggregator-proxy.js),
  // identical to heat.js so the header and the 403 can never drift apart.
  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/**
 * Reduce one upstream flame to the keys the venue may paint.
 * Unknown keys are dropped, including any the island adds after this was written.
 */
function toPublicFlame(flame) {
  const out = {};
  if (!flame || typeof flame !== "object") return out;
  for (const key of PUBLIC_FLAME_KEYS) {
    if (key in flame) out[key] = flame[key];
  }
  return out;
}

// ── Handler ────────────────────────────────────────────────────────────────
export async function handleFlames(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ENFORCE the origin — `setCors` only sets a header. Same reasoning as heat.js:
  // without a 403 here we are the open proxy the island's CORS lock was meant to
  // prevent, spending their quota under our egress reputation for anyone with curl.
  if (!isRequestOriginAllowed(req)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  // Its OWN rate-limit bucket, not heat's. The tape (element N) already spends
  // heat's 20/min budget twelve rows at a time; sharing an identifier here would
  // make a board render and a tape render starve each other. The board is edge
  // cached for five minutes, so a real visitor costs at most one upstream read.
  const allowed = await checkRateLimit(req, res, {
    limit: 30,
    windowSec: 60,
    identifier: "flames",
  });
  if (!allowed) return;

  const underCap = await checkGlobalLimit(res, {
    limit: Number(process.env.FLAMES_GLOBAL_RPM) || 300,
    windowSec: 60,
    identifier: "flames",
  });
  if (!underCap) return;

  // Number() on a garbage string yields NaN, and `NaN || DEFAULT` falls through
  // to the default — so a hostile `?limit=../../etc` cannot reach the upstream.
  const requested = Number(req.query.limit) || DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(requested)));
  const claimed = req.query.claimed === "1" ? "&claimed=1" : "";

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(`${FLAMES_BASE}?limit=${limit}${claimed}`, {
        headers: { Accept: "application/json" },
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // The flame is off. Not an error and NOT an empty board: 204 tells the card
    // to unmount, so the home never renders "nobody is on the island".
    if (resp.status === 404) return res.status(204).end();

    if (!resp.ok) {
      return res.status(502).json({ error: "Board unavailable" });
    }

    const { text, truncated } = await readBoundedText(resp, MAX_BYTES);
    if (truncated) {
      return res.status(502).json({ error: "Upstream response too large" });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: "Board unreadable" });
    }

    // An unreadable board is an outage, never an empty one. Without this an
    // upstream that changed shape would render as "the island has no flames".
    if (!Array.isArray(parsed?.flames)) {
      return res.status(502).json({ error: "Board unreadable" });
    }

    const flames = parsed.flames.map(toPublicFlame);

    // The island's board refreshes at noon UTC and on link and merge events, so a
    // five-minute edge cache is honest — far shorter than the judgement's own life.
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

    // Re-emit as JSON rather than forwarding upstream bytes, so the content type
    // is ours and a compromised upstream can never get text/html rendered from our
    // trusted origin (audit [H-22], same as heat.js).
    return res.status(200).json({
      flames,
      as_of_unix: parsed.as_of_unix ?? null,
    });
  } catch (err) {
    // AbortError included: a timeout is an outage, and an outage must never be
    // reported as an empty board.
    console.error("flames error:", logSafe(err));
    return res.status(502).json({ error: "Board unavailable" });
  }
}
