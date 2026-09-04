// Compact price-history feed for the /solana swap page's buy token, from
// GeckoTerminal's keyless API. https://api.geckoterminal.com is ALREADY in the
// site's CSP connect-src (vercel.json) — this module fetches client-direct and
// must never grow a call to any other host.
//
// Rate budget: GT keyless is ~30 req/min and other surfaces in the app share
// the host (useToweliPrice / usePriceHistory / the bungalow market strip), so
// every network read here sits behind a module-scope TTL cache.
//
// HARD RULE — no market cap / FDV. GeckoTerminal payloads carry fdv_usd /
// market_cap_usd on both the pools and ohlcv envelopes. This module must NEVER
// expose them: the Solana surfaces deliberately render no market-cap/FDV
// numbers (house "no-FDV" rule). Only price/close data leaves this module.

export type ChartTimeframe = '1H' | '1D' | '1W';

export interface OhlcvPoint {
  /** Unix seconds. */
  ts: number;
  /** Close price in USD. */
  close: number;
}

const GT_BASE = 'https://api.geckoterminal.com/api/v2';
// GT's versioned Accept header — pins the response shape we parse.
const GT_ACCEPT = 'application/json;version=20230302';

// Per-timeframe OHLCV query: endpoint path segment + aggregate + candle count.
// '1H' = 60×1m, '1D' = 96×15m, '1W' = 42×4h.
const TF_QUERY: Record<ChartTimeframe, { path: 'minute' | 'hour'; aggregate: number; limit: number }> = {
  '1H': { path: 'minute', aggregate: 1, limit: 60 },
  '1D': { path: 'minute', aggregate: 15, limit: 96 },
  '1W': { path: 'hour', aggregate: 4, limit: 42 },
};

// ─── caches (module scope; session-lived) ────────────────────────────────────
// OHLCV per `${mint}|${tf}`, 60s TTL. Pool lookup per mint, 10min TTL — the
// top pool for a token changes far more slowly than its price.
const OHLCV_TTL_MS = 60_000;
const POOL_TTL_MS = 10 * 60_000;
const ohlcvCache = new Map<string, { at: number; points: OhlcvPoint[] }>();
const poolCache = new Map<string, { at: number; pool: string }>();

// ─── pure helpers (unit-tested; no fetch) ────────────────────────────────────

/**
 * Extract the top pool's address from a GT `/tokens/{mint}/pools` payload.
 * GT's default sort puts the best/top pool first; its `id` is
 * `solana_<poolAddress>` — the prefix is stripped. Null when the token has no
 * indexed pool (or the payload is malformed) — the caller throws and the
 * component renders its honest empty state.
 */
export function topPoolAddress(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first: unknown = data[0];
  if (typeof first !== 'object' || first === null) return null;
  const id = (first as { id?: unknown }).id;
  if (typeof id !== 'string') return null;
  const addr = id.startsWith('solana_') ? id.slice('solana_'.length) : id;
  return addr === '' ? null : addr;
}

/**
 * Parse a GT `ohlcv_list` value — rows of [ts, open, high, low, close, volume]
 * — into close-price points. Defensive by design: rows that aren't arrays or
 * carry a non-finite ts/close are DROPPED (never zero-filled), and the result
 * is sorted ASCENDING by ts because GT returns newest-first.
 */
export function parseOhlcvList(raw: unknown): OhlcvPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: OhlcvPoint[] = [];
  for (const row of raw) {
    if (!Array.isArray(row)) continue;
    const ts: unknown = row[0];
    const close: unknown = row[4];
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
    if (typeof close !== 'number' || !Number.isFinite(close)) continue;
    out.push({ ts, close });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// Inner padding so the stroke never clips at the viewBox edge.
const PAD = 4;

const fmt = (v: number): string => String(Math.round(v * 100) / 100);

/**
 * SVG path ("M x y L x y …") through the close prices, x spread across
 * [PAD, width−PAD], y inverted (higher price = smaller y) into
 * [PAD, height−PAD]. A flat series draws a centered horizontal line; a single
 * point draws a full-width flat line; no points → ''.
 */
export function linePath(points: OhlcvPoint[], width: number, height: number): string {
  if (points.length === 0 || width <= PAD * 2 || height <= PAD * 2) return '';
  const closes = points.map((p) => p.close);
  const min = Math.min(...closes);
  const span = Math.max(...closes) - min;
  const innerW = width - PAD * 2;
  const innerH = height - PAD * 2;
  const yOf = (close: number): number => {
    const norm = span === 0 ? 0.5 : (close - min) / span;
    return PAD + (1 - norm) * innerH;
  };
  if (points.length === 1) {
    const y = fmt(yOf(closes[0] ?? 0));
    return `M ${fmt(PAD)} ${y} L ${fmt(width - PAD)} ${y}`;
  }
  const n = points.length;
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${fmt(PAD + (i / (n - 1)) * innerW)} ${fmt(yOf(p.close))}`)
    .join(' ');
}

/**
 * The line path closed down to the bottom edge — the subtle area fill under
 * the line. '' when there is nothing to draw.
 */
export function areaPath(points: OhlcvPoint[], width: number, height: number): string {
  const line = linePath(points, width, height);
  if (line === '') return '';
  return `${line} L ${fmt(width - PAD)} ${fmt(height)} L ${fmt(PAD)} ${fmt(height)} Z`;
}

/**
 * Percent change over the range (last close vs first close). Null when there
 * are fewer than 2 points or the first close is 0/non-finite (no honest
 * denominator).
 */
export function rangeChangePct(points: OhlcvPoint[]): number | null {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;
  if (!Number.isFinite(first.close) || !Number.isFinite(last.close) || first.close === 0) return null;
  return ((last.close - first.close) / first.close) * 100;
}

/**
 * USD price for display. Sub-$1 prices keep 4 significant digits so a real
 * sub-cent price never renders as "$0.00"; $1+ renders as a plain 2-decimal
 * figure.
 */
export function formatChartPrice(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n !== 0 && Math.abs(n) < 1) {
    return `$${n.toLocaleString('en-US', { maximumSignificantDigits: 4 })}`;
  }
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ─── fetch path ──────────────────────────────────────────────────────────────

async function gtJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: GT_ACCEPT }, signal });
  if (!res.ok) throw new Error(`GeckoTerminal request failed (${res.status})`);
  return res.json() as Promise<unknown>;
}

async function resolveTopPool(mint: string, signal?: AbortSignal): Promise<string> {
  const cached = poolCache.get(mint);
  if (cached && Date.now() - cached.at < POOL_TTL_MS) return cached.pool;
  const body = await gtJson(`${GT_BASE}/networks/solana/tokens/${mint}/pools?page=1`, signal);
  const pool = topPoolAddress(body);
  if (pool === null) throw new Error('No indexed pool for this token');
  poolCache.set(mint, { at: Date.now(), pool });
  return pool;
}

/**
 * Close-price series for a token's top Solana pool. Throws when the token has
 * no indexed pool or GT is unreachable — the component turns that into its
 * single honest "Chart unavailable" line. Results are TTL-cached (see above).
 */
export async function fetchTokenOhlcv(mint: string, tf: ChartTimeframe, signal?: AbortSignal): Promise<OhlcvPoint[]> {
  const key = `${mint}|${tf}`;
  const cached = ohlcvCache.get(key);
  if (cached && Date.now() - cached.at < OHLCV_TTL_MS) return cached.points;

  const pool = await resolveTopPool(mint, signal);
  const q = TF_QUERY[tf];
  const body = await gtJson(
    `${GT_BASE}/networks/solana/pools/${pool}/ohlcv/${q.path}?aggregate=${q.aggregate}&limit=${q.limit}&currency=usd`,
    signal,
  );
  // Only the ohlcv_list leaves this envelope — never fdv/mcap (see HARD RULE).
  const list = (body as { data?: { attributes?: { ohlcv_list?: unknown } } } | null)?.data?.attributes?.ohlcv_list;
  const points = parseOhlcvList(list);
  // Cache empties too: a pool with no candles yet shouldn't be re-hit per render.
  ohlcvCache.set(key, { at: Date.now(), points });
  return points;
}
