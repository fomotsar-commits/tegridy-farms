// SINCE, the trencher layer's early flex (island answer twenty-four, build 7): "In {coin}
// since {month year}." from the island's own first-hold time, and the percentile form only
// when the island serves `earlier_than_pct` beside `held_since_unix` and the line is about
// the coin that time belongs to. The words are TRENCHER_WORDS, quoted, never rebuilt here.

import { describe, it, expect } from 'vitest';
import { TRENCHER_WORDS } from '../arrival';
import { parseHeatReading } from './heatOracle';
import { earliestRow, sinceLine, sinceMonth } from './sinceLine';

// /api/heat/27t671aWXQvfUk6WugfLFEKkaXbJmT5yxpmrydEkjjo7 as the island answered it on
// 2026-11-03, cut to two of its ten rows: held_since_unix is BAYLA's first hold.
const LIVE = {
  address: '27t671aWXQvfUk6WugfLFEKkaXbJmT5yxpmrydEkjjo7',
  degrees: 55.53,
  tier: 'Observer',
  is_cold: false,
  held_since_unix: 1790942430,
  as_of_unix: 1793621162,
  token_count: 10,
  x_handle: '@thegreatlambiny',
  breakdown: [
    {
      token_address: '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump', chain: 'solana', name: 'Bayla', symbol: 'BAYLA',
      heat_degrees: 44.5, first_seen_at_unix: 1790942430, last_transfer_at_unix: null, retired: false,
      room_rank: 349, room_holders: 541,
    },
    {
      token_address: '0xd37264c71e9af940e49795f0d3a8336afaafdda9', chain: 'ethereum', name: 'Junglebayapeclub', symbol: 'JBAC',
      heat_degrees: 28.51, first_seen_at_unix: 1792497861, last_transfer_at_unix: null, retired: false,
      room_rank: 2012, room_holders: 2024,
    },
  ],
};

const read = (over: Record<string, unknown> = {}) => parseHeatReading({ ...LIVE, ...over });
const bayla = (r = read()) => r.breakdown.find((row) => row.symbol === 'BAYLA')!;
const jbac = (r = read()) => r.breakdown.find((row) => row.symbol === 'JBAC')!;

describe('the month', () => {
  it('is the month and year in UTC, as the island’s card prints the date', () => {
    // The island's own card for this wallet reads "held since October 2, 2026".
    expect(sinceMonth(1790942430)).toBe('October 2026');
    // The last half hour of a month is still that month, whatever the viewer's clock says.
    expect(sinceMonth(Date.parse('2026-10-31T23:30:00Z') / 1000)).toBe('October 2026');
    expect(sinceMonth(Date.parse('2026-11-01T00:00:00Z') / 1000)).toBe('November 2026');
  });
});

describe('which coin held_since_unix belongs to', () => {
  it('is the row whose first hold is that instant', () => {
    expect(earliestRow(read())?.symbol).toBe('BAYLA');
  });

  it('on a tie, the deepest of them', () => {
    const r = read({ breakdown: [LIVE.breakdown[1], { ...LIVE.breakdown[1], symbol: 'PEPE', heat_degrees: 90, first_seen_at_unix: 1790942430 }, LIVE.breakdown[0]] });
    expect(earliestRow(r)?.symbol).toBe('PEPE');
  });

  it('is nobody when no row carries it, or when the island served no held_since_unix', () => {
    expect(earliestRow(read({ held_since_unix: 1790000000 }))).toBeNull();
    expect(earliestRow(read({ held_since_unix: null }))).toBeNull();
    expect(earliestRow(read({ breakdown: [] }))).toBeNull();
  });
});

describe('the line', () => {
  it('prints the plain line while the island serves no percentile (today)', () => {
    const r = read();
    expect(sinceLine(r, bayla(r), 'BAYLA')).toBe(TRENCHER_WORDS.since('BAYLA', 'October 2026'));
    expect(sinceLine(r, bayla(r), 'BAYLA')).toBe('In BAYLA since October 2026.');
    expect(sinceLine(r, jbac(r), 'JBAC')).toBe('In JBAC since October 2026.');
  });

  it('adds the served percentile, in whole points, for the coin held_since_unix belongs to', () => {
    const r = read({ earlier_than_pct: 87.4 });
    expect(sinceLine(r, bayla(r), 'BAYLA')).toBe(TRENCHER_WORDS.sinceEarlier('BAYLA', 'October 2026', 87));
    expect(sinceLine(r, bayla(r), 'BAYLA')).toBe("In BAYLA since October 2026, earlier than 87% of today's holders.");
  });

  it('never rounds a percentile up past what was served', () => {
    const r = read({ earlier_than_pct: 99.6 });
    expect(sinceLine(r, bayla(r), 'BAYLA')).toContain('earlier than 99% of');
  });

  it('keeps the percentile off every other coin: it was served beside held_since_unix, which is not theirs', () => {
    const r = read({ earlier_than_pct: 87.4 });
    expect(sinceLine(r, jbac(r), 'JBAC')).toBe('In JBAC since October 2026.');
  });

  it('keeps it off when two coins share that first hold, since it could be either one’s', () => {
    const r = read({ earlier_than_pct: 87.4, breakdown: [LIVE.breakdown[0], { ...LIVE.breakdown[1], first_seen_at_unix: 1790942430 }] });
    expect(sinceLine(r, bayla(r), 'BAYLA')).toBe('In BAYLA since October 2026.');
  });

  it('prints the plain line for a percentile under one whole point', () => {
    const r = read({ earlier_than_pct: 0.4 });
    expect(sinceLine(r, bayla(r), 'BAYLA')).toBe('In BAYLA since October 2026.');
  });

  it('says nothing for a coin whose first hold the island did not serve', () => {
    const r = read({ breakdown: [{ ...LIVE.breakdown[0], first_seen_at_unix: null }] });
    expect(sinceLine(r, r.breakdown[0]!, 'BAYLA')).toBeNull();
  });
});
