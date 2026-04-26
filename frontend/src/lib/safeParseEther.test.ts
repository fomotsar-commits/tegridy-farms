import { describe, it, expect } from 'vitest';
import { parseEther } from 'viem';
import { safeParseEther, safeParseEtherPositive, validEtherInput } from './safeParseEther';

describe('safeParseEther', () => {
  // ─── happy path ─────────────────────────────────────────────────────
  it('parses whole numbers', () => {
    expect(safeParseEther('0')).toBe(parseEther('0'));
    expect(safeParseEther('1')).toBe(parseEther('1'));
    expect(safeParseEther('1234567')).toBe(parseEther('1234567'));
  });

  it('parses decimals up to 18 fraction digits', () => {
    expect(safeParseEther('1.5')).toBe(parseEther('1.5'));
    expect(safeParseEther('0.0001')).toBe(parseEther('0.0001'));
    expect(safeParseEther('123.123456789012345678')).toBe(
      parseEther('123.123456789012345678'),
    );
  });

  it('trims whitespace before parsing', () => {
    expect(safeParseEther('  10  ')).toBe(parseEther('10'));
  });

  // ─── rejection cases (would throw under raw parseEther) ─────────────
  it('returns null for empty / nullish inputs', () => {
    expect(safeParseEther('')).toBeNull();
    expect(safeParseEther(null)).toBeNull();
    expect(safeParseEther(undefined)).toBeNull();
    expect(safeParseEther('   ')).toBeNull();
  });

  it('returns null for trailing dot', () => {
    expect(safeParseEther('1.')).toBeNull();
    expect(safeParseEther('100.')).toBeNull();
  });

  it('returns null for leading dot', () => {
    expect(safeParseEther('.5')).toBeNull();
  });

  it('returns null for scientific notation', () => {
    expect(safeParseEther('1e3')).toBeNull();
    expect(safeParseEther('1E3')).toBeNull();
    expect(safeParseEther('2.5e2')).toBeNull();
  });

  it('returns null for >18 fraction digits', () => {
    // 19 decimals → reject
    expect(safeParseEther('1.1234567890123456789')).toBeNull();
  });

  it('returns null for negative / signed inputs', () => {
    expect(safeParseEther('-1')).toBeNull();
    expect(safeParseEther('+1')).toBeNull();
    expect(safeParseEther('-0.5')).toBeNull();
  });

  it('returns null for non-numeric content', () => {
    expect(safeParseEther('abc')).toBeNull();
    expect(safeParseEther('1abc')).toBeNull();
    expect(safeParseEther('1,000')).toBeNull(); // comma separator
    expect(safeParseEther('0x10')).toBeNull(); // hex
  });

  it('returns null for double dots', () => {
    expect(safeParseEther('1.2.3')).toBeNull();
  });
});

describe('safeParseEtherPositive', () => {
  it('rejects zero', () => {
    expect(safeParseEtherPositive('0')).toBeNull();
    expect(safeParseEtherPositive('0.0')).toBeNull();
    expect(safeParseEtherPositive('0.000000000000000000')).toBeNull();
  });

  it('passes positive values', () => {
    expect(safeParseEtherPositive('1')).toBe(parseEther('1'));
    expect(safeParseEtherPositive('0.5')).toBe(parseEther('0.5'));
  });

  it('rejects everything safeParseEther rejects', () => {
    expect(safeParseEtherPositive('1.')).toBeNull();
    expect(safeParseEtherPositive('-1')).toBeNull();
    expect(safeParseEtherPositive('1e3')).toBeNull();
  });
});

describe('validEtherInput', () => {
  it('accepts canonical decimal strings', () => {
    expect(validEtherInput.safeParse('100').success).toBe(true);
    expect(validEtherInput.safeParse('0.5').success).toBe(true);
    expect(validEtherInput.safeParse('123.123456789012345678').success).toBe(true);
  });

  it('rejects malformed strings with the same rules as safeParseEther', () => {
    expect(validEtherInput.safeParse('1.').success).toBe(false);
    expect(validEtherInput.safeParse('1e3').success).toBe(false);
    expect(validEtherInput.safeParse('-1').success).toBe(false);
    expect(validEtherInput.safeParse('abc').success).toBe(false);
    expect(validEtherInput.safeParse('1.1234567890123456789').success).toBe(false);
  });
});
