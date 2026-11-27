// @vitest-environment node
//
// Where a pairing coin's pool with a coin ranked below it is found and opened, in one plain
// sentence (pre-merge read, 2026-11-14: "A pool of BAYLA and BOBO, SOY, BRAINLET or RIZZ is
// found and opened from the other side" was hard to follow). Same facts, no more words.
import { describe, expect, it } from 'vitest';
import { BAYLA_QUOTE, BRAINLET_QUOTE, RIZZ_QUOTE, USDC_QUOTE, otherSideLine } from './quotes';

const OLD_BAYLA = 'A pool of BAYLA and BOBO, SOY, BRAINLET or RIZZ is found and opened from the other side: look up BOBO, SOY, BRAINLET or RIZZ and pair it with BAYLA.';
const words = (s: string) => s.split(/\s+/).length;

describe('otherSideLine', () => {
  it('says to look up the lower coin and pair it with this one, to find or to open such a pool', () => {
    expect(otherSideLine(BAYLA_QUOTE.mint)).toBe('To find or open a pool of BAYLA with BOBO, SOY, BRAINLET or RIZZ, look up that coin and pair it with BAYLA.');
    expect(otherSideLine(USDC_QUOTE.mint)).toBe('To find or open a pool of USDC with BAYLA, BOBO, SOY, BRAINLET or RIZZ, look up that coin and pair it with USDC.');
  });

  it('names the one coin when there is only one below', () => {
    expect(otherSideLine(BRAINLET_QUOTE.mint)).toBe('To find or open a pool of BRAINLET with RIZZ, look up RIZZ and pair it with BRAINLET.');
  });

  it('says nothing for the last coin in rank, or for a token that is no pairing coin', () => {
    expect(otherSideLine(RIZZ_QUOTE.mint)).toBeNull();
    expect(otherSideLine('So11111111111111111111111111111111111111111x')).toBeNull();
  });

  it('is no longer than the sentence it replaced', () => {
    expect(words(otherSideLine(BAYLA_QUOTE.mint)!)).toBeLessThanOrEqual(words(OLD_BAYLA));
  });
});
