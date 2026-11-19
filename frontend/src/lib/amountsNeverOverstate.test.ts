// What a visitor receives, is owed or holds is CUT at the digits shown: never printed above the
// real amount. What a visitor pays is ROUNDED UP: never printed below it. Each printed number is
// read back exactly (digits over a power of ten) and held against the raw bigint it came from.
import { describe, it, expect } from 'vitest';
import { formatUnits } from 'viem';
import { fmtAmount } from './wallet/walletRows';
import {
  formatBalance,
  formatTokenAmount,
  formatTokenAmountGrouped,
  formatTokenAmountGroupedUp,
  formatTokenAmountNearest,
  formatTokenAmountUp,
  formatWholeNumberCut,
  localeCut,
  localeUp,
  toFixedCut,
  toFixedNearest,
  toFixedUp,
} from './formatting';
import { shortAmount } from './islandBasket';
import { formatSol, formatTokenAmount as curveTokenAmount } from './launcher/solana/curve/format';

/** An exact amount: n / 10^scale. */
interface Exact {
  n: bigint;
  scale: number;
}

const SUFFIX: Record<string, number> = { K: 3, M: 6, B: 9, T: 12 };

/** A printed amount read back exactly: commas dropped, a K/M/B/T scale and an e-notation applied. */
function exact(text: string): Exact {
  let t = text.replace(/,/g, '');
  let shift = 0;
  const last = t.slice(-1);
  if (SUFFIX[last] !== undefined) {
    shift = SUFFIX[last]!;
    t = t.slice(0, -1);
  }
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(t);
  if (!m) throw new Error(`not a printed amount: "${text}"`);
  const frac = m[3] ?? '';
  let n = BigInt(m[2]! + frac);
  let scale = frac.length - Number(m[4] ?? 0) - shift;
  if (scale < 0) {
    n *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { n: m[1] ? -n : n, scale };
}

function align(a: Exact, b: Exact): [bigint, bigint, number] {
  const s = Math.max(a.scale, b.scale);
  return [a.n * 10n ** BigInt(s - a.scale), b.n * 10n ** BigInt(s - b.scale), s];
}

function cmp(a: Exact, b: Exact): number {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function minus(a: Exact, b: Exact): Exact {
  const [x, y, s] = align(a, b);
  return { n: x - y, scale: s };
}

const unit = (scale: number): Exact => ({ n: 1n, scale });

/** Printed at or under the real amount, and less than one unit of `place` under it. */
function expectCut(text: string, real: Exact, place: number): void {
  const p = exact(text);
  expect(cmp(p, real), `"${text}" is above the real ${real.n}e-${real.scale}`).toBeLessThanOrEqual(0);
  expect(cmp(minus(real, p), unit(place)), `"${text}" is a unit or more under ${real.n}e-${real.scale}`).toBeLessThan(0);
}

/** Printed at or over the real amount, and less than one unit of `place` over it. */
function expectUp(text: string, real: Exact, place: number): void {
  const p = exact(text);
  expect(cmp(p, real), `"${text}" is below the real ${real.n}e-${real.scale}`).toBeGreaterThanOrEqual(0);
  expect(cmp(minus(p, real), unit(place)), `"${text}" is a unit or more over ${real.n}e-${real.scale}`).toBeLessThan(0);
}

/** The place a fixed-decimals print ends on: its own decimals, or a tiny branch's e-notation or 8 places. */
function fixedPlace(text: string): number {
  return exact(text).scale;
}

/** Seeded, so a failure names a raw amount that can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Raw amounts with the shapes that break rounding: runs of nines, halves, powers of ten, and noise. */
function sweep(count: number, seed: number, maxDigits = 30): { raw: bigint; decimals: number }[] {
  const r = rng(seed);
  const pick = (n: number) => Math.floor(r() * n);
  const out: { raw: bigint; decimals: number }[] = [];
  for (let i = 0; i < count; i++) {
    const len = 1 + pick(maxDigits);
    const decimals = [0, 2, 6, 8, 9, 18][pick(6)]!;
    let digits: string;
    switch (pick(5)) {
      case 0: digits = '9'.repeat(len); break;
      case 1: digits = `${1 + pick(9)}${'0'.repeat(Math.max(0, len - 2))}5`.slice(0, len); break;
      case 2: digits = `1${'0'.repeat(len - 1)}`; break;
      case 3: digits = `${1 + pick(9)}${'9'.repeat(Math.max(0, len - 1))}`; break;
      default: digits = Array.from({ length: len }, (_, k) => String(k === 0 ? 1 + pick(9) : pick(10))).join('');
    }
    out.push({ raw: BigInt(digits), decimals });
  }
  return out;
}

const realOf = (raw: bigint, decimals: number): Exact => ({ n: raw, scale: decimals });

/** The place fmtAmount's shape ends on: whole coins from 1,000, cents from 1, three significant digits under 1. */
function fmtAmountPlace(raw: bigint, decimals: number): number {
  const whole = raw / 10n ** BigInt(decimals);
  if (whole >= 1000n) return 0;
  if (whole >= 1n) return 2;
  const frac = (raw % 10n ** BigInt(decimals)).toString().padStart(decimals, '0');
  return frac.search(/[1-9]/) + 3;
}

describe('fmtAmount (wallet board, Harvest): cut at the digits shown', () => {
  it('never prints above the raw amount, and is less than one unit under it', () => {
    for (const { raw, decimals } of sweep(3000, 1)) {
      if (raw === 0n) continue;
      expectCut(fmtAmount(raw, decimals), realOf(raw, decimals), fmtAmountPlace(raw, decimals));
    }
  });

  it('the named cases', () => {
    expect(fmtAmount(1_284_500_000_000_000_000_000n, 18)).toBe('1,284');
    expect(fmtAmount(290_000_000_000_000_000n, 18)).toBe('0.29');
    expect(fmtAmount(1_005_000_000_000_000_000n, 18)).toBe('1');
    expect(fmtAmount(100_500_000_000_000_000n, 18)).toBe('0.1');
    expect(fmtAmount(999_999_000_000_000_000_000n, 18)).toBe('999.99');
    expect(fmtAmount(52_000n * 10n ** 18n, 18)).toBe('52,000');
    expect(fmtAmount(1_230_000n, 6)).toBe('1.23');
    expect(fmtAmount(4_200n, 6)).toBe('0.0042');
    expect(fmtAmount(0n, 18)).toBe('0');
    // One wei under a whole coin is not a whole coin.
    expect(fmtAmount(10n ** 18n - 1n, 18)).toBe('0.999');
  });
});

describe('formatTokenAmount: cut; formatTokenAmountUp: rounded up', () => {
  it('over exact decimal strings, cut never prints above and Up never below, each within one unit', () => {
    for (const { raw, decimals } of sweep(2500, 2)) {
      const s = formatUnits(raw, decimals);
      for (const places of [0, 2, 4, 6]) {
        const cut = formatTokenAmount(s, places);
        expectCut(cut, realOf(raw, decimals), fixedPlace(cut));
        const up = formatTokenAmountUp(s, places);
        expectUp(up, realOf(raw, decimals), fixedPlace(up));
      }
    }
  });

  it('a number holding at most 15 significant digits prints as its decimal string does', () => {
    for (const { raw, decimals } of sweep(2500, 3, 15)) {
      const s = formatUnits(raw, decimals);
      for (const places of [0, 2, 4, 6]) {
        expect(formatTokenAmount(Number(s), places), s).toBe(formatTokenAmount(s, places));
        expect(formatTokenAmountUp(Number(s), places), s).toBe(formatTokenAmountUp(s, places));
      }
    }
  });

  it('the named cases', () => {
    expect(formatTokenAmount(0.29, 2)).toBe('0.29');
    expect(formatTokenAmount('0.29', 2)).toBe('0.29');
    expect(formatTokenAmount(1.005, 2)).toBe('1.00');
    expect(formatTokenAmountUp(1.005, 2)).toBe('1.01');
    expect(formatTokenAmount(0.1005, 3)).toBe('0.100');
    expect(formatTokenAmountUp(0.1005, 3)).toBe('0.101');
    expect(formatTokenAmount(999.999, 2)).toBe('999.99');
    expect(formatTokenAmountUp(999.999, 2)).toBe('1000.00');
    expect(formatTokenAmount('1.5')).toBe('1.5000');
    expect(formatTokenAmountUp('1.5')).toBe('1.5000');
    expect(formatTokenAmount(0)).toBe('0.0000');
    expect(formatTokenAmountUp(0)).toBe('0.0000');
    // Binary holds neither 0.1 + 0.2 nor 0.7 + 0.1; the noise past 15 digits is not an amount.
    expect(formatTokenAmount(0.1 + 0.2, 4)).toBe('0.3000');
    expect(formatTokenAmountUp(0.1 + 0.2, 4)).toBe('0.3000');
    expect(formatTokenAmount(0.7 + 0.1, 2)).toBe('0.80');
    // One wei under 0.29 ETH stays under it.
    expect(formatTokenAmount('0.289999999999999999', 2)).toBe('0.28');
    expect(formatTokenAmountUp('0.280000000000000001', 2)).toBe('0.29');
    // The tiny branches keep their shapes and their direction.
    expect(formatTokenAmount(0.0000001239)).toBe('1.23e-7');
    expect(formatTokenAmountUp(0.0000001231)).toBe('1.24e-7');
    expect(formatTokenAmountUp('0.000000999999')).toBe('1.00e-6');
    expect(formatTokenAmount(0.000056789)).toBe('0.00005678');
  });
});

describe('formatTokenAmountGrouped: cut; formatTokenAmountGroupedUp: rounded up', () => {
  it('over exact decimal strings, never above (cut) and never below (Up), each within one unit', () => {
    for (const { raw, decimals } of sweep(2500, 4)) {
      const s = formatUnits(raw, decimals);
      for (const places of [2, 4]) {
        const cut = formatTokenAmountGrouped(s, places);
        expectCut(cut, realOf(raw, decimals), fixedPlace(cut));
        const up = formatTokenAmountGroupedUp(s, places);
        expectUp(up, realOf(raw, decimals), fixedPlace(up));
      }
    }
  });

  it('the named cases', () => {
    expect(formatTokenAmountGrouped(1234.56789, 2)).toBe('1,234.56');
    expect(formatTokenAmountGroupedUp(1234.56189, 2)).toBe('1,234.57');
    expect(formatTokenAmountGrouped('35459581.82089999')).toBe('35,459,581.8208');
    expect(formatTokenAmountGrouped('999999.99999')).toBe('999,999.9999');
    expect(formatTokenAmountGroupedUp('999999.99991')).toBe('1,000,000.0000');
  });
});

describe('formatBalance: cut', () => {
  it('over exact decimal strings, never prints above the balance', () => {
    for (const { raw, decimals } of sweep(2500, 5)) {
      const s = formatUnits(raw, decimals);
      const text = formatBalance(s);
      if (text === '<0.0001') {
        expect(raw > 0n && cmp(realOf(raw, decimals), unit(4)) < 0, s).toBe(true);
        continue;
      }
      expectCut(text, realOf(raw, decimals), 4);
    }
  });

  it('the named cases', () => {
    expect(formatBalance('0.00019')).toBe('0.0001');
    expect(formatBalance('12345.67899')).toBe('12,345.6789');
    expect(formatBalance(0.29, 2)).toBe('0.29');
  });
});

describe('toFixedCut / toFixedUp: toFixed with the last digit cut or rounded up', () => {
  it('over exact decimal strings', () => {
    for (const { raw, decimals } of sweep(2500, 6)) {
      const s = formatUnits(raw, decimals);
      for (const places of [0, 2, 4, 6]) {
        expectCut(toFixedCut(s, places), realOf(raw, decimals), places);
        expectUp(toFixedUp(s, places), realOf(raw, decimals), places);
      }
    }
  });

  it('keeps toFixed shapes: padded, ungrouped, tiny values in plain digits', () => {
    expect(toFixedCut(0.29, 2)).toBe('0.29');
    expect(toFixedCut('1234.5678', 2)).toBe('1234.56');
    expect(toFixedUp('1234.5611', 2)).toBe('1234.57');
    expect(toFixedCut(0.00005, 4)).toBe('0.0000');
    expect(toFixedUp(0.00005, 4)).toBe('0.0001');
    expect(toFixedCut(2, 4)).toBe('2.0000');
    expect(toFixedCut(Number.NaN, 2)).toBe('NaN');
  });
});

describe('formatWholeNumberCut, localeCut, localeUp', () => {
  it('cut a whole number, and cut or round up at a locale print', () => {
    expect(formatWholeNumberCut(1234.9)).toBe('1,234');
    expect(formatWholeNumberCut(0.29)).toBe('0');
    expect(localeCut('1234.5678', 2)).toBe((1234.56).toLocaleString(undefined, { maximumFractionDigits: 2 }));
    expect(localeUp('1234.5611', 2)).toBe((1234.57).toLocaleString(undefined, { maximumFractionDigits: 2 }));
    expect(localeCut('391192.9999')).toBe((391192.999).toLocaleString());
    expect(localeUp('0.1231')).toBe((0.124).toLocaleString());
  });
});

describe('shortAmount (the basket): cut on the K/M/B scale', () => {
  it('never prints above the amount, within one unit of its last place', () => {
    for (const { raw, decimals } of sweep(2500, 7, 15)) {
      const s = formatUnits(raw, decimals);
      const n = Number(s);
      if (!(n > 0)) continue;
      const text = shortAmount(n);
      const whole = raw / 10n ** BigInt(decimals);
      const digits = whole.toString().length;
      const scale = whole >= 1000n ? 3 * Math.min(4, Math.floor((digits - 1) / 3)) : 0;
      const place = whole >= 1n ? 2 - scale : 6;
      expectCut(text, realOf(raw, decimals), place);
    }
  });

  it('the named cases', () => {
    expect(shortAmount(1_235_000)).toBe('1.23M');
    expect(shortAmount(999_999)).toBe('999.99K');
    expect(shortAmount(0.29)).toBe('0.29');
    expect(shortAmount(0.1234567)).toBe('0.123456');
  });
});

describe('formatSol: cut by default, { up: true } rounds up', () => {
  it('over lamport amounts', () => {
    for (const { raw } of sweep(2500, 8, 20)) {
      const real = realOf(raw, 9);
      const cut = formatSol(raw);
      if (cut.startsWith('<')) expect(raw > 0n && raw < 100_000n).toBe(true);
      else expectCut(cut, real, 4);
      // Under one unit of the last digit, rounded up says "<" that unit: true, and closer than the unit.
      const up = formatSol(raw, 4, { up: true });
      if (raw > 0n && raw < 100_000n) expect(up).toBe('<0.0001');
      else expectUp(up, real, 4);
      const up2 = formatSol(raw, 2, { up: true, fixed: true });
      if (raw > 0n && raw < 10_000_000n) expect(up2).toBe('<0.01');
      else expectUp(up2, real, 2);
    }
  });

  it('the named cases', () => {
    expect(formatSol(1_234_567_891n)).toBe('1.2345');
    expect(formatSol(1_234_567_891n, 4, { up: true })).toBe('1.2346');
    expect(formatSol(1_000_000_000n, 4, { up: true })).toBe('1');
    expect(formatSol(1n, 4, { up: true })).toBe('<0.0001');
    expect(formatSol(1n)).toBe('<0.0001');
    expect(formatSol(999_950_001n, 4, { up: true, fixed: true })).toBe('1.0000');
  });
});

describe('curve formatTokenAmount: cut by default, { up: true } rounds up', () => {
  it('over base-unit amounts at the mint decimals', () => {
    for (const { raw, decimals } of sweep(2500, 9, 24)) {
      const real = realOf(raw, decimals);
      for (const digits of [0, 2, 4, 6]) {
        const up = curveTokenAmount(raw, decimals, digits, { up: true }).text.replace(/,/g, '');
        if (digits >= decimals) expect(up).toBe(curveTokenAmount(raw, decimals, digits).text.replace(/,/g, ''));
        else if (raw > 0n && raw < 10n ** BigInt(decimals - digits)) expect(up).toBe(digits > 0 ? `<0.${'0'.repeat(digits - 1)}1` : '<1');
        else expectUp(up, real, digits);
      }
    }
  });

  it('the named cases', () => {
    expect(curveTokenAmount(1_234_567_891n, 6).text).toBe('1,234.5678');
    expect(curveTokenAmount(1_234_567_891n, 6, 4, { up: true }).text).toBe('1,234.5679');
    expect(curveTokenAmount(1n, 6, 4, { up: true }).text).toBe('<0.0001');
    expect(curveTokenAmount(1n, 6).text).toBe('<0.0001');
    expect(curveTokenAmount(999_999_999_901n, 6, 4, { up: true }).text).toBe('1,000,000');
    expect(curveTokenAmount(7n, null, 4, { up: true })).toEqual({ text: '7', isBaseUnits: true });
  });
});

/** The oracle: `formatTokenAmount`'s shape with `toFixed`'s rounding to the nearest, as a price or rate keeps. */
function nearestOracle(value: string | number, decimals = 4): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (!isFinite(num) || isNaN(num)) return String.fromCodePoint(0x2013);
  if (num === 0) return (0).toFixed(decimals);
  if (num > 0 && num < 0.000001) return num.toExponential(2);
  if (num > 0 && num < 0.0001) return num.toFixed(8);
  return num.toFixed(decimals);
}

describe('prices and rates keep their rounding to the nearest', () => {
  it('formatTokenAmountNearest prints as the oracle does, over strings and numbers', () => {
    for (const { raw, decimals } of sweep(3000, 10, 20)) {
      const text = formatUnits(raw, decimals);
      for (const d of [0, 1, 2, 4, 6]) {
        expect(formatTokenAmountNearest(text, d)).toBe(nearestOracle(text, d));
        expect(formatTokenAmountNearest(Number(text), d)).toBe(nearestOracle(Number(text), d));
      }
    }
    for (const odd of ['', 'abc', 'NaN', '-0.5', '1e-7', '0']) expect(formatTokenAmountNearest(odd, 2)).toBe(nearestOracle(odd, 2));
  });

  it('a price of 0.5 at no decimals is 1, never 0; 2.4 is 2', () => {
    expect(formatTokenAmountNearest('0.5', 0)).toBe('1');
    expect(formatTokenAmount('0.5', 0)).toBe('0');
    expect(formatTokenAmountNearest('2.4', 0)).toBe('2');
    expect(formatTokenAmountNearest('1234.56789', 2)).toBe('1234.57');
  });

  it('toFixedNearest is toFixed, and with `group` its whole part takes commas', () => {
    for (const v of [0, 0.29, 3.996, 2.554, 1284.5, 1_234_567.896, -1234.5, 999.995]) {
      expect(toFixedNearest(v, 2)).toBe(v.toFixed(2));
      expect(toFixedNearest(v, 2, true).replace(/,/g, '')).toBe(v.toFixed(2));
    }
    expect(toFixedNearest(1_234_567.896, 2, true)).toBe('1,234,567.90');
    expect(toFixedNearest('1284.5', 0, true)).toBe('1,285');
  });
});
