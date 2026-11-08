// `?resource=fire`: the island's fire this week (memetics.wtf/api/fire, keyless, read-only),
// for Bayla's intel line: "The fire took 339,866 $BAYLA this week." The upstream is locked to
// the island's own origin by CORS (as heat and flames are), so the browser reads it here.
// Only the week's and the fire's totals are forwarded: who fed it is the island's to show.
// The edge keeps the answer five minutes; a failed read is a 502 the line leaves out (never 0).
import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { isOriginAllowed, isRequestOriginAllowed } from "./aggregator-proxy.js";
import { readBoundedText } from "./bodycap.js";

const FIRE_URL = "https://memetics.wtf/api/fire";
const UPSTREAM_TIMEOUT_MS = 4500;
const MAX_BYTES = 256 * 1024;

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  if (origin && isOriginAllowed(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === "string" ? v : null);

/** The totals the venue may say, and nothing about who. */
export function toPublicFire(body) {
  const week = body?.week && typeof body.week === "object" ? body.week : null;
  const fire = body?.fire && typeof body.fire === "object" ? body.fire : null;
  const burned = num(week?.burned);
  if (burned === null) return null;
  return {
    week: { starts_at: str(week.starts_at), ends_at: str(week.ends_at), burned },
    fire: fire ? { since: str(fire.since), burned: num(fire.burned), feeds: num(fire.feeds), torches: num(fire.torches) } : null,
  };
}

export async function handleFire(req, res, { fetchImpl = globalThis.fetch } = {}) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!isRequestOriginAllowed(req)) return res.status(403).json({ error: "Origin not allowed" });
  if (!(await checkRateLimit(req, res, { limit: 30, windowSec: 60, identifier: "fire" }))) return;
  if (!(await checkGlobalLimit(res, { limit: 300, windowSec: 60, identifier: "fire" }))) return;
  try {
    const resp = await fetchImpl(FIRE_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (!resp.ok) {
      res.setHeader("Cache-Control", "private, no-store");
      return res.status(502).json({ error: "The fire could not be read" });
    }
    const { text, truncated } = await readBoundedText(resp, MAX_BYTES);
    if (truncated) {
      res.setHeader("Cache-Control", "private, no-store");
      return res.status(502).json({ error: "Upstream response too large" });
    }
    const pub = toPublicFire(JSON.parse(text));
    if (!pub) {
      res.setHeader("Cache-Control", "private, no-store");
      return res.status(502).json({ error: "The fire's answer carried no week" });
    }
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json(pub);
  } catch {
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(502).json({ error: "The fire could not be read" });
  }
}
