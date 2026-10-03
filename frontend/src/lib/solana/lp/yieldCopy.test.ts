// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { shortAddress } from './format';
import { YIELD_WORDS, withoutAddresses, yieldClaim } from './yieldCopy.fixture';

/** The check the e2e specs used to make, kept here to show what was wrong with it. */
const OLD = /APR|APY|yield of/i;

// Address-shaped strings (base58, 44 characters) crafted to carry the letters, the way a
// freshly generated key does about once in a few dozen runs: "aPr", "Apy", "APR", "yieLd".
const CRAFTED = [
  '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'.replace('5jBk', 'aPr9'),
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'.replace('RgixC', 'RApyC'),
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'.replace('qN1x', 'APR1'),
  'So11111111111111111111111111111111yieLdof112',
];

describe('the yield-copy check means the words, never letters inside an address', () => {
  it('the crafted addresses are base58 of an address length', () => {
    for (const a of CRAFTED) expect(a).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    // The fourth carries "yieLd": never a claim either, with or without its address removed.
    expect(yieldClaim(`Token ${CRAFTED[3]}`)).toBeNull();
    expect(YIELD_WORDS.test(CRAFTED[3]!)).toBe(false);
  });

  it('the OLD pattern fails on a page whose only "APR" is inside an address; the new check passes it', () => {
    for (const a of CRAFTED.slice(0, 3)) {
      const page = `Pool ${a}\nFee tier 1: traders pay 1.00% a trade; LPs keep 84.000% of each trade\nDeposits: the checks pass`;
      expect(OLD.test(page), `old pattern on ${a}`).toBe(true);
      expect(yieldClaim(page), `new check on ${a}`).toBeNull();
    }
  });

  it('the site’s short form of an address is prose-free too: "aPr9…APyZ" is not a claim', () => {
    const short = shortAddress('aPr9tg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosAPyZ');
    expect(short).toBe('aPr9…APyZ');
    expect(OLD.test(`Your share account ${short}`)).toBe(true);
    expect(yieldClaim(`Your share account ${short}`)).toBeNull();
    // Even a short form whose half IS the word, which word boundaries alone would catch.
    expect(YIELD_WORDS.test('account xAPR…APY and more')).toBe(true);
    expect(yieldClaim('account 9APR…APY1 and more')).toBeNull();
    expect(yieldClaim('account 9APR...APY1 and more')).toBeNull();
    expect(yieldClaim('(9APR…APY1)')).toBeNull();
    // Only the exact four-and-four shape is an address: anything longer is read as prose.
    expect(yieldClaim('account 9xAPR…APY1z and more')).not.toBeNull();
  });

  it('a signature (88 characters of base58) is removed whole', () => {
    const sig = `${CRAFTED[0]}${CRAFTED[1]}`;
    expect(withoutAddresses(`Sent: ${sig}.`)).toBe('Sent:  .');
  });

  it('real copy is still caught: "12% APR", "APY", "a yield of", "yields", in any case and beside punctuation', () => {
    for (const copy of [
      'Earn 12% APR on this pool',
      'APR: 12%',
      'Current APY 8.1%',
      '(apy)',
      'a yield of 9% a year',
      'This pool yields 4%',
      'Yield',
      `Pool ${CRAFTED[0]} pays 12% APR`,
      `12% APR\n${CRAFTED[2]}`,
      'APR…',
      // Plurals, and a number glued on: the old pattern caught these too.
      'APRs vary by pool',
      'Pool APYs',
      'APR12%',
      '12%APR',
      // Prose around an ellipsis is not a short address: only four characters each side is.
      'variable APRs…from fees',
      'yields...from fees',
    ]) {
      expect(yieldClaim(copy), copy).not.toBeNull();
    }
    expect(yieldClaim(`Pool ${CRAFTED[0]} pays 12% APR`)).toContain('12% APR');
  });

  it('prose that only contains the letters inside another word is not a claim', () => {
    expect(yieldClaim('An April snapshot of the happy path')).toBeNull();
    expect(yieldClaim('capri sun, therapy, xAPRs, 9APY, APRIL, apyx')).toBeNull();
  });

  it('a named sentence may say "yield" (the one that says none is shown); any other use is still caught', () => {
    const NONE = 'This page shows no yield, because none has been measured.';
    expect(yieldClaim(`Fees.\n${NONE}`)).not.toBeNull();
    expect(yieldClaim(`Fees.\n${NONE}`, [NONE])).toBeNull();
    // The sentence wrapped across lines, as innerText gives it.
    expect(yieldClaim('This page shows no yield,\nbecause none has been measured.', [NONE])).toBeNull();
    expect(yieldClaim(`${NONE} Expected yield: 9%`, [NONE])).toContain('Expected yield');
  });
});
