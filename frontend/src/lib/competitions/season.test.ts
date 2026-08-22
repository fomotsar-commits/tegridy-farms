// Season definitions: fixed dates, one known quote token, and no prize anywhere
// in the type.

import { describe, it, expect } from 'vitest';
import { SEASONS, SETTLEMENT, findSeason, seasonStatus, seasonWhere } from './season';
import { findQuoteToken } from '../copytrade/quoteTokens';

describe('the declared seasons', () => {
  it('declares at least one, so the page has something to score', () => {
    expect(SEASONS.length).toBeGreaterThan(0);
  });

  it('denominates every season in a token whose decimals are actually known', () => {
    // A season quoted in a token this build cannot decode would render every
    // total as a raw integer, or — worse, if the table were bypassed — as a
    // number with an assumed decimal point.
    for (const season of SEASONS) {
      expect(findQuoteToken(season.quoteToken), `${season.id} has an unknown quote token`).not.toBeNull();
    }
  });

  it('uses fixed dates, never a window that re-bases on the clock', () => {
    // A rolling window would make every past standing unreproducible: the same
    // page read a week later would rank a different span under the same name.
    for (const season of SEASONS) {
      expect(season.endsAt).toBeGreaterThan(season.startsAt);
      expect(Number.isInteger(season.startsAt)).toBe(true);
      expect(Number.isInteger(season.endsAt)).toBe(true);
    }
  });

  it('carries no prize, escrow or payout field at all', () => {
    // Absent rather than present-and-null. An optional prize field is an
    // invitation to fill it in from a config, and this venue may not promise
    // capital it has not earned.
    for (const season of SEASONS) {
      const keys = Object.keys(season).map((k) => k.toLowerCase());
      for (const forbidden of ['prize', 'prizepool', 'reward', 'payout', 'escrow', 'pot']) {
        expect(keys, `${season.id} declares a ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('has unique ids, since they key both the URL and the React list', () => {
    expect(new Set(SEASONS.map((s) => s.id)).size).toBe(SEASONS.length);
  });

  it('finds a season by id and returns null rather than a stand-in', () => {
    expect(findSeason(SEASONS[0]!.id)).toEqual(SEASONS[0]);
    expect(findSeason('no-such-season')).toBeNull();
  });
});

describe('seasonStatus', () => {
  const season = SEASONS[0]!;

  it('reads the clock and nothing else', () => {
    expect(seasonStatus(season, season.startsAt - 1)).toBe('upcoming');
    expect(seasonStatus(season, season.startsAt)).toBe('live');
    expect(seasonStatus(season, season.endsAt)).toBe('live');
    expect(seasonStatus(season, season.endsAt + 1)).toBe('ended');
  });

  it('describes "ended" as a date having passed, not as a settlement', () => {
    // There is no keeper. Nothing closes a season, freezes a standing or pays
    // anything, and the copy the page renders has to say so.
    expect(SETTLEMENT).toMatch(/no prize pool/i);
    expect(SETTLEMENT).toMatch(/no process closes a season/i);
  });
});

describe('seasonWhere', () => {
  it('bounds BOTH ends so an ended season stops at its own end', () => {
    // With only a lower bound, an ended season would keep ranking swaps made
    // after it finished — under its name, and rising.
    const season = SEASONS[0]!;
    expect(seasonWhere(season)).toEqual({
      timestamp_gte: String(season.startsAt),
      timestamp_lte: String(season.endsAt),
    });
  });

  it('sends decimal strings, never JSON numbers, for the uint256 column', () => {
    const where = seasonWhere(SEASONS[0]!) as Record<string, unknown>;
    expect(typeof where.timestamp_gte).toBe('string');
    expect(typeof where.timestamp_lte).toBe('string');
  });
});
