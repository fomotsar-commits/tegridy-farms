// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  parseOhlcvList,
  topPoolAddress,
  linePath,
  areaPath,
  rangeChangePct,
  formatChartPrice,
  type OhlcvPoint,
} from './solanaChart';

// GT returns rows [ts, open, high, low, close, volume], NEWEST FIRST.
const NEWEST_FIRST_FIXTURE = [
  [3000, 1.0, 1.2, 0.9, 1.1, 500],
  [2000, 0.9, 1.0, 0.8, 1.0, 400],
  [1000, 0.8, 0.9, 0.7, 0.9, 300],
];

describe('parseOhlcvList', () => {
  it('parses valid rows and sorts ASCENDING from a newest-first payload', () => {
    expect(parseOhlcvList(NEWEST_FIRST_FIXTURE)).toEqual([
      { ts: 1000, close: 0.9 },
      { ts: 2000, close: 1.0 },
      { ts: 3000, close: 1.1 },
    ]);
  });

  it('drops garbage rows instead of zero-filling them', () => {
    const dirty = [
      [2000, 1, 1, 1, 2.5, 10], // valid
      'not-a-row', // not an array
      null,
      [1000, 1, 1, 1, '3', 10], // close is a string
      [NaN, 1, 1, 1, 4, 10], // non-finite ts
      [4000, 1, 1, 1, Infinity, 10], // non-finite close
      [3000], // too short — close missing
      [1500, 1, 1, 1, 1.5, 10], // valid
    ];
    expect(parseOhlcvList(dirty)).toEqual([
      { ts: 1500, close: 1.5 },
      { ts: 2000, close: 2.5 },
    ]);
  });

  it('returns [] for a non-array payload', () => {
    expect(parseOhlcvList(undefined)).toEqual([]);
    expect(parseOhlcvList(null)).toEqual([]);
    expect(parseOhlcvList({ ohlcv_list: [] })).toEqual([]);
    expect(parseOhlcvList('[]')).toEqual([]);
  });
});

describe('topPoolAddress', () => {
  it('takes the FIRST pool and strips the solana_ prefix', () => {
    const raw = {
      data: [
        { id: 'solana_PoolAddr111', type: 'pool' },
        { id: 'solana_PoolAddr222', type: 'pool' },
      ],
    };
    expect(topPoolAddress(raw)).toBe('PoolAddr111');
  });

  it('returns null when the token has no pools or the payload is malformed', () => {
    expect(topPoolAddress({ data: [] })).toBeNull();
    expect(topPoolAddress({})).toBeNull();
    expect(topPoolAddress(null)).toBeNull();
    expect(topPoolAddress({ data: [{ notId: 'x' }] })).toBeNull();
    expect(topPoolAddress({ data: [{ id: 42 }] })).toBeNull();
    expect(topPoolAddress({ data: [{ id: 'solana_' }] })).toBeNull(); // empty after strip
  });
});

describe('linePath', () => {
  // closes [1, 3, 2] into a 100×50 box with 4px padding:
  //   x: 4, 50, 96
  //   y: min(1) → 46 (bottom pad), max(3) → 4 (top pad), 2 → 25 (midpoint)
  const PTS: OhlcvPoint[] = [
    { ts: 1, close: 1 },
    { ts: 2, close: 3 },
    { ts: 3, close: 2 },
  ];

  it('maps a known 3-point fixture exactly (y-inverted, 4px padded)', () => {
    expect(linePath(PTS, 100, 50)).toBe('M 4 46 L 50 4 L 96 25');
  });

  it('stays inside the padded box for every point', () => {
    const path = linePath(PTS, 100, 50);
    const coords = [...path.matchAll(/[ML] ([\d.]+) ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(coords).toHaveLength(3);
    for (const [x, y] of coords) {
      expect(x).toBeGreaterThanOrEqual(4);
      expect(x).toBeLessThanOrEqual(96);
      expect(y).toBeGreaterThanOrEqual(4);
      expect(y).toBeLessThanOrEqual(46);
    }
  });

  it('returns "" for empty input', () => {
    expect(linePath([], 100, 50)).toBe('');
  });

  it('draws a centered flat line for a constant-price series (no divide-by-zero)', () => {
    const flat: OhlcvPoint[] = [
      { ts: 1, close: 5 },
      { ts: 2, close: 5 },
    ];
    expect(linePath(flat, 100, 50)).toBe('M 4 25 L 96 25');
  });

  it('draws a full-width flat line for a single point', () => {
    expect(linePath([{ ts: 1, close: 7 }], 100, 50)).toBe('M 4 25 L 96 25');
  });
});

describe('areaPath', () => {
  it('closes the line path down to the bottom edge', () => {
    const pts: OhlcvPoint[] = [
      { ts: 1, close: 1 },
      { ts: 2, close: 3 },
      { ts: 3, close: 2 },
    ];
    expect(areaPath(pts, 100, 50)).toBe('M 4 46 L 50 4 L 96 25 L 96 50 L 4 50 Z');
  });

  it('returns "" when there is nothing to draw', () => {
    expect(areaPath([], 100, 50)).toBe('');
  });
});

describe('rangeChangePct', () => {
  it('is last close vs first close, in percent', () => {
    const pts: OhlcvPoint[] = [
      { ts: 1, close: 100 },
      { ts: 2, close: 90 },
      { ts: 3, close: 110 },
    ];
    expect(rangeChangePct(pts)).toBeCloseTo(10, 10);
  });

  it('handles a drop as a negative percent', () => {
    const pts: OhlcvPoint[] = [
      { ts: 1, close: 4 },
      { ts: 2, close: 3 },
    ];
    expect(rangeChangePct(pts)).toBeCloseTo(-25, 10);
  });

  it('returns null on <2 points or a zero first close', () => {
    expect(rangeChangePct([])).toBeNull();
    expect(rangeChangePct([{ ts: 1, close: 1 }])).toBeNull();
    expect(rangeChangePct([{ ts: 1, close: 0 }, { ts: 2, close: 1 }])).toBeNull();
  });
});

describe('formatChartPrice', () => {
  it('keeps significant digits on sub-cent prices — never "$0.00" for a real price', () => {
    expect(formatChartPrice(0.00001234)).toBe('$0.00001234');
    expect(formatChartPrice(0.00001234)).not.toBe('$0.00');
    expect(formatChartPrice(0.5)).toBe('$0.5');
  });

  it('renders $1+ prices as plain 2-decimal figures', () => {
    expect(formatChartPrice(1.5)).toBe('$1.50');
    expect(formatChartPrice(1234.567)).toBe('$1,234.57');
  });

  it('renders non-finite input as an em dash, and zero as $0.00', () => {
    expect(formatChartPrice(NaN)).toBe('—');
    expect(formatChartPrice(Infinity)).toBe('—');
    expect(formatChartPrice(0)).toBe('$0.00');
  });
});
