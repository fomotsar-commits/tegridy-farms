// @vitest-environment node
//
// The pace sentence: the one place LP copy says "a year". Every expected string is worked by
// hand here from the rule in words (simple proportion over 365 days, two significant figures,
// cut), never from pace.ts.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FORECAST_WORDS } from './format';
import { PACE_SENTENCE, paceText, percentText } from './pace';

const DAY = 86_400;
const YEAR = 365 * DAY;
const TAIL = 'Past trades, not a forecast.';

describe('when there is a sentence at all', () => {
  it('none for a growth that is zero or negative, a value that is zero or negative, or no time', () => {
    for (const growth of [0n, -1n, -961_245n]) expect(paceText({ growth, against: 1_000n, seconds: 7 * DAY })).toBeNull();
    for (const against of [0n, -5n]) expect(paceText({ growth: 10n, against, seconds: 7 * DAY })).toBeNull();
    for (const seconds of [0, 0.5, -DAY, Number.NaN, Number.POSITIVE_INFINITY]) expect(paceText({ growth: 10n, against: 1_000n, seconds })).toBeNull();
    expect(percentText(0n, 1_000n)).toBeNull();
    expect(percentText(-1n, 1_000n)).toBeNull();
    expect(percentText(1n, 0n)).toBeNull();
  });
});

describe('the venue’s own pool and its opener, 6.3 days after it opened (mainnet, slot 455093758)', () => {
  // 2026-10-03 19:18:03 UTC to 2026-10-10 02:31 UTC is 544,377 seconds: 6.3006 days, cut to 6.3.
  const seconds = 544_377;

  it('the opener: 961,245 lamports of growth on a position worth 11,435,513,242', () => {
    // 961,245 / 11,435,513,242 = 0.0000840579 = 0.00840579%, cut to two figures 0.0084%.
    // A year is 31,536,000 s: 0.00840579% x 31,536,000 / 544,377 = 0.00840579% x 57.9304 = 0.48695%, cut to 0.48%.
    expect(paceText({ growth: 961_245n, against: 11_435_513_242n, seconds })).toBe(`0.0084% in 6.3 days. At that pace, about 0.48% a year. ${TAIL}`);
    expect(paceText({ growth: 961_245n, against: 11_435_513_242n, seconds, of: 'position' })).toBe(`0.0084% of this position in 6.3 days. At that pace, about 0.48% a year. ${TAIL}`);
  });

  it('the pool: each share is backed by 0.0084065% more than at opening', () => {
    // isqrt(reserves) 372,663,147,122 over 372,631,821,673 shares: 31,325,449 more, 0.0084065%. x 57.9304 = 0.48699%, cut to 0.48%.
    expect(percentText(31_325_449n, 372_631_821_673n)).toBe('0.0084%');
    expect(paceText({ growth: 31_325_449n, against: 372_631_821_673n, seconds })).toBe(`0.0084% in 6.3 days. At that pace, about 0.48% a year. ${TAIL}`);
  });
});

describe('under one day there is no yearly figure', () => {
  it('one second short of a day says the percent and the time only; a whole day says the pace', () => {
    // 1% in a day, 365 days: 365%, cut to two figures 360%.
    expect(paceText({ growth: 1n, against: 100n, seconds: DAY - 1 })).toBe(`1% in 23 hours. ${TAIL}`);
    expect(paceText({ growth: 1n, against: 100n, seconds: DAY })).toBe(`1% in 1 day. At that pace, about 360% a year. ${TAIL}`);
  });

  it('the time is cut to its unit: minutes, hours, days with one decimal under ten days, whole days after', () => {
    // What stands between "in" and the full stop that ends the first sentence.
    const at = (seconds: number) => paceText({ growth: 1n, against: 1_000n, seconds })!.match(/^0\.1% in (.+?)\. (?:At|Past)/)![1];
    expect(at(1)).toBe('under a minute');
    expect(at(59)).toBe('under a minute');
    expect(at(60)).toBe('1 minute');
    expect(at(3_599)).toBe('59 minutes');
    expect(at(3_600)).toBe('1 hour');
    expect(at(DAY - 1)).toBe('23 hours');
    expect(at(DAY)).toBe('1 day');
    expect(at(1.99 * DAY)).toBe('1.9 days');
    expect(at(6 * DAY + 60)).toBe('6 days');
    expect(at(9.99 * DAY)).toBe('9.9 days');
    expect(at(10.9 * DAY)).toBe('10 days');
    expect(at(400 * DAY)).toBe('400 days');
  });
});

describe('the rounding rule: two significant figures, cut, never rounded up', () => {
  it('a percent is never said higher than it was measured', () => {
    expect(percentText(4_899n, 1_000_000n)).toBe('0.48%'); // 0.4899%
    expect(percentText(199n, 1_000_000n)).toBe('0.019%'); // 0.0199%
    expect(percentText(5n, 1_000n)).toBe('0.5%');
    expect(percentText(1_299n, 10_000n)).toBe('12%'); // 12.99%
    expect(percentText(129n, 100n)).toBe('120%');
    expect(percentText(10n, 1n)).toBe('1,000%');
  });

  it('the yearly figure is a simple proportion, never compounded, and cut the same way', () => {
    // 1.999% in exactly a year is 1.999% a year: both cut to 1.9%.
    expect(paceText({ growth: 1_999n, against: 100_000n, seconds: YEAR })).toBe(`1.9% in 365 days. At that pace, about 1.9% a year. ${TAIL}`);
    // 0.1% a day for 30 days is 3%: 3% x 365 / 30 = 36.5%, cut to 36%. Compounded daily it would be 44%.
    expect(paceText({ growth: 3n, against: 100n, seconds: 30 * DAY })).toBe(`3% in 30 days. At that pace, about 36% a year. ${TAIL}`);
  });
});

describe('very small and very large figures stay sane', () => {
  it('under 0.0001% is said as under, with its time and no yearly figure', () => {
    // 9 over 10,000,000,000 is 0.00000009%; a year of it would still be told from rounding by nobody.
    expect(percentText(9n, 10_000_000_000n)).toBe('under 0.0001%');
    expect(paceText({ growth: 9n, against: 10_000_000_000n, seconds: 7 * DAY })).toBe(`under 0.0001% in 7 days. ${TAIL}`);
    // Exactly 0.0001% is a number: 0.0001% x 365 / 7 = 0.00521%, cut to 0.0052%.
    expect(paceText({ growth: 1n, against: 1_000_000n, seconds: 7 * DAY })).toBe(`0.0001% in 7 days. At that pace, about 0.0052% a year. ${TAIL}`);
  });

  it('one huge early trade: the measure is said, the yearly figure it would make is not', () => {
    // 5% in one day would be 1,825% a year: over 1,000%, so no yearly figure is printed at all.
    expect(paceText({ growth: 5n, against: 100n, seconds: DAY })).toBe(`5% in 1 day. ${TAIL}`);
    // 1,000% a year exactly is still said; a hair over is not.
    expect(paceText({ growth: 1_000n, against: 100n, seconds: YEAR })).toBe(`1,000% in 365 days. At that pace, about 1,000% a year. ${TAIL}`);
    expect(paceText({ growth: 100_001n, against: 10_000n, seconds: YEAR })).toBe(`more than 1,000% in 365 days. ${TAIL}`);
    // Thirty digits of growth over one unit: no exponent, no Infinity, no yearly figure.
    expect(paceText({ growth: 10n ** 30n, against: 1n, seconds: 3 * DAY })).toBe(`more than 1,000% in 3 days. ${TAIL}`);
    // A measure over the line gets no yearly figure even when a long window would bring it under (1,500% in three years).
    expect(paceText({ growth: 15n, against: 1n, seconds: 3 * YEAR })).toBe(`more than 1,000% in 1,095 days. ${TAIL}`);
  });
});

describe('the yearly figure never appears without its basis (the one door in the forecast-word rule)', () => {
  const growths = [1n, 7n, 961_245n, 10n ** 9n, 10n ** 18n, 10n ** 30n];
  const againsts = [1n, 1_000n, 11_435_513_242n, 10n ** 15n, 10n ** 24n];
  const spans = [1, 59, 3_600, DAY - 1, DAY, 2.5 * DAY, 6.3 * DAY, 30 * DAY, YEAR, 10 * YEAR];
  const all = growths.flatMap((growth) => againsts.flatMap((against) => spans.flatMap((seconds) => [paceText({ growth, against, seconds }), paceText({ growth, against, seconds, of: 'position' })])));
  const said = all.filter((s): s is string => s !== null);
  const yearly = said.filter((s) => /a year/.test(s));

  it('the grid says both forms', () => {
    expect(said).toHaveLength(all.length);
    expect(yearly.length).toBeGreaterThan(20);
    expect(said.length - yearly.length).toBeGreaterThan(20);
  });

  it('every string carries how long it covers and that it is past, in the same string as any yearly figure', () => {
    for (const s of said) {
      expect(s).toMatch(/% (?:of this position )?in (?:under a minute|[\d,.]+ (?:minute|hour|day)s?)\. /);
      expect(s.endsWith(` ${TAIL}`)).toBe(true);
    }
    for (const s of yearly) {
      expect(s).toMatch(/^[\d,.]+% (?:of this position )?in [\d,.]+ days?\. At that pace, about [\d,.]+% a year\. Past trades, not a forecast\.$/);
      expect(s.match(/a year/g)).toHaveLength(1);
    }
  });

  it('PACE_SENTENCE matches each string whole and nothing shorter: with the basis or the last sentence cut off, the yearly words stay behind', () => {
    for (const s of said) expect(s.replace(PACE_SENTENCE, '')).toBe('');
    const whole = paceText({ growth: 961_245n, against: 11_435_513_242n, seconds: 544_377 })!;
    for (const cut of [whole.replace(` ${TAIL}`, ''), whole.replace(/^.* days\. /, ''), 'At that pace, about 0.48% a year.', 'about 0.48% a year']) {
      expect(cut.replace(PACE_SENTENCE, '')).toMatch(FORECAST_WORDS);
    }
  });

  it('"a year" is the only forecast word it ever says: no APR, APY, annual, guaranteed or compound', () => {
    for (const s of said) {
      expect(s).not.toMatch(/\bAPR\b|\bAPY\b|annual|guarantee|compound|yield|e\+|Infinity|NaN/i);
      expect(s.replace(/ a year\./, '.')).not.toMatch(FORECAST_WORDS);
      expect(s).not.toContain('—');
    }
  });

  it('no other LP source says a yearly, daily or weekly rate: pace.ts is the only door, format.ts holds the ban', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const dirs = [here, join(here, '..', '..', '..', 'components', 'solana', 'lp')];
    // And the two pages that mount the LP section, whose own cards speak of fees.
    const pages = ['PoolsPage.tsx', 'SolanaLpPage.tsx'].map((f) => join(here, '..', '..', '..', 'pages', f));
    const files = [...dirs.flatMap((d) => readdirSync(d).filter((f) => /\.tsx?$/.test(f) && !/\.(test|fixture)\./.test(f)).map((f) => join(d, f))), ...pages];
    expect(files.length).toBeGreaterThan(32);
    const saying = files.filter((f) => /a year|annual|per day|per week|rate of return/i.test(readFileSync(f, 'utf8'))).map((f) => f.replace(/^.*[\\/]/, ''));
    expect(saying.sort()).toEqual(['format.ts', 'pace.ts']);
  });
});
