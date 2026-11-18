// fmtWeth and fmtWethUp: the lending tab's two WETH writers. What the viewer receives, is owed
// or holds is cut at the digits shown; what they pay, owe or put up is rounded up. Both work on
// the exact wei, always print exactly `digits` decimals and never group.
import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { fmtWeth, fmtWethUp } from './nftLendingShared';

const wei = (s: string) => parseEther(s);

describe('fmtWeth cuts, fmtWethUp rounds up, at the digits shown', () => {
  it('0.100049 at 4: cut 0.1000, up 0.1001 (the nearest is 0.1000)', () => {
    expect(fmtWeth(wei('0.100049'))).toBe('0.1000');
    expect(fmtWethUp(wei('0.100049'))).toBe('0.1001');
  });

  it('0.10005 at 4: cut 0.1000, up 0.1001 (the nearest is 0.1001)', () => {
    expect(fmtWeth(wei('0.10005'))).toBe('0.1000');
    expect(fmtWethUp(wei('0.10005'))).toBe('0.1001');
  });

  it('0.10007 at 4 cuts to 0.1000, where the float rounded it to 0.1001', () => {
    expect(fmtWeth(wei('0.10007'))).toBe('0.1000');
    expect(fmtWethUp(wei('0.10007'))).toBe('0.1001');
  });

  it('one wei above a boundary: the cut stays on it, the round-up moves past it', () => {
    const above = wei('0.1') + 1n;
    expect(fmtWeth(above)).toBe('0.1000');
    expect(fmtWethUp(above)).toBe('0.1001');
    expect(fmtWethUp(above, 6)).toBe('0.100001');
    expect(fmtWethUp(1n)).toBe('0.0001');
    expect(fmtWeth(1n)).toBe('0.0000');
  });

  it('exact values and zero print unchanged either way', () => {
    for (const [v, s] of [['0.1', '0.1000'], ['1', '1.0000'], ['2.5', '2.5000'], ['0', '0.0000']] as const) {
      expect(fmtWeth(wei(v))).toBe(s);
      expect(fmtWethUp(wei(v))).toBe(s);
    }
    expect(fmtWethUp(0n, 6)).toBe('0.000000');
  });

  it('works on the wei, not a float: digits past what a double holds still count', () => {
    // 1.008219178082191781 WETH, a 30-day loan's cost: the float reads 1.008219 at 6.
    const cost = 1_008_219_178_082_191_781n;
    expect(fmtWeth(cost, 6)).toBe('1.008219');
    expect(fmtWethUp(cost, 6)).toBe('1.008220');
    expect(fmtWeth(wei('123456789.123456789'))).toBe('123456789.1234');
    expect(fmtWethUp(wei('123456789.123456789'), 2)).toBe('123456789.13');
  });

  it('keeps the shape: exactly `digits` decimals and no grouping', () => {
    expect(fmtWeth(wei('1234567.5'), 2)).toBe('1234567.50');
    expect(fmtWethUp(wei('1234567.001'), 2)).toBe('1234567.01');
    expect(fmtWeth(wei('0.106'), 2)).toBe('0.10');
    expect(fmtWethUp(wei('0.106'), 2)).toBe('0.11');
  });

  it('over a seeded sweep of raw amounts: the cut is never above, the round-up never below, each within one last digit', () => {
    let seed = 0x2545f491n;
    const next = () => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return seed;
    };
    for (let k = 0; k < 4000; k++) {
      const amount = next() % 10n ** BigInt(Number(next() % 24n) + 1);
      for (const digits of [2, 4, 6]) {
        const step = 10n ** BigInt(18 - digits);
        const down = parseEther(fmtWeth(amount, digits));
        const up = parseEther(fmtWethUp(amount, digits));
        expect(down <= amount && amount - down < step).toBe(true);
        expect(up >= amount && up - amount < step).toBe(true);
        expect(fmtWeth(amount, digits)).toMatch(new RegExp(`^\\d+\\.\\d{${digits}}$`));
      }
    }
  });
});
