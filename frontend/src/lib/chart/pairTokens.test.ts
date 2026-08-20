import { describe, it, expect } from 'vitest';
import { TOWELI_ADDRESS, WETH_ADDRESS } from '../constants';
import { DEFAULT_TOKENS } from '../tokenList';
import { resolvePairTokens } from './pairTokens';

const UNKNOWN = '0x00000000000000000000000000000000deadbeef';
const USDC = DEFAULT_TOKENS.find((t) => t.symbol === 'USDC')!;

describe('resolvePairTokens — the refusal', () => {
  it('refuses a pair whose counter token this build cannot identify', () => {
    const result = resolvePairTokens(UNKNOWN, WETH_ADDRESS);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // The consequence has to be in the sentence: a wrong decimals guess is a
    // chart that is off by a power of ten and looks completely normal.
    expect(result.reason).toContain(UNKNOWN);
    expect(result.reason.toLowerCase()).toContain('power of ten');
  });

  it('names both legs when neither is known', () => {
    const result = resolvePairTokens(UNKNOWN, '0x000000000000000000000000000000000000c0de');
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain(UNKNOWN);
    expect(result.reason).toContain('0x000000000000000000000000000000000000c0de');
  });

  it('refuses a pair with no venue token on either leg — there is no side to price in', () => {
    const other = DEFAULT_TOKENS.find((t) => !t.isNative && t.symbol !== 'WETH' && t.symbol !== 'TOWELI')!;
    const second = DEFAULT_TOKENS.find(
      (t) => !t.isNative && t.symbol !== 'WETH' && t.symbol !== 'TOWELI' && t.symbol !== other.symbol,
    )!;
    const result = resolvePairTokens(other.address, second.address);
    expect(result.ok).toBe(false);
  });
});

describe('resolvePairTokens — orientation', () => {
  it('prices the counter token in WETH, whichever leg WETH landed on', () => {
    const asToken1 = resolvePairTokens(USDC.address, WETH_ADDRESS);
    if (!asToken1.ok) throw new Error('unreachable');
    expect(asToken1.quote.symbol).toBe('WETH');
    expect(asToken1.base.symbol).toBe('USDC');
    expect(asToken1.pricing.base).toBe('token0');

    const asToken0 = resolvePairTokens(WETH_ADDRESS, USDC.address);
    if (!asToken0.ok) throw new Error('unreachable');
    expect(asToken0.quote.symbol).toBe('WETH');
    expect(asToken0.base.symbol).toBe('USDC');
    expect(asToken0.pricing.base).toBe('token1');
  });

  it('reads a TOWELI/WETH pool the same way round whatever order the factory assigned', () => {
    // Both legs are venue tokens, so without a stated preference the pool would
    // be priced in TOWELI half the time and in WETH the other half — the same
    // pool charted as two different, mutually reciprocal markets.
    const a = resolvePairTokens(TOWELI_ADDRESS, WETH_ADDRESS);
    const b = resolvePairTokens(WETH_ADDRESS, TOWELI_ADDRESS);
    if (!a.ok || !b.ok) throw new Error('unreachable');
    expect(a.quote.symbol).toBe('WETH');
    expect(b.quote.symbol).toBe('WETH');
    expect(a.base.symbol).toBe('TOWELI');
    expect(b.base.symbol).toBe('TOWELI');
    expect(a.pricing.base).toBe('token0');
    expect(b.pricing.base).toBe('token1');
  });

  it('carries each leg its own decimals, keyed to token0/token1 and not to base/quote', () => {
    const result = resolvePairTokens(USDC.address, WETH_ADDRESS);
    if (!result.ok) throw new Error('unreachable');
    expect(result.pricing.token0Decimals).toBe(USDC.decimals);
    expect(result.pricing.token1Decimals).toBe(18);
    expect(USDC.decimals).not.toBe(18);
  });

  it('matches addresses case-insensitively — the indexer stores them lowercased', () => {
    const result = resolvePairTokens(TOWELI_ADDRESS.toLowerCase(), WETH_ADDRESS.toLowerCase());
    expect(result.ok).toBe(true);
  });
});
