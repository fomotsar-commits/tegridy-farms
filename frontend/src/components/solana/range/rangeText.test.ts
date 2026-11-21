// @vitest-environment node
// The range cards' amounts: what you put in is rounded up at the sixth decimal, what a
// position holds or a cut-off figure says is cut. SOL is always to the lamport.
import { describe, expect, it } from 'vitest';
import { SOL_QUOTE, USDC_QUOTE } from '../../../lib/solana/lp/quotes';
import { bothAmounts, coinAmount, tokenAmount, type NamedPair } from './rangeText';

const pair = (over: Partial<NamedPair> = {}): NamedPair => ({
  quote: SOL_QUOTE, tokenMint: 'Tok1111111111111111111111111111111111111111', tokenIsToken0: true,
  tokenDecimals: 9, quoteDecimals: 9, tickSpacing: 10, tokenLabel: null, ...over,
});

describe('rangeText amounts', () => {
  it('a 9-decimal token at six places: 1.234567891 is 1.234567 cut and 1.234568 rounded up', () => {
    expect(tokenAmount(pair(), 1_234_567_891n)).toBe('1.234567 tokens');
    expect(tokenAmount(pair(), 1_234_567_891n, true)).toBe('1.234568 tokens');
    expect(tokenAmount(pair(), 1_234_567_000n, true)).toBe('1.234567 tokens');
  });

  it('both amounts take the same direction: the token rounds up, SOL stays to the lamport', () => {
    expect(bothAmounts(pair(), 1_234_567_891n, 2_000_000_001n)).toBe('1.234567 tokens and 2.000000001 SOL');
    expect(bothAmounts(pair(), 1_234_567_891n, 2_000_000_001n, true)).toBe('1.234568 tokens and 2.000000001 SOL');
    // The token is token 1 here: the order follows the pair, not the arguments.
    expect(bothAmounts(pair({ tokenIsToken0: false }), 2_000_000_001n, 1_234_567_891n, true)).toBe('1.234568 tokens and 2.000000001 SOL');
  });

  it('a six-decimal pairing coin is exact either way', () => {
    const usdc = pair({ quote: USDC_QUOTE, quoteDecimals: 6 });
    expect(coinAmount(usdc, 250_123_456n)).toBe('250.123456 USDC');
    expect(coinAmount(usdc, 250_123_456n, true)).toBe('250.123456 USDC');
  });

  it('a pairing coin kept to more decimals than shown: what you put in rounds up, what is held is cut', () => {
    // No listed pairing coin has more than six decimals, so this one is made up: the one shape where up and cut differ.
    const nine = pair({ quote: { ...USDC_QUOTE, decimals: 9 }, quoteDecimals: 9 });
    expect(coinAmount(nine, 250_123_456_001n)).toBe('250.123456 USDC');
    expect(coinAmount(nine, 250_123_456_001n, true)).toBe('250.123457 USDC');
    expect(bothAmounts(nine, 1_234_567_891n, 250_123_456_001n, true)).toBe('1.234568 tokens and 250.123457 USDC');
  });
});
