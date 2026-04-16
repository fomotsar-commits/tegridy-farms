import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  formatCurrency,
  formatNumber,
  formatTokenAmount,
  formatPercent,
  shortenAddress,
  formatTimeAgo,
  formatWholeNumber,
} from './formatting';

// ─── formatCurrency ──────────────────────────────────────────────

describe('formatCurrency', () => {
  it('returns dash for NaN', () => {
    expect(formatCurrency(NaN)).toBe('–');
  });

  it('returns dash for Infinity', () => {
    expect(formatCurrency(Infinity)).toBe('–');
    expect(formatCurrency(-Infinity)).toBe('–');
  });

  it('formats trillions', () => {
    expect(formatCurrency(2_500_000_000_000)).toBe('$2.50T');
    expect(formatCurrency(1_000_000_000_000)).toBe('$1.00T');
    expect(formatCurrency(1_500_000_000_000)).toBe('$1.50T');
  });

  it('formats billions', () => {
    expect(formatCurrency(3_200_000_000)).toBe('$3.20B');
    expect(formatCurrency(2_300_000_000)).toBe('$2.30B');
  });

  it('formats millions', () => {
    expect(formatCurrency(45_600_000)).toBe('$45.60M');
    expect(formatCurrency(4_200_000)).toBe('$4.20M');
  });

  it('formats thousands', () => {
    expect(formatCurrency(7_890)).toBe('$7.89K');
    expect(formatCurrency(1_000)).toBe('$1.00K');
    expect(formatCurrency(1_500)).toBe('$1.50K');
  });

  it('formats very small positive values with exponential', () => {
    expect(formatCurrency(0.0000001)).toBe('$1.00e-7');
  });

  it('formats small positive values < 0.01 with extra decimals', () => {
    expect(formatCurrency(0.005)).toBe('$0.00500000');
  });

  it('formats normal values', () => {
    expect(formatCurrency(42.567)).toBe('$42.57');
    expect(formatCurrency(999.99)).toBe('$999.99');
  });

  it('formats zero', () => {
    expect(formatCurrency(0)).toBe('$0.00');
  });

  it('formats negative values', () => {
    expect(formatCurrency(-10)).toBe('$-10.00');
  });

  it('respects custom decimals', () => {
    expect(formatCurrency(1_000_000, 0)).toBe('$1M');
    expect(formatCurrency(1_500_000, 1)).toBe('$1.5M');
    expect(formatCurrency(1_234_567, 3)).toBe('$1.235M');
  });
});

// ─── formatNumber ────────────────────────────────────────────────

describe('formatNumber', () => {
  it('returns dash for NaN', () => {
    expect(formatNumber(NaN)).toBe('–');
  });

  it('returns dash for Infinity', () => {
    expect(formatNumber(Infinity)).toBe('–');
    expect(formatNumber(-Infinity)).toBe('–');
  });

  it('formats trillions', () => {
    expect(formatNumber(1_000_000_000_000)).toBe('1.00T');
  });

  it('formats billions', () => {
    expect(formatNumber(5_000_000_000)).toBe('5.00B');
    expect(formatNumber(1_000_000_000)).toBe('1.00B');
  });

  it('formats millions', () => {
    expect(formatNumber(12_345_678)).toBe('12.35M');
    expect(formatNumber(1_000_000)).toBe('1.00M');
  });

  it('formats thousands with locale separators', () => {
    const result = formatNumber(9_876);
    expect(result).toBe('9,876');
  });

  it('formats sub-thousand values', () => {
    expect(formatNumber(42.567)).toBe('42.57');
    expect(formatNumber(0)).toBe('0.00');
  });

  it('respects custom decimals', () => {
    expect(formatNumber(1_000_000_000, 0)).toBe('1B');
    expect(formatNumber(1_234, 0)).toBe('1,234');
  });
});

// ─── formatTokenAmount ──────────────────────────────────────────

describe('formatTokenAmount', () => {
  it('handles string input', () => {
    expect(formatTokenAmount('123.456789')).toBe('123.4568');
    expect(formatTokenAmount('42.5')).toBe('42.5000');
  });

  it('handles number input', () => {
    expect(formatTokenAmount(123.456789)).toBe('123.4568');
    expect(formatTokenAmount(1.23456789)).toBe('1.2346');
  });

  it('returns dash for NaN string', () => {
    expect(formatTokenAmount('not_a_number')).toBe('–');
    expect(formatTokenAmount('abc')).toBe('–');
  });

  it('returns dash for NaN number', () => {
    expect(formatTokenAmount(NaN)).toBe('–');
  });

  it('returns dash for Infinity', () => {
    expect(formatTokenAmount(Infinity)).toBe('–');
  });

  it('formats zero with decimals', () => {
    expect(formatTokenAmount(0)).toBe('0.0000');
    expect(formatTokenAmount('0')).toBe('0.0000');
  });

  it('formats very tiny values with exponential', () => {
    expect(formatTokenAmount(0.0000001)).toBe('1.00e-7');
    expect(formatTokenAmount(0.0000001)).toMatch(/e/);
  });

  it('formats small values < 0.0001 with 8 decimals', () => {
    expect(formatTokenAmount(0.00005)).toBe('0.00005000');
  });

  it('handles negative numbers', () => {
    expect(formatTokenAmount(-5.123)).toBe('-5.1230');
  });

  it('respects custom decimals', () => {
    expect(formatTokenAmount(1.23456789, 2)).toBe('1.23');
    expect(formatTokenAmount(1.23456789, 6)).toBe('1.234568');
  });
});

// ─── formatPercent ──────────────────────────────────────────────

describe('formatPercent', () => {
  it('formats normal percentages with 2 decimals', () => {
    expect(formatPercent(12.345)).toBe('12.35%');
    expect(formatPercent(0)).toBe('0.00%');
    expect(formatPercent(99.99)).toBe('99.99%');
  });

  it('formats very large percentages using formatNumber', () => {
    expect(formatPercent(10000)).toBe('10,000%');
    expect(formatPercent(50000)).toBe('50,000%');
    expect(formatPercent(1_500_000)).toBe('2M%');
  });
});

// ─── shortenAddress ─────────────────────────────────────────────

describe('shortenAddress', () => {
  it('shortens a normal Ethereum address', () => {
    const addr = '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12';
    expect(shortenAddress(addr)).toBe('0xAbCd...Ef12');
  });

  it('shortens a standard 42-char address', () => {
    const addr = '0x1234567890abcdef1234567890abcdef12345678';
    expect(shortenAddress(addr)).toBe('0x1234...5678');
  });

  it('returns original if address is too short', () => {
    expect(shortenAddress('0x1234')).toBe('0x1234');
  });

  it('returns dash for null', () => {
    expect(shortenAddress(null)).toBe('–');
  });

  it('returns dash for undefined', () => {
    expect(shortenAddress(undefined)).toBe('–');
  });

  it('respects custom chars parameter', () => {
    const addr = '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12';
    expect(shortenAddress(addr, 6)).toBe('0xAbCdEf...CdEf12');
  });

  it('handles short string with custom chars that passes guard', () => {
    const addr = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    expect(shortenAddress(addr, 6)).toBe('0xabcdef...efabcd');
  });
});

// ─── formatTimeAgo ──────────────────────────────────────────────

describe('formatTimeAgo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setNow(unixSeconds: number) {
    vi.spyOn(Date, 'now').mockReturnValue(unixSeconds * 1000);
  }

  it('returns "just now" for < 5 seconds ago', () => {
    setNow(1000);
    expect(formatTimeAgo(997)).toBe('just now');
    expect(formatTimeAgo(996)).toBe('just now');
  });

  it('returns seconds ago', () => {
    setNow(1000);
    expect(formatTimeAgo(970)).toBe('30s ago');
    expect(formatTimeAgo(995)).toBe('5s ago');
  });

  it('returns minutes ago', () => {
    setNow(1000);
    expect(formatTimeAgo(820)).toBe('3m ago');
    expect(formatTimeAgo(880)).toBe('2m ago');
  });

  it('returns hours ago', () => {
    setNow(10000);
    expect(formatTimeAgo(10000 - 7200)).toBe('2h ago');
    expect(formatTimeAgo(10000 - 3600)).toBe('1h ago');
  });

  it('returns days ago', () => {
    setNow(100000);
    expect(formatTimeAgo(100000 - 172800)).toBe('2d ago');
    expect(formatTimeAgo(100000 - 86400)).toBe('1d ago');
  });
});

// ─── formatWholeNumber ──────────────────────────────────────────

describe('formatWholeNumber', () => {
  it('formats a large number with commas', () => {
    expect(formatWholeNumber(1234567)).toBe('1,234,567');
  });

  it('rounds to nearest integer', () => {
    expect(formatWholeNumber(1234.7)).toBe('1,235');
    expect(formatWholeNumber(1234.3)).toBe('1,234');
  });

  it('formats zero', () => {
    expect(formatWholeNumber(0)).toBe('0');
  });

  it('returns dash for NaN', () => {
    expect(formatWholeNumber(NaN)).toBe('–');
  });

  it('returns dash for Infinity', () => {
    expect(formatWholeNumber(Infinity)).toBe('–');
    expect(formatWholeNumber(-Infinity)).toBe('–');
  });

  it('formats negative numbers', () => {
    expect(formatWholeNumber(-5000)).toBe('-5,000');
  });
});
