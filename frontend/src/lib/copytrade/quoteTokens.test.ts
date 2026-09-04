// Decimals, and the refusal to guess them.

import { describe, it, expect } from 'vitest';
import {
  QUOTE_TOKENS,
  findQuoteToken,
  formatQuoteAmount,
  parseQuoteAmount,
  quoteTokensForFamily,
  truncateToDecimals,
} from './quoteTokens';
import { TOWELI_ADDRESS, TOWELI_DECIMALS, WETH_ADDRESS } from '../constants';
import { SOL_MINT } from '../solana';

const UNKNOWN = '0x9999999999999999999999999999999999999999';
const BASE_WETH = QUOTE_TOKENS.find((t) => t.network === 'base')!.address;

describe('the token table', () => {
  it('stores each address in the form its own chain compares in', () => {
    for (const token of QUOTE_TOKENS) {
      if (token.family === 'evm') expect(token.address).toBe(token.address.toLowerCase());
      // base58 is case-sensitive: lowercasing a mint produces a different,
      // valid-looking, wrong address.
      else expect(token.address).toBe(SOL_MINT);
      expect(token.decimals).toBeGreaterThan(0);
    }
  });

  it('takes TOWELI’s decimals from constants rather than restating 18', () => {
    // A second literal is a second thing that can be wrong, and being wrong here
    // mis-sizes a trade by orders of magnitude.
    expect(findQuoteToken(TOWELI_ADDRESS)!.decimals).toBe(TOWELI_DECIMALS);
    expect(findQuoteToken(WETH_ADDRESS)!.symbol).toBe('WETH');
  });

  it('holds Ethereum WETH and Base WETH as two different entries', () => {
    // One symbol, two contracts. A table keyed on the symbol would let a cap
    // entered for one chain size a trade on the other.
    const weths = QUOTE_TOKENS.filter((t) => t.symbol === 'WETH');
    expect(weths).toHaveLength(2);
    expect(new Set(weths.map((t) => t.address)).size).toBe(2);
    expect(new Set(weths.map((t) => t.label)).size).toBe(2);
    expect(findQuoteToken(BASE_WETH)!.network).toBe('base');
    expect(findQuoteToken(WETH_ADDRESS)!.network).toBe('eth');
  });

  it('splits the table by venue family so a form cannot offer SOL for an EVM follow', () => {
    const evm = quoteTokensForFamily('evm');
    const solana = quoteTokensForFamily('solana');
    expect(evm.every((t) => t.family === 'evm')).toBe(true);
    expect(solana.map((t) => t.address)).toEqual([SOL_MINT]);
    expect(evm.length + solana.length).toBe(QUOTE_TOKENS.length);
  });

  it('finds the SOL mint by its exact base58, and not by a lowercased copy', () => {
    expect(findQuoteToken(SOL_MINT)!.decimals).toBe(9);
    expect(findQuoteToken(SOL_MINT.toLowerCase())).toBeNull();
  });
});

describe('formatQuoteAmount', () => {
  it('formats without going through Number', () => {
    // 1234.5 WETH is past 2^53 in wei. The float path returns 1234.5000000000002.
    expect(formatQuoteAmount(1_234_500_000_000_000_000_000n, WETH_ADDRESS)).toBe('1234.5 WETH (Ethereum)');
    expect(formatQuoteAmount(1n, WETH_ADDRESS)).toBe('0.000000000000000001 WETH (Ethereum)');
    expect(formatQuoteAmount(0n, WETH_ADDRESS)).toBe('0 WETH (Ethereum)');
  });

  it('names the chain, so two WETH amounts never read as the same asset', () => {
    expect(formatQuoteAmount(1n, BASE_WETH)).toBe('0.000000000000000001 WETH (Base)');
    expect(formatQuoteAmount(1n, BASE_WETH)).not.toBe(formatQuoteAmount(1n, WETH_ADDRESS));
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
    expect(parseQuoteAmount('0.5', SOL_MINT)).toBe(500_000_000n);
  });

  it('refuses more places than the token has, instead of rounding a cap the user did not type', () => {
    expect(parseQuoteAmount(`0.${'1'.repeat(19)}`, WETH_ADDRESS)).toBeNull();
    expect(parseQuoteAmount('0.0000000001', SOL_MINT)).toBeNull();
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

describe('truncateToDecimals', () => {
  it('drops excess digits and never rounds up', () => {
    // The sized mirror must never exceed the leg it was derived from.
    expect(truncateToDecimals('0.123456789012345678901', 18)).toBe('0.123456789012345678');
    expect(truncateToDecimals('0.999999999999999999999', 18)).toBe('0.999999999999999999');
    expect(truncateToDecimals('1.5', 0)).toBe('1');
    expect(truncateToDecimals('1.5', 18)).toBe('1.5');
    expect(truncateToDecimals('2', 18)).toBe('2');
  });

  it('lets an upstream leg through parseQuoteAmount that raw input would fail', () => {
    const upstream = '0.500000000000000000123';
    expect(parseQuoteAmount(upstream, WETH_ADDRESS)).toBeNull();
    expect(parseQuoteAmount(truncateToDecimals(upstream, 18), WETH_ADDRESS)).toBe(
      500_000_000_000_000_000n,
    );
  });

  it('leaves a value it does not understand alone rather than inventing one', () => {
    expect(truncateToDecimals('not a number', 18)).toBe('not a number');
    expect(parseQuoteAmount(truncateToDecimals('not a number', 18), WETH_ADDRESS)).toBeNull();
  });
});
