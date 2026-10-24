// The room rank line, "12th of 498 measured": the island's two served numbers and
// nothing of ours. An unranked wallet (room_rank null) prints nothing.

import { describe, it, expect } from 'vitest';
import { ordinal, roomRankLine, servedCount } from './roomRank';

describe('ordinal', () => {
  it.each([
    [1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [10, '10th'],
    [11, '11th'], [12, '12th'], [13, '13th'], [14, '14th'],
    [21, '21st'], [22, '22nd'], [23, '23rd'], [24, '24th'],
    [100, '100th'], [101, '101st'], [102, '102nd'], [103, '103rd'],
    [111, '111th'], [112, '112th'], [113, '113th'], [121, '121st'],
  ] as const)('%d reads %s', (n, word) => {
    expect(ordinal(n)).toBe(word);
  });

  it('groups thousands and still takes the suffix from the last two digits', () => {
    expect(ordinal(1001)).toBe('1,001st');
    expect(ordinal(1011)).toBe('1,011th');
    expect(ordinal(13721)).toBe('13,721st');
    expect(ordinal(13712)).toBe('13,712th');
  });
});

describe('servedCount', () => {
  it('passes a whole number of one or more', () => {
    expect(servedCount(1)).toBe(1);
    expect(servedCount(515)).toBe(515);
  });

  it('reads anything else as not served', () => {
    // The island sends room_rank: null for a wallet it does not rank. A zero, a
    // fraction or a string is not a place in a room either.
    for (const v of [null, undefined, 0, -3, 1.5, NaN, Infinity, '12', true, {}]) {
      expect(servedCount(v), String(v)).toBeNull();
    }
  });
});

describe('roomRankLine', () => {
  it('prints the two served numbers, in the island’s words', () => {
    expect(roomRankLine(12, 498)).toBe('12th of 498 measured');
    expect(roomRankLine(1, 515)).toBe('1st of 515 measured');
  });

  it('groups a large room', () => {
    expect(roomRankLine(1, 13721)).toBe('1st of 13,721 measured');
    expect(roomRankLine(1204, 13721)).toBe('1,204th of 13,721 measured');
  });

  it('prints nothing for a wallet the island does not rank', () => {
    expect(roomRankLine(null, 515)).toBeNull();
  });

  it('prints nothing when the room count did not arrive', () => {
    expect(roomRankLine(12, null)).toBeNull();
  });

  it('prints a rank as served, even one past the count', () => {
    // Ties share a rank and the count is the island's own. The venue never repairs either.
    expect(roomRankLine(516, 515)).toBe('516th of 515 measured');
  });
});
