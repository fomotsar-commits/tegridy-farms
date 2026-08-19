// Trigger math. Two properties carry the risk and are pinned hardest:
//
//   1. Rounding never costs the user. A floored strike fires late, never early; a
//      floored trail is wider, never tighter. Both are asserted against exact
//      integers rather than "close enough".
//   2. An input the surface would reject is an input this module rejects, with a
//      reason. Silent clamping would place an order the user did not describe —
//      the same class of failure as an unarmed stop presented as armed.

import { describe, it, expect } from 'vitest';
import {
  planTrigger,
  trailingStopPrice,
  stopLossDataFromLeg,
  DEFAULT_ORACLE_STALENESS_SECONDS,
  MAX_ORACLE_STALENESS_SECONDS,
  MAX_TRAIL_BPS,
  MAX_TRIGGER_SLIPPAGE_BPS,
  MIN_TRAIL_BPS,
  MIN_TRIGGER_SLIPPAGE_BPS,
  VALIDITY_BUCKET_SECONDS,
  TRIGGER_KINDS,
} from './triggerPlan';
import { TRIGGER_APP_DATA } from './stopLossHandler';

const WAD = 10n ** 18n;
const TOWELI = '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D' as const;
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const;
const USER = '0x1111111111111111111111111111111111111111' as const;
const FEED_A = '0x2222222222222222222222222222222222222222' as const;
const FEED_B = '0x3333333333333333333333333333333333333333' as const;

// 1000 TOWELI, stop at 0.5 WETH per TOWELI (unrealistic, but exact and readable).
const BASE = {
  sellAmount: 1000n * WAD,
  sellScale: WAD,
  buyScale: WAD,
  slippageBps: 100, // 1%
} as const;

describe('stop-loss legs', () => {
  it('derives strike, limit and minimum received exactly', () => {
    const plan = planTrigger({ kind: 'stop-loss', ...BASE, stopPrice: WAD / 2n });
    expect(plan.valid).toBe(true);
    expect(plan.legs).toHaveLength(1);
    const leg = plan.legs[0]!;
    expect(leg.direction).toBe('falls-to');
    // strike is the price rescaled to 18 decimals — a rescale, not a model.
    expect(leg.strike18).toBe(WAD / 2n);
    // 1% off the stop price.
    expect(leg.limitPrice).toBe((WAD / 2n * 9900n) / 10000n);
    // 1000 whole tokens at the limit price.
    expect(leg.buyAmount).toBe((1000n * leg.limitPrice));
    expect(plan.doubleFillRisk).toBe(false);
    expect(plan.stalenessSeconds).toBe(DEFAULT_ORACLE_STALENESS_SECONDS);
    expect(plan.validityBucketSeconds).toBe(VALIDITY_BUCKET_SECONDS);
  });

  it('floors the strike, so a stop fires late rather than early', () => {
    // buyScale of 3 makes the rescale inexact on purpose.
    const plan = planTrigger({
      kind: 'stop-loss',
      sellAmount: 1000n,
      sellScale: 1000n,
      buyScale: 3n,
      slippageBps: MIN_TRIGGER_SLIPPAGE_BPS,
      stopPrice: 10_000n,
    });
    expect(plan.valid).toBe(true);
    const strike = plan.legs[0]!.strike18;
    expect(strike).toBe((10_000n * WAD) / 3n);
    expect(strike * 3n).toBeLessThan(10_000n * WAD); // strictly below the true ratio
  });

  it('refuses a missing stop price rather than defaulting to one', () => {
    const plan = planTrigger({ kind: 'stop-loss', ...BASE });
    expect(plan.valid).toBe(false);
    expect(plan.error).toMatch(/stop price/i);
    expect(plan.legs).toEqual([]);
  });
});

describe('take-profit legs', () => {
  it('marks the direction as rising', () => {
    const plan = planTrigger({ kind: 'take-profit', ...BASE, targetPrice: 2n * WAD });
    expect(plan.valid).toBe(true);
    expect(plan.legs[0]!.direction).toBe('rises-to');
    expect(plan.legs[0]!.strike18).toBe(2n * WAD);
  });
});

describe('trailing stops', () => {
  it('hangs the stop below the reference by exactly the trail', () => {
    const plan = planTrigger({
      kind: 'trailing-stop',
      ...BASE,
      referencePrice: WAD,
      trailBps: 1000, // 10%
    });
    expect(plan.valid).toBe(true);
    expect(plan.legs[0]!.triggerPrice).toBe((WAD * 9000n) / 10000n);
    expect(plan.legs[0]!.direction).toBe('falls-to');
  });

  it('floors the derived stop, widening the trail rather than tightening it', () => {
    const stop = trailingStopPrice(7n, 5000)!;
    expect(stop).toBe(3n); // floor(7 * 0.5)
    expect(stop * 2n).toBeLessThanOrEqual(7n);
  });

  it('rejects trails outside the band, and reports the band', () => {
    for (const trailBps of [MIN_TRAIL_BPS - 1, MAX_TRAIL_BPS + 1, 10.5]) {
      const plan = planTrigger({ kind: 'trailing-stop', ...BASE, referencePrice: WAD, trailBps });
      expect(plan.valid).toBe(false);
      expect(plan.error).toMatch(/trail/i);
    }
    expect(trailingStopPrice(WAD, MAX_TRAIL_BPS + 1)).toBeNull();
    expect(trailingStopPrice(0n, 1000)).toBeNull();
  });

  it('agrees with the plan it is displayed beside', () => {
    const trailBps = 2500;
    const ref = 123_456_789n;
    const plan = planTrigger({ kind: 'trailing-stop', ...BASE, referencePrice: ref, trailBps });
    expect(plan.legs[0]!.triggerPrice).toBe(trailingStopPrice(ref, trailBps));
  });
});

describe('OCO', () => {
  it('produces both legs and flags that neither cancels the other', () => {
    const plan = planTrigger({
      kind: 'oco',
      ...BASE,
      stopPrice: WAD / 2n,
      targetPrice: 2n * WAD,
    });
    expect(plan.valid).toBe(true);
    expect(plan.legs.map((l) => l.direction)).toEqual(['falls-to', 'rises-to']);
    expect(plan.doubleFillRisk).toBe(true);
  });

  it('rejects a stop at or above the target', () => {
    for (const stopPrice of [2n * WAD, 3n * WAD]) {
      const plan = planTrigger({ kind: 'oco', ...BASE, stopPrice, targetPrice: 2n * WAD });
      expect(plan.valid).toBe(false);
      expect(plan.error).toMatch(/below the target/i);
    }
  });

  it('never reports double-fill risk for a single-leg kind', () => {
    for (const kind of TRIGGER_KINDS) {
      if (kind === 'oco') continue;
      const plan = planTrigger({
        kind,
        ...BASE,
        stopPrice: WAD / 2n,
        targetPrice: 2n * WAD,
        referencePrice: WAD,
        trailBps: 1000,
      });
      expect(plan.valid).toBe(true);
      expect(plan.doubleFillRisk).toBe(false);
    }
  });
});

describe('guard rails refuse rather than clamp', () => {
  it('rejects a zero or negative sell amount', () => {
    expect(planTrigger({ kind: 'stop-loss', ...BASE, sellAmount: 0n, stopPrice: WAD }).valid).toBe(false);
  });

  it('rejects slippage outside the band', () => {
    for (const slippageBps of [MIN_TRIGGER_SLIPPAGE_BPS - 1, MAX_TRIGGER_SLIPPAGE_BPS + 1, 50.5]) {
      const plan = planTrigger({ kind: 'stop-loss', ...BASE, slippageBps, stopPrice: WAD });
      expect(plan.valid).toBe(false);
      expect(plan.error).toMatch(/slippage/i);
    }
  });

  it('rejects a staleness bound outside the band — an unbounded stop is not a stop', () => {
    for (const stalenessSeconds of [0, MAX_ORACLE_STALENESS_SECONDS + 1]) {
      const plan = planTrigger({ kind: 'stop-loss', ...BASE, stalenessSeconds, stopPrice: WAD });
      expect(plan.valid).toBe(false);
      expect(plan.error).toMatch(/staleness/i);
    }
  });

  it('rejects an amount too small to buy anything at the limit', () => {
    const plan = planTrigger({
      kind: 'stop-loss',
      sellAmount: 1n,
      sellScale: WAD,
      buyScale: WAD,
      slippageBps: 100,
      stopPrice: 1n,
    });
    expect(plan.valid).toBe(false);
  });
});

describe('stopLossDataFromLeg', () => {
  it('carries the plan values into the struct without reinterpreting them', () => {
    const plan = planTrigger({
      kind: 'stop-loss',
      ...BASE,
      stopPrice: WAD / 2n,
      stalenessSeconds: 900,
    });
    const data = stopLossDataFromLeg(plan.legs[0]!, plan, {
      sellToken: TOWELI,
      buyToken: WETH,
      receiver: USER,
      sellTokenPriceOracle: FEED_A,
      buyTokenPriceOracle: FEED_B,
    });
    expect(data.sellAmount).toBe(plan.legs[0]!.sellAmount);
    expect(data.buyAmount).toBe(plan.legs[0]!.buyAmount);
    expect(data.strike).toBe(plan.legs[0]!.strike18);
    expect(data.maxTimeSinceLastOracleUpdate).toBe(900n);
    expect(data.validityBucketSeconds).toBe(VALIDITY_BUCKET_SECONDS);
    expect(data.appData).toBe(TRIGGER_APP_DATA);
  });

  it('is never partially fillable — a half-filled stop leaves the position exposed', () => {
    const plan = planTrigger({ kind: 'stop-loss', ...BASE, stopPrice: WAD / 2n });
    const data = stopLossDataFromLeg(plan.legs[0]!, plan, {
      sellToken: TOWELI,
      buyToken: WETH,
      receiver: USER,
      sellTokenPriceOracle: FEED_A,
      buyTokenPriceOracle: FEED_B,
    });
    expect(data.isPartiallyFillable).toBe(false);
    expect(data.isSellOrder).toBe(true);
  });
});
