import { describe, it, expect } from 'vitest';
import { PIPE_IN, manifoldShape, manifoldWidths } from './manifold';

// Rates are in hundredths of a bip (1_000_000 = 100%): 10_000 is a 1% trade fee, 160_000 a 16% share of it.
const tier = (tradeFeeRate: bigint, protocolFeeRate: bigint, fundFeeRate = 0n) => ({ tradeFeeRate, protocolFeeRate, fundFeeRate });

describe('the manifold: each pipe as wide as its share of the fee', () => {
  it('draws nothing for a tier that was not read', () => {
    expect(manifoldWidths(null)).toBeNull();
  });

  it('draws nothing when the tier charges no fee to split', () => {
    expect(manifoldWidths(tier(0n, 160_000n))).toBeNull();
  });

  it('splits the pipe in as the tier splits the fee: 0.84% to the pool and 0.16% to the venue of a 1% fee', () => {
    const w = manifoldWidths(tier(10_000n, 120_000n, 40_000n))!;
    expect(w.in).toBe(PIPE_IN);
    expect(w.pool).toBeCloseTo(PIPE_IN * 0.84, 10);
    expect(w.venue).toBeCloseTo(PIPE_IN * 0.16, 10);
    expect(w.pool + w.venue).toBeCloseTo(w.in, 10);
  });

  it('follows the read, whatever the tier: a quarter to the venue of a 0.25% fee', () => {
    const w = manifoldWidths(tier(2_500n, 250_000n), 40)!;
    expect(w.pool / w.in).toBeCloseTo(0.75, 10);
    expect(w.venue / w.in).toBeCloseTo(0.25, 10);
  });

  it('lays no pipe for a share of nothing', () => {
    const w = manifoldWidths(tier(10_000n, 0n))!;
    expect(w.venue).toBe(0);
    const shape = manifoldShape(w);
    expect(shape.venue).toBeNull();
    expect(shape.pool).toMatch(/^M[\d.]+ [\d.]+ C /);
  });
});
