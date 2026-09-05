// Launch-radar resource adapter — the network boundary for the MARKET-WIDE new-pool
// feed (GeckoTerminal `new_pools`, keyless).
//
// WHY THIS LIVES IN THE AGGREGATOR CATCHALL (not a new api/*.js file):
//   Vercel Hobby caps a deployment at 12 serverless functions (main=9). This is
//   dispatched from api/aggregator.js via ?resource=launch-radar behind a LAZY
//   dynamic import, so the swap hot-path never loads it and the function count is
//   unchanged. Same rationale as launcher-outcomes.js. See api/SERVERLESS_BUDGET.md.
//
// SCOPE / HONESTY BOUNDARY (read before extending):
//   This returns pools launched ACROSS THE WHOLE MARKET — it is NOT a list of
//   tokens that launched on the Tegridy rail. The Tegridy cohort surfaces
//   (LaunchExplorer / LaunchAfterlife, fed by `baselines` + launcher-outcomes)
//   promise tokens that graduated THROUGH THIS RAIL and MUST stay integrator-
//   filtered and honestly empty until a real launch graduates. Feeding this
//   market-wide data into those surfaces would fabricate a track record. The
//   client renders it in a separately-labelled "Launch Radar" section only.
//
// It performs the FETCH ONLY. The parse/normalise is the pure, unit-tested
// mapNewPoolsToBaselines() in src/lib/launcher/discovery.ts, which runs client-side
// on the raw JSON forwarded here — so this adapter stays a thin, cacheable pipe and
// the hostile-JSON handling has exactly one tested implementation.

import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { isRequestOriginAllowed } from "./aggregator-proxy.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "./bodycap.js";
import { logSafe } from "./logSafe.js";

// ── Config ───────────────────────────────────────────────────────────────
const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const GECKO_NETWORK = "eth";

// GeckoTerminal returns 20 pools/page. Two pages is a useful radar window without
// making the client parse a wall of noise or hammering a keyless upstream.
const MAX_PAGES = 2;

// Same credentialed-CORS origin set the rest of the api/ surface uses
// (api/etherscan.js, _lib/launcher-outcomes.js).
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

// Returns null on ANY failure or 429 (never throws). Null means UNREAD, not "no pools":
// the caller must turn a page it could not read into a status or a flagged body, never
// into an empty `data[]` on a 200. Mirrors launcher-outcomes.js geckoFetchJson.
async function geckoFetchJson(url) {
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (resp.status === 429 || !resp.ok) return null;
  const { text, truncated } = await readBoundedText(resp, MAX_RESPONSE_BYTES);
  if (truncated) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Handler ────────────────────────────────────────────────────────────────
export async function handleLaunchRadar(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  // ENFORCE the origin — `setCors` only sets a header. Dispatched before runProxy, so
  // this branch does not inherit aggregator-proxy.js's 403 and must apply it itself.
  if (!isRequestOriginAllowed(req)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  // Keyless upstream with a shared IP budget — throttle like the sibling resource.
  const allowed = await checkRateLimit(req, res, {
    limit: 20,
    windowSec: 60,
    identifier: "launch-radar",
  });
  if (!allowed) return;

  // Per-IP bounds one caller; the aggregate breaker bounds the fleet against a shared
  // keyless upstream that rate-limits US, not the individual visitor.
  const underCap = await checkGlobalLimit(res, {
    limit: Number(process.env.LAUNCH_RADAR_GLOBAL_RPM) || 120,
    windowSec: 60,
    identifier: "launch-radar",
  });
  if (!underCap) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Sequential (not parallel) so a keyless upstream sees one request at a time.
    // A null page (429/failure/oversize) ends the walk — partial data is still a
    // truthful radar; it just shows fewer rows.
    //
    // OUTAGE-AS-ZERO. The walk ended the same way whether the upstream said "no new
    // pools" or refused to answer, and both left `data` exactly as they found it. So
    // remember WHICH happened: a refusal on the FIRST page means nothing was observed
    // at all, and the empty `data[]` that went out asserted that the whole market
    // launched nothing in the window. An empty-but-present `data` array below is a
    // real answer and is NOT a failure.
    const data = [];
    let readFailed = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const json = await geckoFetchJson(
        `${GECKO_BASE}/networks/${GECKO_NETWORK}/new_pools?page=${page}`,
      );
      if (!json || !Array.isArray(json.data)) {
        readFailed = true;
        break;
      }
      data.push(...json.data);
      if (json.data.length === 0) break;
    }

    // Nothing was read at all — the first page was refused, throttled or unparseable.
    // There is no honest 200 to send here: an empty `data[]` with a fresh `observedAt`
    // says we looked at that second and the market launched nothing, which is a claim
    // about the market made out of our own throttling. Answer with a status, the way
    // _lib/heat.js and api/etherscan.js answer an unreadable upstream, and set NO
    // Cache-Control — a 60s shared-edge cache (plus 300s SWR) would pin one keyless
    // hiccup in front of every visitor for the whole TTL. Same body as the catch below,
    // so both unread paths look identical on the wire. Both browser callers already
    // degrade correctly on a non-2xx — LaunchRadar.tsx to "Radar unavailable right now…
    // a data outage on our side, not a signal about any token", alerts/readers.ts to
    // "an outage, not an absence of launches" — so this makes those reachable at last.
    if (readFailed && data.length === 0) {
      console.error("launch-radar upstream unread: new_pools page 1 refused, throttled or unparseable");
      return res.status(502).json({ error: "Failed to read new pools" });
    }

    // Forward the raw JSON:API `data[]` for the pure client mapper. `observedAt`
    // is the fetch time so the UI can state how fresh the read is rather than
    // implying live data.
    //
    // `poolsReadFailed` is launcher-outcomes.js's `marketReadFailed` bit on this wire: a
    // LATER page was refused, so these rows are real but the window is SHORT and the UI
    // must not present it as the whole picture. A plain boolean, so a body cached before
    // this shipped reads false and keeps its old meaning. The `Observed` half of that
    // pair is the status code here — a 200 IS the statement that we read the feed at
    // `observedAt`, and the unread case above never gets one.
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json({
      data,
      observedAt: Math.floor(Date.now() / 1000),
      poolsReadFailed: readFailed,
    });
  } catch (err) {
    console.error("launch-radar error:", logSafe(err));
    return res.status(502).json({ error: "Failed to read new pools" });
  }
}
