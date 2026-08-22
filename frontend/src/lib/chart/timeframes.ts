// The timeframes the candle chart offers, and the honesty note each one carries.
//
// The set is deliberately short and bounded at the top by what ONE indexer page
// can cover. The client caps a page at MAX_PAGE_LIMIT rows (lib/indexer/client.ts)
// and there is no cursor walk here, so a weekly candle built from the last
// hundred swaps of a thin pool would be one or two buckets wide — a chart shaped
// like an answer that has almost no data in it. Anything longer than a day is
// left out rather than shipped as a near-empty frame.

export const TIMEFRAME_IDS = ['5m', '1h', '4h', '1d'] as const;

export type TimeframeId = (typeof TIMEFRAME_IDS)[number];

export interface Timeframe {
  id: TimeframeId;
  label: string;
  bucketSeconds: number;
}

export const TIMEFRAMES: Record<TimeframeId, Timeframe> = {
  '5m': { id: '5m', label: '5M', bucketSeconds: 300 },
  '1h': { id: '1h', label: '1H', bucketSeconds: 3600 },
  '4h': { id: '4h', label: '4H', bucketSeconds: 14400 },
  '1d': { id: '1d', label: '1D', bucketSeconds: 86400 },
};

export const DEFAULT_TIMEFRAME: TimeframeId = '1h';

export function isTimeframeId(value: string): value is TimeframeId {
  return (TIMEFRAME_IDS as readonly string[]).includes(value);
}

export function timeframeOf(id: string): Timeframe {
  return isTimeframeId(id) ? TIMEFRAMES[id] : TIMEFRAMES[DEFAULT_TIMEFRAME];
}
