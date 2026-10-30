// The pool's liquidity maths: math.ak's own Aiken test vectors (cardano/minswap-dex-v2
// lib/amm_dex_v2/math.ak, the same ones the batcher's port is held to), then what the screens
// build on them.
import { describe, expect, it } from 'vitest';
import {
  BURNED_LIQUIDITY,
  calculateDepositAmount,
  calculateInitialLiquidity,
  calculateSqrt,
  calculateWithdraw,
  div,
  entryIndex,
  feesSince,
  growthIndex,
  MAX_LP_SUPPLY,
  positionNow,
  quoteDeposit,
  quoteOpen,
  quoteWithdraw,
} from './lpMath';
import { ADA, type PoolState } from '../minswapV2';

const POOL: PoolState = {
  ref: { txHash: 'a3'.repeat(32), index: 0 },
  assetA: ADA,
  assetB: { policyId: '70'.repeat(28), assetName: '544f4b' },
  lp: { policyId: 'fb'.repeat(28), assetName: 'aa'.repeat(32) },
  reserveA: 100_000_000_000n,
  reserveB: 5_000_000_000_000n,
  totalLiquidity: 22_360_679_774n,
  feeANumerator: 30n,
  feeBNumerator: 30n,
  feeSharingNumerator: 1333n,
  allowDynamicFee: false,
};

describe('math.ak, its own test vectors', () => {
  it('floors like Plutus', () => {
    expect(div(7n, 2n)).toBe(3n);
    expect(div(-7n, 2n)).toBe(-4n);
    expect(div(7n, -2n)).toBe(-4n);
    expect(div(-7n, -2n)).toBe(3n);
  });

  it('test_calculate_sqrt', () => {
    for (const [a, b] of [[0n, 0n], [1n, 1n], [2n, 1n], [3n, 1n], [4n, 2n], [9n, 3n], [16n, 4n], [17n, 4n]] as const) expect(calculateSqrt(a)).toBe(b);
  });

  it('initial liquidity rounds the square root UP', () => {
    expect(calculateInitialLiquidity(1_000_000n, 1_000_000n)).toBe(1_000_000n);
    expect(calculateInitialLiquidity(1_000n, 1_000_000n)).toBe(31_623n);
  });

  it('test_calculate_deposit_amount', () => {
    expect(calculateDepositAmount(5000n, 2000n, 1_000_000n, 1_000_000n, 1_000_000n, 30n, 100n, 5000n)).toEqual([2n, 0n, 3496n]);
    expect(calculateDepositAmount(2000n, 5000n, 1_000_000n, 1_000_000n, 1_000_000n, 30n, 100n, 5000n)).toEqual([0n, 7n, 3491n]);
  });

  it('test_calculate_withdraw', () => {
    expect(calculateWithdraw(1_000_000n, 213_231_211n, 123_456n, 12_345_678n)).toEqual([9999n, 2132298n]);
  });
});

describe('what the screens quote', () => {
  it('a balanced deposit mints the pool’s own share of LP, its minimum less the slippage', () => {
    const q = quoteDeposit(POOL, 1_000_000_000n, 50_000_000_000n, 100);
    if ('refused' in q) throw new Error(q.refused);
    // 1% of the pool's A and B: 1% of its LP, to the unit.
    expect(q.expectedLp).toBe(223_606_797n);
    expect(q.minimumLp).toBe((223_606_797n * 9_900n) / 10_000n);
  });

  it('a withdrawal takes out the LP’s share of each side, never below 1 of either', () => {
    const q = quoteWithdraw(POOL, 223_606_797n, 50);
    if ('refused' in q) throw new Error(q.refused);
    expect(q.expectedA).toBe((223_606_797n * POOL.reserveA) / POOL.totalLiquidity);
    expect(q.minimumB).toBe((q.expectedB * 9_950n) / 10_000n);
    // One LP token of a pool whose A side is worth less than a unit per token takes out no A.
    expect('refused' in quoteWithdraw({ ...POOL, reserveA: 1_000n, totalLiquidity: 1_000_000_000n }, 1n, 50)).toBe(true);
    expect('refused' in quoteWithdraw(POOL, POOL.totalLiquidity + 1n, 50)).toBe(true);
  });

  it('opening mints the root of the product, 10 of it never anyone’s', () => {
    const q = quoteOpen(500_000_000n, 1_000_000_000n);
    if ('refused' in q) throw new Error(q.refused);
    expect(q.totalLiquidity).toBe(707_106_782n);
    expect(q.openerLp).toBe(707_106_782n - BURNED_LIQUIDITY);
    expect(q.poolLpRemaining + q.openerLp).toBe(MAX_LP_SUPPLY);
    expect('refused' in quoteOpen(10n, 10n)).toBe(true);
  });

  it('a position’s share and what it takes out now', () => {
    const p = positionNow(POOL, POOL.totalLiquidity / 100n);
    expect(p.sharePpm).toBe(9_999n);
    expect(p.a).toBe((POOL.totalLiquidity / 100n) * POOL.reserveA / POOL.totalLiquidity);
  });
});

describe('fees earned since a deposit', () => {
  it('a balanced deposit enters at the pool’s own index', () => {
    const lp = (POOL.totalLiquidity * 1_000_000_000n) / POOL.reserveA;
    const e = entryIndex(1_000_000_000n, 50_000_000_000n, lp);
    expect(Number(e - growthIndex(POOL))).toBeLessThan(Number(growthIndex(POOL) / 1_000_000n));
  });

  it('is zero until the pool’s fees grow it, then the grown part of what the position takes out', () => {
    const lp = 1_000_000_000n;
    const e = growthIndex(POOL);
    expect(feesSince(POOL, lp, e)).toEqual({ a: 0n, b: 0n });
    // A trade leaves 0.3% of its input in the pool: reserves grow, the LP supply does not.
    const grown = { ...POOL, reserveA: POOL.reserveA + 3_000_000_000n, reserveB: POOL.reserveB - 140_000_000_000n };
    const f = feesSince(grown, lp, e);
    expect(f.a).toBeGreaterThan(0n);
    expect(f.b).toBeGreaterThan(0n);
    const now = positionNow(grown, lp);
    expect(f.a).toBeLessThan(now.a / 100n);
  });
});
