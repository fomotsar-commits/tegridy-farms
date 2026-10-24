// The same-origin, EDGE-CACHED entry point for every GeckoTerminal read in the
// browser. One builder, so there is one place that knows the read goes through
// our own origin and one place to change if it ever stops doing so.
//
// WHY (measured, 2026-09-05): 46 of 64 prod routes logged a failed
// GeckoTerminal read. The browser calls it `blocked by CORS policy`, and that
// is a misdiagnosis of its own error — the upstream answers 200 with
// `access-control-allow-origin: *` on all three failing paths when curled. The
// header is present on success and ABSENT on a 429, so a throttled read is
// indistinguishable from a blocked one from inside the page. It is the keyless
// RATE LIMIT.
//
// The fix is NOT the proxy. A bare proxy is strictly worse: it puts every
// visitor's reads on one Vercel egress IP, where reading direct at least gave
// each visitor their own keyless budget. What fixes it is the `s-maxage` on
// `api/_lib/gecko-read.js` — the CDN answers, so upstream sees ~1 request per
// distinct URL per 45s however many people are reading. Read that file's header
// before changing anything here; the cache is the mechanism and the proxy is
// only how the cache becomes reachable.
//
// SHAPE. Callers pass an upstream path whose SEGMENTS are already encoded, and
// this leaves the separating slashes literal in the query value:
//
//   /api/aggregator?resource=gecko-read&path=/networks/eth/pools/0xabc…/trades
//
// That is deliberate and load-bearing, not laziness. `pools.ts#networkFromUrl`
// recovers the network by matching `/networks/([^/?#]+)` against the request
// URL — it takes a URL rather than a (network, view) pair precisely so a
// response can never be parsed under the wrong network's address rules. Percent
// encoding the slashes would break that match and silently return null, so the
// slashes stay literal and `edge.test.ts` pins the round trip.

/** The same-origin resource that fronts GeckoTerminal. */
export const GECKO_EDGE_RESOURCE = '/api/aggregator?resource=gecko-read';

/** Query keys `api/_lib/gecko-read.js` forwards upstream. Anything else is dropped there. */
export type GeckoEdgeParams = Partial<Record<'aggregate' | 'limit' | 'currency' | 'page', string | number>>;

/**
 * A same-origin URL for one upstream GeckoTerminal path.
 *
 * `path` is everything after `/api/v2`, leading slash included, with each
 * SEGMENT already `encodeURIComponent`-ed by the caller. Callers encode rather
 * than this function, because a path is assembled from parts that have
 * different validity rules — a network slug, an address, a timeframe — and only
 * the caller knows which is which. The server re-checks the whole path against
 * an anchored allowlist regardless, so a caller that forgets is refused with a
 * 400 rather than proxied.
 */
export function geckoEdgeUrl(path: string, params: GeckoEdgeParams = {}): string {
  let url = `${GECKO_EDGE_RESOURCE}&path=${path}`;
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url += `&${key}=${encodeURIComponent(String(value))}`;
  }
  return url;
}

// ─── How old an answer is (2026-10-15) ───────────────────────────────────────
//
// The edge (api/_lib/gecko-upstream.js) keeps GeckoTerminal under its keyless
// limit, and when GeckoTerminal refuses it can hand back the LAST GOOD COPY of a
// read instead of an error. It only does that for a caller that sends the header
// below, and every caller that sends it MUST print the copy's age: an old number
// that looks new is the one outcome worse than a refusal. A surface with nowhere
// to print an age (an alert, a display price) does not send it, and keeps
// getting the refusal.

/** Request headers that ask the edge for its last good copy when GeckoTerminal refuses. */
export const GECKO_STALE_OK_HEADERS: Readonly<Record<string, string>> = { 'X-Gecko-Stale-Ok': '1' };

export interface GeckoFreshness {
  /** When the edge read this answer from GeckoTerminal (epoch ms). Null when the response did not say. */
  fetchedAt: number | null;
  /** True when GeckoTerminal refused and this is the last good copy the edge kept. */
  stale: boolean;
}

export const GECKO_FRESHNESS_UNKNOWN: GeckoFreshness = { fetchedAt: null, stale: false };

/**
 * The age stamps on one edge response. Tolerates a response with no headers at
 * all (test doubles, a dev server with no edge), which reads as "not said".
 */
export function readGeckoFreshness(res: { headers?: Pick<Headers, 'get'> | null } | null | undefined): GeckoFreshness {
  const headers = res?.headers;
  const get = (name: string): string | null =>
    headers && typeof headers.get === 'function' ? headers.get(name) : null;
  const raw = Number(get('X-Gecko-Fetched-At'));
  return {
    fetchedAt: Number.isFinite(raw) && raw > 0 ? raw : null,
    stale: get('X-Gecko-Stale') === '1',
  };
}

/** Younger than this, an answer is as live as anything else on the page and needs no line. */
export const GECKO_AS_OF_AFTER_MS = 60_000;

/**
 * The line a surface prints under a GeckoTerminal figure, or null when none is
 * needed. It names a CLOCK TIME, not "N min ago": a relative age is true only at
 * the moment it renders and goes on saying the same number while the page sits.
 */
export function geckoAsOfLine(f: GeckoFreshness, now: number = Date.now()): string | null {
  const old = f.fetchedAt !== null && now - f.fetchedAt >= GECKO_AS_OF_AFTER_MS;
  if (!f.stale && !old) return null;
  const when =
    f.fetchedAt === null
      ? 'An earlier copy, time not known.'
      : `As of ${new Date(f.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
  return f.stale ? `${when} The live feed is busy, so this is the last copy we read.` : when;
}
