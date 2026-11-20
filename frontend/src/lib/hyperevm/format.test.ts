import { describe, expect, it } from 'vitest';
import { amountText, bpsText, parseAmount } from './format';

describe('HyperEVM amounts', () => {
  it('cut down, never round up', () => {
    expect(amountText(1_999_999n, 6)).toBe('1.9999');
    expect(amountText(123_456_789_999n, 6)).toBe('123,456');
    expect(amountText(12_345_678_999n, 6)).toBe('12,345.6');
    expect(amountText(999n, 18)).toBe('0.000000000000000999');
    expect(amountText(1_234_567n, 18)).toBe('0.00000000000123456');
    expect(amountText(0n, 6)).toBe('0');
  });

  it('parse a typed amount exactly, and refuse what is not one', () => {
    expect(parseAmount('1.5', 6)).toBe(1_500_000n);
    expect(parseAmount('1,5', 6)).toBe(1_500_000n);
    expect(parseAmount('.25', 18)).toBe(25n * 10n ** 16n);
    expect(parseAmount('0', 6)).toBeNull();
    expect(parseAmount('1.0000001', 6)).toBeNull();
    expect(parseAmount('1e3', 6)).toBeNull();
    expect(parseAmount('', 6)).toBeNull();
  });

  it('basis points as a percent', () => {
    expect(bpsText(50)).toBe('0.5%');
    expect(bpsText(30n)).toBe('0.3%');
  });
});
