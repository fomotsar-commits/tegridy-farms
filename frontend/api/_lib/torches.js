// Torches resource adapter — the network boundary for Jungle Bay Island's torches,
// its season, its fire and its flame count (memetics.wtf, keyless, read-only).
//
// WHY THIS LIVES IN THE AGGREGATOR CATCHALL (not a new api/*.js file):
//   Same reason as heat.js and flames.js: Vercel Hobby caps a deployment at 12
//   serverless functions. Dispatched from api/aggregator.js via ?resource=torches
//   behind a LAZY dynamic import, so the swap hot-path never loads it.
//
// WHY IT MUST BE SERVER-SIDE:
//   The island answers these routes with no Access-Control-Allow-Origin for our
//   origin (read 2026-10-23), so a browser fetch from the venue is blocked. Proxying
//   also keeps the browser talking only to `'self'`.
//
// ONE READ, TWO SURFACES (the island's venue review, items 6 and 9; the venue's plan
// of 2026-10-03 promised one proxy over the island's torch routes). A room's door
// paints its own torches from `places`; the home's strip paints the fire, the flames,
// the season and the island's last torch. Five upstream routes, read in parallel:
//   /api/torches?limit=500   every torch, newest first: each room's last torch
//   /api/torches/places      the twelve places: lit, the open row, the next price
//   /api/torches/season      the season's number and its end
//   /api/fire                `all_time.burned`, the island's own served total
//   /api/flames?limit=500    counted here; only the count leaves this file
//
// EACH PART STANDS ALONE. A route that fails, times out, or changes shape makes ITS
// part null and the rest still answer. Only when every part failed is this a 502. An
// unread part is never a zero, and a flame list that came back full (500 rows) is not
// a total, so its count is null rather than a floor printed as the number.
//
// THE ALLOWLIST. Only fields a venue surface paints leave this file. The torch rows
// also carry signatures, painted-card URLs and piece metadata; the flames carry the
// `person_id` and `wallet_count` that flames.js exists to strip. None of it is
// forwarded, and a field the island adds later is dropped until it is reviewed in.

import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { isOriginAllowed, isRequestOriginAllowed } from "./aggregator-proxy.js";
import { readBoundedText } from "./bodycap.js";
import { logSafe } from "./logSafe.js";

// ── Config ───────────────────────────────────────────────────────────────
// Fixed URLs. NOTHING from `req` reaches the host or the path, which is the SSRF
// boundary for this file.
const ISLAND = "https://memetics.wtf/api";
const FLAMES_PAGE = 500;
const ROUTES = {
  torches: { url: `${ISLAND}/torches?limit=500`, maxBytes: 1024 * 1024 },
  places: { url: `${ISLAND}/torches/places`, maxBytes: 64 * 1024 },
  season: { url: `${ISLAND}/torches/season`, maxBytes: 256 * 1024 },
  fire: { url: `${ISLAND}/fire`, maxBytes: 64 * 1024 },
  flames: { url: `${ISLAND}/flames?limit=${FLAMES_PAGE}`, maxBytes: 256 * 1024 },
};

// Under Vercel's default and under the browser's own 6 s abort, as in heat.js.
const UPSTREAM_TIMEOUT_MS = 4500;

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/** One upstream route's parsed JSON, or null for any failure at all. */
async function readJson({ url, maxBytes }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { headers: { Accept: "application/json" }, signal: ac.signal });
    if (!resp.ok) return null;
    const { text, truncated } = await readBoundedText(resp, maxBytes);
    if (truncated) return null;
    return JSON.parse(text);
  } catch (err) {
    console.error("torches upstream error:", logSafe(err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const count = (v) => Number.isSafeInteger(v) && v >= 0;
const amount = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const when = (v) => typeof v === "string" && Number.isFinite(Date.parse(v));
const word = (v, max) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

/** The rooms' torches from /api/torches: kind "bungalow" only (a feed to the fire has no room). */
function roomTorchRows(body) {
  if (!Array.isArray(body?.torches)) return null;
  const rows = [];
  for (const t of body.torches) {
    if (t?.kind !== "bungalow" || !word(t.place, 128) || !when(t.lit_at) || !amount(t.amount)) continue;
    rows.push({ place: t.place, label: word(t.label, 32), name: word(t.name, 64), amount: t.amount, lit_at: t.lit_at });
  }
  // Newest first by the time each was lit, not by the order served.
  return rows.sort((a, b) => Date.parse(b.lit_at) - Date.parse(a.lit_at));
}

function parsePlaces(body, lastByPlace) {
  if (!Array.isArray(body?.places)) return null;
  const places = [];
  for (const p of body.places) {
    if (!word(p?.place, 128) || !count(p.torches) || !count(p.open_row) || p.open_row < 1) continue;
    if (!amount(p.next_price) || !count(p.slots_per_row) || p.slots_per_row < 1) continue;
    const last = lastByPlace?.get(p.place) ?? null;
    places.push({
      place: p.place,
      label: word(p.label, 32),
      torches: p.torches,
      open_row: p.open_row,
      next_price: p.next_price,
      slots_per_row: p.slots_per_row,
      last: last ? { name: last.name, amount: last.amount, lit_at: last.lit_at } : null,
    });
  }
  // Rows came back and none could be read: the shape moved. That is unread, not "no places".
  return places.length === 0 && body.places.length > 0 ? null : places;
}

function parseSeason(body) {
  if (!count(body?.season) || body.season < 1 || !when(body.ends_at)) return null;
  return { season: body.season, ends_at: body.ends_at };
}

function parseFire(body) {
  const burned = body?.all_time?.burned;
  return amount(burned) ? { burned } : null;
}

function parseFlameCount(body) {
  if (!Array.isArray(body?.flames)) return null;
  // A full page is where the island stopped, not how many flames there are.
  return body.flames.length < FLAMES_PAGE ? body.flames.length : null;
}

// ── Handler ────────────────────────────────────────────────────────────────
export async function handleTorches(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ENFORCE the origin: setCors only sets a header. Same reasoning as flames.js.
  if (!isRequestOriginAllowed(req)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  // Its own bucket. One call fans out to five island routes, so the edge cache below
  // is what keeps the island's load at about one fan-out a minute.
  const allowed = await checkRateLimit(req, res, { limit: 30, windowSec: 60, identifier: "torches" });
  if (!allowed) return;
  const underCap = await checkGlobalLimit(res, {
    limit: Number(process.env.TORCHES_GLOBAL_RPM) || 300,
    windowSec: 60,
    identifier: "torches",
  });
  if (!underCap) return;

  const [torchesBody, placesBody, seasonBody, fireBody, flamesBody] = await Promise.all([
    readJson(ROUTES.torches),
    readJson(ROUTES.places),
    readJson(ROUTES.season),
    readJson(ROUTES.fire),
    readJson(ROUTES.flames),
  ]);

  const rows = roomTorchRows(torchesBody);
  let lastByPlace = null;
  if (rows) {
    lastByPlace = new Map();
    for (const r of rows) if (!lastByPlace.has(r.place)) lastByPlace.set(r.place, r);
  }
  const newest = rows?.[0] ?? null;
  const out = {
    places: parsePlaces(placesBody, lastByPlace),
    last_torch: newest
      ? { place: newest.place, label: newest.label, name: newest.name, amount: newest.amount, lit_at: newest.lit_at }
      : null,
    fire: parseFire(fireBody),
    season: parseSeason(seasonBody),
    flames: parseFlameCount(flamesBody),
    as_of_unix: count(placesBody?.as_of_unix) ? placesBody.as_of_unix : null,
  };

  const anyRead = out.places !== null || out.last_torch !== null || out.fire !== null
    || out.season !== null || out.flames !== null;
  if (!anyRead) {
    return res.status(502).json({ error: "The island could not be read" });
  }

  // A torch lit on the island shows here within about a minute.
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=240");
  return res.status(200).json(out);
}
