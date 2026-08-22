// Decimals, and the refusal to guess them.

import { describe, it, expect } from 'vitest';
import { QUOTE_TOKENS, findQuoteToken, formatQuoteAmount, parseQuoteAmount } from './quoteTokens';
import { TOWELI_ADDRESS, TOWELI_DECIMALS, WETH_ADDRESS } from '../constants';

const UNKNOWN = '0x9999999999999999999999999999999999999999';

describe('the token table', () => {
  it('holds lowercased addresses, because every comparison in the slice is lowercased', () => {
    for (const token of QUOTE_TOKENS) {
      expect(token.address).toBe(token.address.toLowerCase());
      expect(token.decimals).toBeGreaterThan(0);
    }
  });

  it('takes TOWELI’s decimals from constants rather than restating 18', () => {
    // A second literal is a second thing that can be wrong, and being wrong here
    // mis-sizes a trade by orders of magnitude.
    expect(findQuoteToken(TOWELI_ADDRESS)!.decimals).toBe(TOWELI_DECIMALS);
    expect(findQuoteToken(WETH_ADDRESS)!.symbol).toBe('WETH');
  });
});

describe('formatQuoteAmount', () => {
  it('formats without going through Number', () => {
    // 1234.5 WETH is past 2^53 in wei. The float path returns 1234.5000000000002.
    expect(formatQuoteAmount(1_234_500_000_000_000_000_000n, WETH_ADDRESS)).toBe('1234.5 WETH');
    expect(formatQuoteAmount(1n, WETH_ADDRESS)).toBe('0.000000000000000001 WETH');
    expect(formatQuoteAmount(0n, WETH_ADDRESS)).toBe('0 WETH');
  });

  it('shows raw units for a token it has no decimals for, rather than assuming 18', () => {
    const text = formatQuoteAmount(1_000_000n, UNKNOWN);
    expect(text).toContain('1000000');
    expect(text).toContain('smallest unit');
    expect(text).not.toContain('0.000001');
  });
});

describe('parseQuoteAmount', () => {
  it('reads a plain decimal into smallest units', () => {
    expect(parseQuoteAmount('0.05', WETH_ADDRESS)).toBe(50_000_000_000_000_000n);
    expect(parseQuoteAmount('2', WETH_ADDRESS)).toBe(2n * 10n ** 18n);
  });

  it('refuses more places than the token has, instead of rounding a cap the user did not type', () => {
    expect(parseQuoteAmount(`0.${'1'.repeat(19)}`, WETH_ADDRESS)).toBeNull();
  });

  it('refuses anything that is not a plain non-negative decimal', () => {
    for (const bad of ['', '  ', '-1', '1e18', '0x10', '1,5', 'abc', '.5', '1.']) {
      expect(parseQuoteAmount(bad, WETH_ADDRESS), `${bad} should be refused`).toBeNull();
    }
  });

  it('refuses a token it does not know the decimals of', () => {
    expect(parseQuoteAmount('1', UNKNOWN)).toBeNull();
  });
});
