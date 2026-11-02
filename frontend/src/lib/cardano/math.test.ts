import { describe, expect, it } from 'vitest';
import { calculateAmountOut, minimumReceive, priceImpactBps } from './math';
import { quoteSwap } from './quote';
import { ADA, lpAsset, type PoolState } from './minswapV2';
import { composeAddress } from './address';
import { ASCEND } from './testkit.fixture';

describe('calculateAmountOut', () => {
  it('is Minswap V2’s own: the vector from math.ak test_calculate_amount_out', () => {
    expect(calculateAmountOut(25434557769208n, 413300185707175n, 1000000000n, 30n)).toBe(16200168971n);
  });

  it('pays nothing on an empty pool, a zero amount or an impossible fee', () => {
    expect(calculateAmountOut(0n, 10n, 5n, 30n)).toBe(0n);
    expect(calculateAmountOut(10n, 10n, 0n, 30n)).toBe(0n);
    expect(calculateAmountOut(10n, 10n, 5n, 10_000n)).toBe(0n);
    expect(calculateAmountOut(10n, 10n, 5n, -1n)).toBe(0n);
  });
});

describe('minimumReceive', () => {
  it('takes the slippage off, rounding down', () => {
    expect(minimumReceive(1000n, 100)).toBe(990n);
    expect(minimumReceive(999n, 100)).toBe(989n);
    expect(minimumReceive(1n, 100)).toBe(0n);
  });

  it('refuses a slippage that is not a whole number of basis points under 100%', () => {
    expect(() => minimumReceive(1000n, -1)).toThrow();
    expect(() => minimumReceive(1000n, 10_000)).toThrow();
    expect(() => minimumReceive(1000n, 1.5)).toThrow();
  });
});

describe('priceImpactBps', () => {
  it('is near zero for a tiny trade and large for a big one', () => {
    const r = 1_000_000_000_000n;
    expect(priceImpactBps(r, r, 1_000_000n, calculateAmountOut(r, r, 1_000_000n, 30n), 30n)).toBeLessThanOrEqual(1);
    const big = 500_000_000n;
    expect(priceImpactBps(1_000_000_000n, 1_000_000_000n, big, calculateAmountOut(1_000_000_000n, 1_000_000_000n, big, 30n), 30n)).toBeGreaterThan(3000);
  });
});

describe('quoteSwap', () => {
  const pool: PoolState = {
    ref: { txHash: '11'.repeat(32), index: 0 },
    assetA: ADA,
    assetB: ASCEND,
    lp: lpAsset(ADA, ASCEND),
    reserveA: 1019463084218n,
    reserveB: 945869519487n,
    totalLiquidity: 807036682412n,
    feeANumerator: 100n,
    feeBNumerator: 100n,
    feeSharingNumerator: 1666n,
    allowDynamicFee: false,
  };
  const venue = composeAddress({ kind: 'key', hash: '9c'.repeat(28) }, null);

  it('quotes ADA in with the fee on the ADA paid', () => {
    const r = quoteSwap(pool, ADA, 400_000_000n, 100, 1_000_000n, { address: venue, bps: 50 });
    expect(r.kind).toBe('quote');
    if (r.kind !== 'quote') return;
    expect(r.quote.expectedOut).toBe(calculateAmountOut(pool.reserveA, pool.reserveB, 400_000_000n, 100n));
    expect(r.quote.minimumReceive).toBe((r.quote.expectedOut * 9900n) / 10000n);
    expect(r.quote.adaSide).toBe(400_000_000n);
    expect(r.quote.venueFee).toMatchObject({ kind: 'charged', lovelace: 2_000_000n });
  });

  it('quotes a token in with the fee on the ADA the pool quotes back', () => {
    const r = quoteSwap(pool, ASCEND, 400_000_000n, 100, 1_000_000n, { address: venue, bps: 50 });
    expect(r.kind).toBe('quote');
    if (r.kind !== 'quote') return;
    expect(r.quote.assetOut).toEqual(ADA);
    expect(r.quote.adaSide).toBe(r.quote.expectedOut);
  });

  it('charges no venue fee below the minimum output', () => {
    const r = quoteSwap(pool, ADA, 100_000_000n, 100, 1_000_000n, { address: venue, bps: 50 });
    expect(r.kind === 'quote' && r.quote.venueFee).toEqual({ kind: 'none', reason: 'below-minimum' });
  });

  it('refuses a pool whose batcher may add a fee per trade', () => {
    expect(quoteSwap({ ...pool, allowDynamicFee: true }, ADA, 1_000_000n, 100, 1_000_000n).kind).toBe('refused');
  });

  it('refuses a zero amount and a coin not in the pool', () => {
    expect(quoteSwap(pool, ADA, 0n, 100, 1_000_000n).kind).toBe('refused');
    expect(quoteSwap(pool, { policyId: 'ab'.repeat(28), assetName: '' }, 5n, 100, 1_000_000n).kind).toBe('refused');
  });
});
