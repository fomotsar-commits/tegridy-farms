// The Solana swap page's quote-against-fill record, as /api/aggregator?resource=fill-scoreboard
// serves it (api/_lib/fillScoreboard.js). Anything the page cannot trust reads as unread,
// never as a figure; an answer the edge cached past its staleAt turns itself behind.

export const FILL_SCOREBOARD_URL = '/api/aggregator?resource=fill-scoreboard';

export interface FillRecord {
  state: 'current' | 'behind';
  asOf: Date;
  windowDays: number;
  trades: number;
  unscored: number;
  /** Basis points over (negative: under) the quote; null with no trades. */
  medianFillBps: number | null;
  worstFillBps: number | null;
  atOrAboveQuote: number;
  nearFloor: number;
  deposits: { trades: number; lamports: bigint };
}

export type FillScoreboard = { state: 'unread' } | FillRecord;

const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const bpsOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));

export function parseFillScoreboard(body: unknown, nowMs: number): FillScoreboard {
  const b = body as Record<string, unknown> | null;
  if (!b || (b.state !== 'current' && b.state !== 'behind')) return { state: 'unread' };
  const asOf = Date.parse(String(b.asOf));
  const staleAt = Date.parse(String(b.staleAt));
  const d = b.deposits as Record<string, unknown> | null;
  if (!Number.isFinite(asOf) || !Number.isFinite(staleAt)) return { state: 'unread' };
  if (![b.windowDays, b.trades, b.unscored, b.atOrAboveQuote, b.nearFloor].every(count)) return { state: 'unread' };
  if (!bpsOrNull(b.medianFillBps) || !bpsOrNull(b.worstFillBps)) return { state: 'unread' };
  if (!d || !count(d.trades) || typeof d.lamports !== 'string' || !/^\d+$/.test(d.lamports)) return { state: 'unread' };
  const trades = b.trades as number;
  if ((b.atOrAboveQuote as number) > trades || (b.nearFloor as number) > trades) return { state: 'unread' };
  return {
    state: b.state === 'behind' || nowMs > staleAt ? 'behind' : 'current',
    asOf: new Date(asOf),
    windowDays: b.windowDays as number,
    trades,
    unscored: b.unscored as number,
    medianFillBps: b.medianFillBps as number | null,
    worstFillBps: b.worstFillBps as number | null,
    atOrAboveQuote: b.atOrAboveQuote as number,
    nearFloor: b.nearFloor as number,
    deposits: { trades: d.trades as number, lamports: BigInt(d.lamports) },
  };
}

export async function fetchFillScoreboard(fetchImpl: typeof fetch = fetch, nowMs = Date.now()): Promise<FillScoreboard> {
  try {
    const r = await fetchImpl(FILL_SCOREBOARD_URL, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return { state: 'unread' };
    return parseFillScoreboard(await r.json(), nowMs);
  } catch {
    return { state: 'unread' };
  }
}

/** "at the quote" within half a basis point, else how far over or under it, in percent. */
export function againstQuote(bps: number): string {
  if (Math.abs(bps) < 0.5) return 'at the quote';
  return `${(Math.abs(bps) / 100).toFixed(2)}% ${bps > 0 ? 'over' : 'under'} the quote`;
}
