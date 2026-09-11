// The display/data split, pinned against the locales that broke it.
//
// This suite exists because the bug it guards was real, shipped, and invisible: a MAX
// button that round-tripped its own grouped display string back through the parser
// under-staked by 1000x in every dot-grouping locale, with the wallet showing the
// right number throughout.
import { describe, it, expect } from 'vitest';
import { fmtRaw, toPlain, toRaw, humanDuration, lockLabel, boostLabel } from './format';

describe('fmtRaw is for eyes', () => {
  it('groups and trims trailing zeros', () => {
    expect(fmtRaw(1_234_500_000n, 6)).toBe((1234).toLocaleString() + '.5');
    expect(fmtRaw(1_000_000n, 6)).toBe('1');
  });

  it('an UNREADABLE amount is a dash, never a zero', () => {
    // The venue's most-repeated defect: a read that did not land rendering as a real
    // figure. `null` in, dash out — and a genuine zero still reads as "0".
    expect(fmtRaw(null, 6)).toBe('–');
    expect(fmtRaw(undefined, 6)).toBe('–');
    expect(fmtRaw(0n, 6)).toBe('0');
    expect(fmtRaw(null, 6)).not.toBe('0');
  });

  it('handles a zero-decimal mint without eating the whole number', () => {
    expect(fmtRaw(4_200n, 0)).toBe((4200).toLocaleString());
  });

  it('survives an amount past Number.MAX_SAFE_INTEGER without lying', () => {
    // 2^70 raw units at 0 decimals. toLocaleString on a lossy Number would print a
    // rounded figure; the fallback keeps the exact digits instead.
    const huge = 1n << 70n;
    expect(fmtRaw(huge, 0)).toBe(huge.toString());
  });

  it('caps the fraction it shows without rounding the number up', () => {
    // 1.999999 at maxFrac 2 shows 1.99, not 2.00 — a display that rounds up reads as
    // more money than the account holds.
    expect(fmtRaw(1_999_999n, 6, 2)).toBe('1.99');
  });
});

describe('toPlain is for parsing', () => {
  it('never groups, so it always survives a round trip', () => {
    for (const raw of [1_234_500_000n, 1_000_000n, 1n, 0n, 999_999_999_999_999n]) {
      expect(toRaw(toPlain(raw, 6), 6)).toBe(raw);
    }
  });

  it('emits no separator a locale could reinterpret', () => {
    // ⚠️ THE LOAD-BEARING ASSERTION. In de-DE `(1234).toLocaleString()` is "1.234";
    // parsed back at 6 decimals that is 1_234_000 raw units instead of
    // 1_234_000_000 — off by a thousand, silently.
    const s = toPlain(1_234_000_000n, 6);
    expect(s).toBe('1234');
    expect(s).not.toMatch(/[,\s\u00A0\u202F]/);
    expect(toRaw(s, 6)).toBe(1_234_000_000n);
  });

  it('and the grouped form really would have been misread', () => {
    // Proves the bug is real rather than theoretical, without depending on the test
    // runner's own locale: parse the dot-grouped rendering directly.
    expect(toRaw('1.234', 6)).toBe(1_234_000n);
    expect(toRaw('1.234', 6)).not.toBe(1_234_000_000n);
  });
});

describe('toRaw refuses what it does not understand', () => {
  it('returns null, NOT zero, for junk', () => {
    // A 0n here is indistinguishable from a real zero and would pass an
    // `amount > 0` gate as "nothing typed" rather than stopping the form.
    for (const bad of ['', ' ', 'abc', '1,234', '1.2.3', '-1', '1e6', '.5', '0x10']) {
      expect(toRaw(bad, 6), `"${bad}" should be unparseable`).toBeNull();
    }
    expect(toRaw('0', 6)).toBe(0n);
  });

  it('TRUNCATES excess precision rather than rounding up', () => {
    // Rounding up would build a transfer for more than the person typed.
    expect(toRaw('1.9999999', 6)).toBe(1_999_999n);
    expect(toRaw('0.0000009', 6)).toBe(0n);
  });

  it('accepts a bare integer and pads it', () => {
    expect(toRaw('5', 6)).toBe(5_000_000n);
    expect(toRaw('5', 0)).toBe(5n);
  });
});

describe('durations stay readable', () => {
  it('rolls a huge runway up to years', () => {
    // "55555d" is a five-digit number nobody reads as 152 years.
    expect(humanDuration(55_555 * 86_400)).toBe('152y');
  });
  it('keeps days where days are the useful unit', () => {
    expect(humanDuration(30 * 86_400)).toBe('30d');
    expect(humanDuration(59 * 86_400)).toBe('59d');
    expect(humanDuration(90 * 86_400)).toBe('3mo');
  });
  it('degrades to hours and minutes, and never to a negative', () => {
    expect(humanDuration(7_200)).toBe('2h');
    expect(humanDuration(120)).toBe('2m');
    expect(humanDuration(0)).toBe('now');
    expect(humanDuration(-500)).toBe('now');
  });
});

describe('ladder labels', () => {
  it('names the rungs the way the ladder does', () => {
    expect(lockLabel(7 * 86_400)).toBe('7d');
    expect(lockLabel(365 * 86_400)).toBe('1y');
    expect(lockLabel(4 * 365 * 86_400)).toBe('4y');
  });
  it('states the FLOOR boost as 0.40x, which is what the program pays', () => {
    // Shipped once as "1.00x-4.00x", which overstates the worst case by 2.5x: a
    // seven-day staker gets four tenths of a share, not a full one.
    expect(boostLabel(4_000)).toBe('0.40×');
    expect(boostLabel(40_000)).toBe('4.00×');
    expect(boostLabel(4_000)).not.toBe('1.00×');
  });
});
