// The all-time volume counter's one public read, `?resource=venue-volume` on the catchall.
// The counter (api/venue-volume-count.js every five minutes, venue-volume.yml hourly as the
// backup) writes one row per source into venue_volume (migration 028); this sums them for
// the home page. The edge caches it for a minute, so a visitor costs nothing and still sees
// each count soon after it lands. It never answers a partial or failed read with a number:
// a source never counted makes the whole answer "unread", and a failing or late one
// makes it "behind", with the time it was last complete.

import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { isOriginAllowed, isRequestOriginAllowed } from "./aggregator-proxy.js";
import { readBoundedText } from "./bodycap.js";
import { logSafe } from "./logSafe.js";
import { summarize } from "./venueVolumePolicy.js";

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  if (origin && isOriginAllowed(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function unread(res, status) {
  // Short edge cache: a failed read is retried soon, and Supabase is not hammered meanwhile.
  res.setHeader("Cache-Control", "s-maxage=30");
  return res.status(status).json({ state: "unread" });
}

const SELECT = "source,swaps,usd,unpriced,counted_to,last_ok_at,last_error_at";

export async function handleVenueVolume(req, res, { nowMs = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!isRequestOriginAllowed(req)) return res.status(403).json({ error: "Origin not allowed" });
  if (!(await checkRateLimit(req, res, { limit: 30, windowSec: 60, identifier: "venue-volume" }))) return;
  if (!(await checkGlobalLimit(res, { limit: 300, windowSec: 60, identifier: "venue-volume" }))) return;

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return unread(res, 503);
  try {
    const r = await fetchImpl(`${url}/rest/v1/venue_volume?select=${SELECT}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    const { text, truncated } = await readBoundedText(r, 64 * 1024);
    if (!r.ok || truncated) return unread(res, 502);
    const body = summarize(JSON.parse(text), nowMs);
    if (body.state === "unread") return unread(res, 200);
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=60");
    return res.status(200).json(body);
  } catch (err) {
    console.error("venue-volume error:", logSafe(err));
    return unread(res, 502);
  }
}
