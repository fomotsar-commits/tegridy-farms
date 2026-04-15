import { describe, it, expect } from 'vitest';
import {
  formatCurrency,
  formatNumber,
  formatTokenAmount,
  formatPercent,
  shortenAddress,
  formatTimeAgo,
} from './formatting';

describe('formatTokenAmount', () => {
  it('returns fixed decimals for zero', () => {
    expect(formatTokenAmount(0)).toBe('0.0000');
  });

  it('returns fixed decimals for normal numbers', () => {
    expect(formatTokenAmount(1.23456789)).toBe('1.2346');
  });

  it('handles string input', () => {
    expect(formatTokenAmount('42.5')).toBe('42.5000');
  });

  it('uses scientific notation for very small numbers', () => {
    expect(formatTokenAmount(0.0000001)).toMatch(/e/);
  });

  it('uses 8 decimal places for small but not tiny numbers', () => {
    expect(formatTokenAmount(0.00005)).toBe('0.00005000');
  });

  it('returns dash for NaN', () => {
    expect(formatTokenAmount(NaN)).toBe('–');
  });

  it('returns dash for Infinity', () => {
    expect(formatTokenAmount(Infinity)).toBe('–');
  });

  it('returns dash for non-numeric string', () => {
    expect(formatTokenAmount('abc')).toBe('–');
  });

  it('respects custom decimals parameter', () => {
    expect(formatTokenAmount(1.23456, 2)).toBe('1.23');
  });

  it('handles negative numbers', () => {
    // Negative numbers fall through to toFixed
    expect(formatTokenAmount(-5.123)).toBe('-5.1230');
  });
});

describe('shortenAddress', () => {
  it('shortens a standard 42-char Ethereum address', () => {
    const addr = '0x1234567890abcdef1234567890abcdef12345678';
    expect(shortenAddress(addr)).toBe('0x1234...5678');
  });

  it('uses custom char count', () => {
    const addr = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    expect(shortenAddress(addr, 6)).toBe('0xabcdef...efabcd');
  });

  it('works with short strings (no guard)', () => {
    // The function does not guard against short strings, just slices
    expect(shortenAddress('0x1234', 2)).toBe('0x12...34');
  });
});

describe('formatCurrency', () => {
  it('formats trillions', () => {
    expect(formatCurrency(1_500_000_000_000)).toBe('$1.50T');
  });

  it('formats billions', () => {
    expect(formatCurrency(2_300_000_000)).toBe('$2.30B');
  });

  it('formats millions', () => {
    expect(formatCurrency(4_200_000)).toBe('$4.20M');
  });

  it('formats thousands', () => {
    expect(formatCurrency(1_500)).toBe('$1.50K');
  });

  it('formats small values with extra precision', () => {
    expect(formatCurrency(0.005)).toBe('$0.00500000');
  });

  it('uses scientific notation for dust amounts', () => {
    expect(formatCurrency(0.0000001)).toMatch(/\$.*e/);
  });

  it('returns dash for NaN', () => {
    expect(formatCurrency(NaN)).toBe('–');
  });

  it('returns dash for Infinity', () => {
    expect(formatCurrency(Infinity)).toBe('–');
  });

  it('formats zero', () => {
    expect(formatCurrency(0)).toBe('$0.00');
  });

  it('respects custom decimals', () => {
    expect(formatCurrency(1_000_000, 0)).toBe('$1M');
  });
});

describe('formatNumber', () => {
  it('formats trillions without dollar sign', () => {
    expect(formatNumber(1_000_000_000_000)).toBe('1.00T');
  });

  it('formats billions', () => {
    expect(formatNumber(1_000_000_000)).toBe('1.00B');
  });

  it('formats millions', () => {
    expect(formatNumber(1_000_000)).toBe('1.00M');
  });

  it('returns dash for NaN', () => {
    expect(formatNumber(NaN)).toBe('–');
  });

  it('formats small numbers with toFixed', () => {
    expect(formatNumber(42.567)).toBe('42.57');
  });
});

describe('formatPercent', () => {
  it('formats normal percentages', () => {
    expect(formatPercent(12.345)).toBe('12.35%');
  });

  it('uses compact format for huge percentages', () => {
    expect(formatPercent(50000)).toBe('50,000%');
  });
});

describe('formatTimeAgo', () => {
  it('formats seconds ago', () => {
    const ts = Date.now() / 1000 - 30;
    expect(formatTimeAgo(ts)).toBe('30s ago');
  });

  it('formats minutes ago', () => {
    const ts = Date.now() / 1000 - 120;
    expect(formatTimeAgo(ts)).toBe('2m ago');
  });

  it('formats hours ago', () => {
    const ts = Date.now() / 1000 - 7200;
    expect(formatTimeAgo(ts)).toBe('2h ago');
  });

  it('formats days ago', () => {
    const ts = Date.now() / 1000 - 172800;
    expect(formatTimeAgo(ts)).toBe('2d ago');
  });
});
