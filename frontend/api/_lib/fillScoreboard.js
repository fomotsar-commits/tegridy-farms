// The fill scoreboard's one public read, `?resource=fill-scoreboard` on the catchall.
// .github/workflows/fill-scoreboard.yml writes one row per scored swap into fill_scoreboard
// (migration 029) every hour; this summarizes the last 30 days. The edge caches it, so a
// visitor costs nothing. A read that fails, or a window too big to read whole, is "unread".

import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { isOriginAllowed, isRequestOriginAllowed } from "./aggregator-proxy.js";
import { readBoundedText } from "./bodycap.js";
import { logSafe } from "./logSafe.js";
import { summarize, WINDOW_DAYS } from "./fillScoreboardPolicy.js";

const MAX_ROWS = 5000;
const SELECT = [
  "block_time",
  "bot",
  "quoted_out::text",
  "delivered_out::text",
  "slippage_bps",
  "deposit_lamports::text",
  "unread_reason",
].join(",");

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  if (origin && isOriginAllowed(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function unread(res, status) {
  res.setHeader("Cache-Control", "s-maxage=30");
  return res.status(status).json({ state: "unread" });
}

async function readJson(fetchImpl, url, key, cap) {
  const r = await fetchImpl(url, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(4000),
  });
  const { text, truncated } = await readBoundedText(r, cap);
  if (!r.ok || truncated) return null;
  return JSON.parse(text);
}

export async function handleFillScoreboard(req, res, { nowMs = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!isRequestOriginAllowed(req)) return res.status(403).json({ error: "Origin not allowed" });
  if (!(await checkRateLimit(req, res, { limit: 30, windowSec: 60, identifier: "fill-scoreboard" }))) return;
  if (!(await checkGlobalLimit(res, { limit: 300, windowSec: 60, identifier: "fill-scoreboard" }))) return;

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return unread(res, 503);
  const since = new Date(nowMs - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const [cursor, rows] = await Promise.all([
      readJson(fetchImpl, `${url}/rest/v1/fill_scoreboard_cursor?select=counted_to,last_ok_at,last_error_at&source=eq.jupiter`, key, 16 * 1024),
      readJson(
        fetchImpl,
        `${url}/rest/v1/fill_scoreboard?select=${SELECT}&block_time=gte.${encodeURIComponent(since)}&limit=${MAX_ROWS + 1}`,
        key,
        2 * 1024 * 1024,
      ),
    ]);
    // A window with more rows than one read holds would be summarized short: no number.
    if (!Array.isArray(cursor) || !Array.isArray(rows) || rows.length > MAX_ROWS) return unread(res, 502);
    const body = summarize(rows, cursor[0] ?? null, nowMs);
    if (body.state === "unread") return unread(res, 200);
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json(body);
  } catch (err) {
    console.error("fill-scoreboard error:", logSafe(err));
    return unread(res, 502);
  }
}
