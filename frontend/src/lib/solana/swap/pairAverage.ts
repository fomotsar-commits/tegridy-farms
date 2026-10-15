// The pair's 24-hour average traded price, weighted by volume, worked out here from the
// 15-minute candles of the pair's top pool on GeckoTerminal, read through our own origin
// (geckoTerminal/edge.ts, cached at the edge). A reference beside a trade: it gates nothing.
// GeckoTerminal prices a pool's FIRST-named token, so the candles' own meta says which
// side they price, and the number is turned round when the coin asked for is the other one.
import { geckoEdgeUrl } from '../../geckoTerminal/edge';
import { SOL_MINT, USDC_MINT } from '../../solana';

export const WINDOW_SECONDS = 86_400;
/** Below any of these, a few trades would set the number (docs/VWAP_PLAN.md). */
export const MIN_TRADES_24H = 20;
export const MIN_VOLUME_USD_24H = 1_000;
export const MIN_TRADED_QUARTER_HOURS = 8;

const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const GT_ACCEPT = 'application/json;version=20230302';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The pool a pair's candles come from, with GeckoTerminal's own 24-hour counts for the floor. */
export interface PairPool {
  address: string;
  baseMint: string;
  quoteMint: string;
  /** Buys plus sells in 24 hours; null when the list did not say. */
  trades24h: number | null;
  volumeUsd24h: number | null;
}

/** `price` is how many of the quote coin one base coin traded for, on average. */
export type PairAverage =
  | { kind: 'ok'; baseMint: string; quoteMint: string; price: number }
  | { kind: 'thin' }
  | { kind: 'none' }
  | { kind: 'unread' };

/** The coin a price is said in: a dollar coin over SOL over anything else. */
export function quoteRank(mint: string): number {
  if (mint === USDC_MINT || mint === USDT_MINT) return 2;
  return mint === SOL_MINT ? 1 : 0;
}

/** The pair as the line says it: [base, quote]. A tie keeps the order given. */
export function sayAs(first: string, second: string): [string, string] {
  return quoteRank(second) >= quoteRank(first) ? [first, second] : [second, first];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const finite = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

function relMint(rel: unknown): string | null {
  const id = isObj(rel) && isObj(rel.data) ? rel.data.id : null;
  if (typeof id !== 'string' || !id.startsWith('solana_')) return null;
  const mint = id.slice('solana_'.length);
  return BASE58.test(mint) ? mint : null;
}

/**
 * The first pool in a GeckoTerminal `/tokens/{mint}/pools` page that holds exactly these
 * two mints. Null when the page was read and has none; 'unread' when it is not a list.
 */
export function findPairPool(raw: unknown, a: string, b: string): PairPool | null | 'unread' {
  const data = isObj(raw) ? raw.data : null;
  if (!Array.isArray(data)) return 'unread';
  for (const p of data) {
    if (!isObj(p) || !isObj(p.relationships) || !isObj(p.attributes)) continue;
    const base = relMint(p.relationships.base_token);
    const quote = relMint(p.relationships.quote_token);
    if (!base || !quote || !((base === a && quote === b) || (base === b && quote === a))) continue;
    const id = typeof p.id === 'string' && p.id.startsWith('solana_') ? p.id.slice('solana_'.length) : '';
    if (!BASE58.test(id)) return 'unread';
    const attrs = p.attributes;
    const h24 = isObj(attrs.transactions) && isObj(attrs.transactions.h24) ? attrs.transactions.h24 : null;
    const buys = finite(h24?.buys);
    const sells = finite(h24?.sells);
    const vol = finite(isObj(attrs.volume_usd) ? attrs.volume_usd.h24 : null);
    return {
      address: id,
      baseMint: base,
      quoteMint: quote,
      trades24h: buys !== null && sells !== null && buys >= 0 && sells >= 0 ? buys + sells : null,
      volumeUsd24h: vol !== null && vol >= 0 ? vol : null,
    };
  }
  return null;
}

/** An `ohlcv` answer: which mints its prices are (base in quote) and its rows. Null when unreadable. */
export function readCandles(raw: unknown): { baseMint: string; quoteMint: string; rows: unknown[] } | null {
  if (!isObj(raw) || !isObj(raw.meta) || !isObj(raw.data) || !isObj(raw.data.attributes)) return null;
  const base = isObj(raw.meta.base) ? raw.meta.base.address : null;
  const quote = isObj(raw.meta.quote) ? raw.meta.quote.address : null;
  const rows = raw.data.attributes.ohlcv_list;
  if (typeof base !== 'string' || typeof quote !== 'string' || !Array.isArray(rows)) return null;
  return { baseMint: base, quoteMint: quote, rows };
}

/**
 * Volume-weighted average of candle rows [ts, open, high, low, close, volume] priced in
 * the quote coin with volume in the quote coin: sum(V) / sum(V / P), P = (high + low +
 * close) / 3, over candles opened in the last 24 hours. Any malformed row in the window
 * makes it 'unread'; too few traded quarter-hours make it 'thin'.
 */
export function volumeWeighted(rows: unknown[], nowSec: number): number | 'thin' | 'unread' {
  const from = nowSec - WINDOW_SECONDS;
  let quoteSum = 0;
  let baseSum = 0;
  let traded = 0;
  for (const row of rows) {
    if (!Array.isArray(row)) return 'unread';
    const ts = finite(row[0]);
    if (ts === null) return 'unread';
    if (ts < from) continue;
    const [high, low, close, vol] = [finite(row[2]), finite(row[3]), finite(row[4]), finite(row[5])];
    if (high === null || low === null || close === null || vol === null) return 'unread';
    if (high <= 0 || low <= 0 || close <= 0 || vol < 0) return 'unread';
    if (vol === 0) continue;
    quoteSum += vol;
    baseSum += vol / ((high + low + close) / 3);
    traded++;
  }
  if (traded < MIN_TRADED_QUARTER_HOURS || baseSum <= 0) return 'thin';
  const avg = quoteSum / baseSum;
  return Number.isFinite(avg) && avg > 0 ? avg : 'unread';
}

/**
 * The average for the pair {a, b}, said the `sayAs` way. Candles that price some other
 * pair are 'unread'. Turning the number round is exact: the average is total quote over
 * total base, so the other way round it is total base over total quote.
 */
export function orientAverage(candles: { baseMint: string; quoteMint: string }, avg: number, a: string, b: string): PairAverage {
  const { baseMint: cb, quoteMint: cq } = candles;
  if (!((cb === a && cq === b) || (cb === b && cq === a)) || a === b) return { kind: 'unread' };
  const [base, quote] = sayAs(cb, cq);
  return { kind: 'ok', baseMint: base, quoteMint: quote, price: base === cb ? avg : 1 / avg };
}

/**
 * How far this trade's price is from the average, in percent: above is more of the quote
 * coin per base coin. Null when the trade is not this pair or has no amounts.
 */
export function tradeVsAverage(
  avg: { baseMint: string; quoteMint: string; price: number },
  trade: { payMint: string; buyMint: string; payAmount: number | null; buyAmount: number | null },
): number | null {
  const { payAmount: pay, buyAmount: got } = trade;
  if (pay === null || got === null || !(pay > 0) || !(got > 0) || !Number.isFinite(pay) || !Number.isFinite(got)) return null;
  let price: number;
  if (trade.payMint === avg.quoteMint && trade.buyMint === avg.baseMint) price = pay / got;
  else if (trade.payMint === avg.baseMint && trade.buyMint === avg.quoteMint) price = got / pay;
  else return null;
  const pct = (price / avg.price - 1) * 100;
  return Number.isFinite(pct) ? pct : null;
}

async function readJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: GT_ACCEPT }, signal });
  if (!res.ok) throw new Error(`GeckoTerminal read failed (${res.status})`);
  return res.json() as Promise<unknown>;
}

/** Each pair's answer, for a minute, so the form and the review share one read. */
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: PairAverage }>();
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Reads the pair's top pool (from the page of pools of the coin less likely to be a
 * quote coin first, then the other's) and its candles. Any read that failed is
 * 'unread': a search that could not run is not "no pool".
 */
export async function fetchPairAverage(a: string, b: string, signal?: AbortSignal, nowMs: () => number = Date.now): Promise<PairAverage> {
  if (a === b) return { kind: 'none' };
  const key = pairKey(a, b);
  const hit = cache.get(key);
  if (hit && nowMs() - hit.at < TTL_MS) return hit.value;
  const value = await readPairAverage(a, b, signal, nowMs);
  if (value.kind !== 'unread') cache.set(key, { at: nowMs(), value });
  return value;
}

async function readPairAverage(a: string, b: string, signal: AbortSignal | undefined, nowMs: () => number): Promise<PairAverage> {
  let pool: PairPool | null = null;
  let missed = false;
  for (const mint of sayAs(a, b)) {
    try {
      const found = findPairPool(await readJson(geckoEdgeUrl(`/networks/solana/tokens/${mint}/pools`, { page: 1 }), signal), a, b);
      if (found === 'unread') missed = true;
      else if (found) { pool = found; break; }
    } catch (err) {
      if (signal?.aborted) throw err;
      missed = true;
    }
  }
  if (!pool) return { kind: missed ? 'unread' : 'none' };
  if (pool.trades24h === null || pool.volumeUsd24h === null) return { kind: 'unread' };
  if (pool.trades24h < MIN_TRADES_24H || pool.volumeUsd24h < MIN_VOLUME_USD_24H) return { kind: 'thin' };
  let raw: unknown;
  try {
    raw = await readJson(
      geckoEdgeUrl(`/networks/solana/pools/${pool.address}/ohlcv/minute`, { aggregate: 15, limit: 100, currency: 'token' }),
      signal,
    );
  } catch (err) {
    if (signal?.aborted) throw err;
    return { kind: 'unread' };
  }
  const candles = readCandles(raw);
  if (!candles) return { kind: 'unread' };
  const avg = volumeWeighted(candles.rows, nowMs() / 1000);
  if (typeof avg !== 'number') return { kind: avg };
  return orientAverage(candles, avg, a, b);
}

/** For tests: forget every cached answer. */
export function forgetPairAverages(): void {
  cache.clear();
}
