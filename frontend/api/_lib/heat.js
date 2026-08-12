// Heat-oracle resource adapter — the network boundary for Jungle Bay Island's
// held-time instrument (memetics.wtf, keyless, read-only).
//
// WHY THIS LIVES IN THE AGGREGATOR CATCHALL (not a new api/*.js file):
//   Vercel Hobby caps a deployment at 12 serverless functions and we are at 11.
//   This is dispatched from api/aggregator.js via ?resource=heat behind a LAZY
//   dynamic import, so the swap hot-path never loads it and the function count is
//   unchanged. Same rationale as launch-radar.js. See api/SERVERLESS_BUDGET.md.
//
// WHY IT MUST BE SERVER-SIDE (this one is not a preference):
//   The upstream answers with `Access-Control-Allow-Origin: https://junglebayisland.lat`.
//   A browser fetch from our origin is blocked by CORS and there is no client-side
//   workaround. Proxying here also means the browser only ever talks to `'self'`, so
//   the CSP in vercel.json needs no new connect-src entry.
//
// SCOPE / HONESTY BOUNDARY (read before extending):
//   Heat is THE ISLAND'S measurement, not ours. We forward it; we do not compute it,
//   average it, re-tier it, or present it as a Tegridy score. Any UI must attribute it
//   to Jungle Bay Island and surface the reckoning date, because a stale ruler
//   certifies nothing. `degrees` is held-time, NOT yield, NOT points, NOT a price —
//   never render it in yield language.
//
//   This adapter is DISPLAY-GRADE. It deliberately does not implement the spec's
//   fail-closed gate semantics: gating a launch on a wallet's score is a separate,
//   enforcing code path (see launchService.launchToken / submitLaunch), and it must
//   not be built on a cached, best-effort read.

import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { isOriginAllowed } from "./aggregator-proxy.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "./bodycap.js";
import { logSafe } from "./logSafe.js";

// ── Config ───────────────────────────────────────────────────────────────
// Bound as a module constant. NOTHING from `req` may reach the host — the path
// interpolates a caller-supplied address, which is the SSRF boundary for this file.
const HEAT_BASE = "https://memetics.wtf/api/heat";

// The upstream is a third party we do not control and whose quota we would be
// spending. Keep the client timeout well under Vercel's default so a hanging
// upstream surfaces as an honest 504 from us rather than a platform timeout.
//
// AND under the BROWSER's ceiling: heatClient.ts aborts at 6000ms per the directive's
// "hard timeout (<=6s)". If this budget were >= that, a hanging island would always be
// the browser's abort ("unreachable, try again") and our specific 502 would be dead
// code. 4500ms leaves ~1.5s of headroom for our own JSON round-trip so the honest
// upstream-failure message is the one that actually reaches the user. Keep this
// strictly below CLIENT_TIMEOUT_MS if either number moves.
const UPSTREAM_TIMEOUT_MS = 4500;

// Anchored and character-class-restricted, so no traversal, scheme or query
// character can survive into the upstream path. Identical to the pair already used
// for the dual-chain /scan route in middleware.js.
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Same credentialed-CORS origin set the rest of the api/ surface uses.
// Registered in api/__tests__/origin-allowlist-parity.test.js — if you edit this
// array, edit it there too or CI goes red.
const ALLOWED_ORIGINS = [
  "https://memetic.fun",
  "https://www.memetic.fun",
  "https://memetics.finance",
  "https://www.memetics.finance",
  "https://tegridyfarms.vercel.app",
];
if (process.env.NODE_ENV === "development") {
  ALLOWED_ORIGINS.push("http://localhost:5173", "http://localhost:3000");
}

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ── Handler ────────────────────────────────────────────────────────────────
export async function handleHeat(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ENFORCE the origin — `setCors` only sets a header. This proxy exists precisely
  // BECAUSE the island CORS-locks its oracle to junglebayisland.lat; without a 403 here
  // we are the open proxy that lock was meant to prevent, spending the island's shared
  // 100/min budget under our egress reputation on behalf of anyone with curl.
  if (!isOriginAllowed(req.headers?.origin || "")) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  // Per-IP budget, then a global one. The global cap is the only control that stops a
  // distributed scrape routed through our origin from burning a third party's quota
  // under our egress IP reputation — our Vercel IPs are shared.
  const allowed = await checkRateLimit(req, res, {
    limit: 20,
    windowSec: 60,
    identifier: "heat",
  });
  if (!allowed) return;

  const underCap = await checkGlobalLimit(res, {
    limit: Number(process.env.HEAT_GLOBAL_RPM) || 300,
    windowSec: 60,
    identifier: "heat",
  });
  if (!underCap) return;

  const address = String(req.query.address || "").trim();
  if (!ETH_ADDRESS_RE.test(address) && !SOLANA_ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: "Invalid address" });
  }

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(`${HEAT_BASE}/${address}`, {
        headers: { Accept: "application/json" },
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // A 400 from upstream means the address failed THEIR validation after passing
    // ours — forward it as a 400 rather than dressing it up as our own failure.
    if (resp.status === 400) {
      return res.status(400).json({ error: "Invalid address" });
    }
    if (!resp.ok) {
      return res.status(502).json({ error: "Heat oracle unavailable" });
    }

    const { text, truncated } = await readBoundedText(resp, MAX_RESPONSE_BYTES);
    if (truncated) {
      return res.status(502).json({ error: "Upstream response too large" });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: "Heat oracle returned non-JSON" });
    }

    // Re-emit as JSON rather than forwarding upstream bytes, so Express sets the
    // content type itself and a compromised upstream can never get text/html
    // rendered from our trusted origin (audit [H-22]).
    //
    // `observedAt` is OUR read time, kept distinct from the upstream's `as_of_unix`
    // (when the island last recalculated). The UI needs both: one says how fresh our
    // fetch is, the other says how fresh the JUDGEMENT is, and only the second one
    // decides whether a reading is stale.
    //
    // The upstream sends `Cache-Control: no-store`. We keep our own edge cache to a
    // short window — long enough to absorb a page refresh, far short of the
    // recommended 7-day staleness window, so a cached copy can never be the reason a
    // reading goes stale.
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
    return res
      .status(200)
      .json({ ...parsed, observedAt: Math.floor(Date.now() / 1000) });
  } catch (err) {
    // AbortError included: a timeout is an outage, and an outage must never be
    // reported as a low score.
    console.error("heat error:", logSafe(err));
    return res.status(502).json({ error: "Heat oracle unavailable" });
  }
}
