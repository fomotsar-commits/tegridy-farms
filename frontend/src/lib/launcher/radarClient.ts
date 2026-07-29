// Typed client for the launch-radar serverless adapter.
//
// The fetch (GeckoTerminal `new_pools`, keyless) lives behind the aggregator
// catchall at `/api/aggregator?resource=launch-radar` (see api/_lib/launch-radar.js).
// This helper is the thin, typed front door; the PARSE is the pure, unit-tested
// mapNewPoolsToBaselines() in discovery.ts, so hostile-JSON handling has exactly one
// tested implementation shared with the enrichment path.
//
// SCOPE / HONESTY BOUNDARY: these are pools launched ACROSS THE WHOLE MARKET, not
// tokens that launched on the Tegridy rail. They must never populate the Tegridy
// cohort surfaces (LaunchExplorer / LaunchAfterlife) — those promise tokens that
// graduated through this rail and stay honestly empty until one does. Render this
// only in the separately-labelled "Launch Radar".
//
// Degradation contract mirrors outcomesClient: a network/HTTP failure THROWS (the
// caller decides how to degrade), a malformed-but-200 body coerces to an empty,
// well-formed shape rather than being trusted.

import { mapNewPoolsToBaselines, type GeckoPoolEntry } from './discovery';
import type { LaunchBaseline } from './outcomesReader';
import type { Address } from 'viem';

/** One market-wide new pool, normalised for display. */
export interface RadarEntry {
  /** Base token address (lowercased) — the /scan?token= deep-link target. */
  token: Address;
  /** The pool this was discovered in, when exposed. */
  pool?: Address;
  /** Unix seconds; 0 when the upstream omitted a parseable creation time. */
  launchedAt: number;
  /** Token price in ETH; 0 when unavailable (never fabricated). */
  priceEth: number;
  /** Pool liquidity in ETH; 0 when unavailable (never fabricated). */
  liquidityEth: number;
  /** Display name/symbol as reported upstream, when present. */
  name?: string;
}

export interface RadarResponse {
  entries: RadarEntry[];
  /** Unix seconds the server read the upstream, so the UI can state freshness. */
  observedAt: number;
}

export interface FetchLaunchRadarOptions {
  signal?: AbortSignal;
  /** Override the endpoint (tests / preview). Defaults to the catchall route. */
  endpoint?: string;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Cap the rows returned (the UI shows a short list). Default 12. */
  limit?: number;
}

/** The catchall resource route. Same-origin; upstream is keyless. */
export const LAUNCH_RADAR_ENDPOINT = '/api/aggregator?resource=launch-radar';

/** Pull a display name out of the raw entry's attributes, if it looks sane. */
function entryName(raw: GeckoPoolEntry): string | undefined {
  const n = raw.attributes?.name;
  return typeof n === 'string' && n.trim() ? n.trim().slice(0, 64) : undefined;
}

/**
 * Upstream new-pool data includes fabricated pricing: scam deployments routinely
 * report absurd per-token prices, which GeckoTerminal then multiplies into an
 * equally absurd `reserve_in_usd` (observed live: a 12-minute-old pool reporting
 * $1,016,163,865 PER TOKEN and a $1B reserve, rendering as "520607 ETH" — the
 * largest figure on the page, attached to the least trustworthy pool).
 *
 * The arithmetic is correct; the INPUT is fiction. Repeating it faithfully would
 * still mislead, and on a surface whose whole point is honest measurement the
 * right answer is the one the rest of the app already gives: show a gap AS a gap.
 * So a row whose price is not a physically plausible market price is treated as
 * UNMEASURED (0 → renders "—"), never silently repeated and never invented.
 *
 * The bound is deliberately loose — it is an absurdity filter, not a judgement.
 * The most expensive real ERC-20s trade in the tens of thousands of USD per unit,
 * so $1M/token is orders of magnitude above anything legitimate and only ever
 * catches fabricated data.
 */
const MAX_PLAUSIBLE_TOKEN_PRICE_USD = 1_000_000;

function plausible(priceUsd: number | null, liquidityEth: number): boolean {
  if (priceUsd != null && Number.isFinite(priceUsd) && priceUsd > MAX_PLAUSIBLE_TOKEN_PRICE_USD) return false;
  // Guards the same fiction arriving via the reserve alone (finite, positive, absurd).
  if (!Number.isFinite(liquidityEth) || liquidityEth < 0) return false;
  return true;
}

/** Read the upstream USD price for an entry, when present and finite. */
function entryPriceUsd(raw: GeckoPoolEntry): number | null {
  const v = raw.attributes?.base_token_price_usd;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Coerce an unknown body into typed radar entries. Delegates every numeric/address
 * decision to the pure mapper, then re-attaches the display name by token so the
 * name can never disagree with the row it labels.
 */
export function coerceRadar(raw: unknown, limit: number): RadarResponse {
  const obj = (raw ?? {}) as { data?: unknown; observedAt?: unknown };
  const { baselines, poolByToken } = mapNewPoolsToBaselines(
    Array.isArray(obj.data) ? (obj.data as unknown[]) : [],
  );

  // Name + upstream USD price keyed by the SAME token key the mapper emits (first
  // pool wins, matching the mapper's newest-first distinct-by-token rule).
  const names = new Map<string, string>();
  const pricesUsd = new Map<string, number>();
  for (const e of (Array.isArray(obj.data) ? obj.data : []) as GeckoPoolEntry[]) {
    if (!e || typeof e !== 'object') continue;
    const id = e.relationships?.base_token as { data?: { id?: unknown } } | undefined;
    const rawId = id?.data?.id;
    if (typeof rawId !== 'string') continue;
    const token = (rawId.includes('_') ? rawId.slice(rawId.lastIndexOf('_') + 1) : rawId).toLowerCase();
    const n = entryName(e);
    if (n && !names.has(token)) names.set(token, n);
    const p = entryPriceUsd(e);
    if (p != null && !pricesUsd.has(token)) pricesUsd.set(token, p);
  }

  const entries: RadarEntry[] = baselines.slice(0, Math.max(0, limit)).map((b: LaunchBaseline) => {
    const key = b.token.toLowerCase();
    // Fabricated upstream pricing must not be repeated as fact — show the gap.
    const ok = plausible(pricesUsd.get(key) ?? null, b.launchLiquidityEth);
    return {
      token: b.token,
      pool: poolByToken[b.token],
      launchedAt: b.launchedAt,
      priceEth: ok ? b.launchPriceEth : 0,
      liquidityEth: ok ? b.launchLiquidityEth : 0,
      name: names.get(key),
    };
  });

  const observedAt = typeof obj.observedAt === 'number' && Number.isFinite(obj.observedAt) ? obj.observedAt : 0;
  return { entries, observedAt };
}

/**
 * Fetch the market-wide new-pool radar. Throws on network/non-2xx failure; returns a
 * well-formed (possibly empty) shape on success.
 */
export async function fetchLaunchRadar(opts: FetchLaunchRadarOptions = {}): Promise<RadarResponse> {
  const { signal, endpoint = LAUNCH_RADAR_ENDPOINT, fetchImpl = fetch, limit = 12 } = opts;
  const res = await fetchImpl(endpoint, { signal });
  if (!res.ok) throw new Error(`launch-radar request failed: ${res.status}`);
  const json: unknown = await res.json();
  return coerceRadar(json, limit);
}
