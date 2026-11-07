// Vercel Serverless Function: the same-origin Cardano chain reader (Koios behind it).
//
// The Cardano swap (src/lib/cardano/chain.ts) reads pools, protocol parameters, token names
// and order status through here. The browser never calls Koios itself: a keyed plan's token
// would otherwise sit in the public bundle (the [H-35] lesson solrpc.js was built on), and the
// whole site shares one upstream quota, so it is spent through one rate-limited gate.
//
// Hardening, as solrpc.js: GET only, same-origin gate (fail-closed on production and preview),
// per-IP rate limit, a NAMED list of reads with strict params (_lib/cardano-ops.js), a bounded
// upstream response, forced JSON + nosniff, no upstream header reflected, opaque 502 upstream.
import { checkGlobalLimit, checkRateLimit } from "./_lib/ratelimit.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "./_lib/bodycap.js";
import { logSafe } from "./_lib/logSafe.js";
import { isRequestOriginAllowed } from "./_lib/aggregator-proxy.js";
import { buildKoiosRequest } from "./_lib/cardano-ops.js";

// A quote is 2-4 reads; following an order is 1-4 reads every 10 s for a few minutes (up to
// about 16 on the one poll that finds its fill).
const CARDANO_RATE_LIMIT = { limit: 120, windowSec: 60, identifier: "cardano" };

// The whole site shares ONE Koios quota (the free key: 50,000 reads a day, about 35 a minute
// on average), so a per-IP limit alone lets one caller spend a day's quota in hours. The
// per-minute cap sheds a burst (503); it is 432,000 a day, so it cannot guard the quota. The
// DAILY caps do: one per caller, so one script needs several addresses, and one for the site,
// held under the key's quota so Koios never refuses the key itself. Raise CARDANO_GLOBAL_RPM
// and CARDANO_GLOBAL_DAILY (env, no redeploy) with the key's plan.
const CARDANO_GLOBAL_RPM_DEFAULT = 300;
// 6,000 a day per caller: an open order read once a minute all day is about 2,900 (the page
// slows to that after 10 minutes), leaving room for quotes; one script still needs 8 addresses.
const CARDANO_DAILY_LIMIT = { limit: 6000, windowSec: 86_400, identifier: "cardano-day" };
const CARDANO_GLOBAL_DAILY_DEFAULT = 45_000;

// How long each ask of Koios may take. A read marked `retry` (the pool: no pool, no price) that
// times out, cannot connect or meets a gateway error is asked once more. That second ask is a
// read like any: the caller's daily cap and the site's both count it, so the key's quota still
// holds and one caller cannot spend it twice as fast. A 429 is never asked again: Koios said
// slow down. vercel.json gives this function room for both asks.
export const ATTEMPT_TIMEOUTS_MS = [10_000, 15_000];

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!isRequestOriginAllowed(req)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }
  if (!(await checkRateLimit(req, res, CARDANO_RATE_LIMIT))) return;
  if (!(await checkRateLimit(req, res, CARDANO_DAILY_LIMIT))) return;
  const underGlobalCap = await checkGlobalLimit(res, {
    limit: Number(process.env.CARDANO_GLOBAL_RPM) || CARDANO_GLOBAL_RPM_DEFAULT,
    windowSec: 60,
    identifier: "cardano",
  });
  if (!underGlobalCap) return;
  const underDailyCap = await checkGlobalLimit(res, {
    limit: Number(process.env.CARDANO_GLOBAL_DAILY) || CARDANO_GLOBAL_DAILY_DEFAULT,
    windowSec: 86_400,
    identifier: "cardano-day",
  });
  if (!underDailyCap) return;

  const { op, ...query } = req.query ?? {};
  const built = buildKoiosRequest(Array.isArray(op) ? op[0] : op, query, process.env.KOIOS_API_KEY);
  if ("error" in built) return res.status(built.error).json({ error: built.message });

  let upstream;
  const attempts = built.retry ? ATTEMPT_TIMEOUTS_MS.length : 1;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      if (!(await checkRateLimit(req, res, CARDANO_DAILY_LIMIT))) return;
      const underDailyCapAgain = await checkGlobalLimit(res, {
        limit: Number(process.env.CARDANO_GLOBAL_DAILY) || CARDANO_GLOBAL_DAILY_DEFAULT,
        windowSec: 86_400,
        identifier: "cardano-day",
      });
      if (!underDailyCapAgain) return;
    }
    try {
      upstream = await fetch(built.url, { ...built.init, signal: AbortSignal.timeout(ATTEMPT_TIMEOUTS_MS[i]) });
    } catch (err) {
      console.error(`[cardano] fetch error (ask ${i + 1} of ${attempts}):`, logSafe(err));
      upstream = undefined;
      continue;
    }
    // Any answer below 500 is Koios's own (a 429 included); a 5xx is its gateway failing.
    if (upstream.status < 500 || i === attempts - 1) break;
    console.error(`[cardano] upstream HTTP ${upstream.status} (ask ${i + 1} of ${attempts})`);
    await upstream.body?.cancel().catch(() => {});
  }
  if (!upstream) return res.status(502).json({ error: "Upstream error" });
  let text;
  try {
    const read = await readBoundedText(upstream, MAX_RESPONSE_BYTES);
    if (read.truncated) {
      console.error("[cardano] upstream over-cap");
      return res.status(502).json({ error: "Upstream response too large" });
    }
    text = read.text;
  } catch (err) {
    console.error("[cardano] read error:", logSafe(err));
    return res.status(502).json({ error: "Upstream error" });
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (upstream.status === 429) {
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(429).json({ error: "Upstream busy" });
  }
  if (!upstream.ok) {
    console.error(`[cardano] upstream HTTP ${upstream.status}`);
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(502).json({ error: "Upstream error" });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(502).json({ error: "Upstream answered with something that is not JSON" });
  }
  // An empty answer may be an indexer that has not caught up (a coin minted a minute ago):
  // never cached, so no visitor is told "no record" for an hour about a coin that exists.
  const empty = Array.isArray(parsed) && parsed.length === 0;
  res.setHeader("Cache-Control", empty ? "private, no-store" : built.cache);
  return res.status(200).send(text);
}
