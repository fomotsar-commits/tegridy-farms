import { describe, it, expect } from 'vitest';
import BN from 'bn.js';
import { calculateStakeWeight, calculateRewardRateFromAmount } from '@streamflow/staking';

import {
  stakeWeightScaled,
  stakeWeight,
  isFlatWeight,
  rewardRatePerPeriod,
  configuredAnnualRate,
  rateIsPercent,
  vaultRunwaySecs,
  unlockTs,
  lockPresets,
  defaultLockDays,
  labelForDays,
  WEIGHT_SCALE,
  SECONDS_PER_YEAR,
  type PoolView,
  type RewardPoolView,
} from './bungalowStaking';

/**
 * The lighthouse panel prints a RATE before anyone signs anything, and a rate
 * that drifts from the program's is the exact failure this repo's staking-look
 * doc exists to prevent. bungalowStaking.ts carries two display-math helpers
 * (weight, reward rate) so the UI can answer "what does a 30-day lock earn?"
 * synchronously; this file pins BOTH against the Streamflow SDK's own
 * implementations — the real ones, not a mock — so a version bump that changes
 * their math fails here instead of quietly mispricing a button.
 */

const DAY = 86_400;

/** The live BAYLA lighthouse, read off mainnet 2026-08-28. */
const BAYLA_POOL: PoolView = {
  address: '4WCpdeQ2pKLNECNDTXepwsdeePZPoNCp9AQqfACNGXPp',
  mint: '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump',
  decimals: 6,
  tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  minDurationSecs: DAY,
  maxDurationSecs: 365 * DAY,
  minWeightScaled: WEIGHT_SCALE,
  maxWeightScaled: WEIGHT_SCALE,
  unstakePeriodSecs: 0,
  totalStakeRaw: 0n,
  totalEffectiveStakeRaw: 0n,
  rewardPools: [],
};

const BAYLA_REWARD: RewardPoolView = {
  address: 'HdapJt3cJ92fBcoCiaeAyACicXGF9m6RGQdWRMX9L9XL',
  mint: BAYLA_POOL.mint,
  nonce: 0,
  vault: 'G4WFqZcqtbU6bSEcBEUy884A1K9DSP8YfewfZ9B7uUcV',
  decimals: 6,
  fundedRaw: 0n,
  permissionless: true,
  rewardAmountRaw: '3000000',
  rewardPeriodSecs: DAY,
};

describe('stakeWeightScaled matches the SDK exactly', () => {
  const grids: { min: number; max: number; maxWeight: bigint }[] = [
    // The live BAYLA shape: flat weight, so every lock is 1.00x.
    { min: DAY, max: 365 * DAY, maxWeight: WEIGHT_SCALE },
    // A pool that DOES reward duration (2x at the cap) and one with a fatter cap.
    { min: DAY, max: 365 * DAY, maxWeight: 2n * WEIGHT_SCALE },
    { min: 7 * DAY, max: 730 * DAY, maxWeight: 4n * WEIGHT_SCALE },
    // Degenerate: a single legal duration (span 0) — the SDK short-circuits to 1x.
    { min: 30 * DAY, max: 30 * DAY, maxWeight: 3n * WEIGHT_SCALE },
  ];

  for (const g of grids) {
    it(`min=${g.min} max=${g.max} maxWeight=${g.maxWeight}`, () => {
      const durations = [
        g.min, g.min + 1, DAY, 7 * DAY, 30 * DAY, 90 * DAY, 180 * DAY, 365 * DAY, g.max,
        // Below the minimum is not a legal stake, but the helper must still
        // clamp the same way the program does rather than go negative.
        Math.max(0, g.min - DAY),
      ];
      for (const d of durations) {
        const sdk = calculateStakeWeight(
          new BN(g.min),
          new BN(g.max),
          new BN(g.maxWeight.toString()),
          new BN(d),
        );
        const ours = stakeWeightScaled(
          { minDurationSecs: g.min, maxDurationSecs: g.max, maxWeightScaled: g.maxWeight },
          d,
        );
        expect(ours.toString(), `duration ${d}`).toBe(sdk.toString());
      }
    });
  }
});

describe('rewardRatePerPeriod matches the SDK exactly', () => {
  const cases = [
    { amount: '3000000', stakeDecimals: 6, rewardDecimals: 6 }, // BAYLA, live
    { amount: '1000000000', stakeDecimals: 6, rewardDecimals: 6 },
    { amount: '3000000', stakeDecimals: 9, rewardDecimals: 6 },
    { amount: '3000000', stakeDecimals: 6, rewardDecimals: 9 },
    { amount: '0', stakeDecimals: 6, rewardDecimals: 6 },
  ];
  for (const c of cases) {
    it(`amount=${c.amount} stake=${c.stakeDecimals}dp reward=${c.rewardDecimals}dp`, () => {
      const sdk = calculateRewardRateFromAmount(new BN(c.amount), c.stakeDecimals, c.rewardDecimals);
      const ours = rewardRatePerPeriod(
        { decimals: c.stakeDecimals },
        { decimals: c.rewardDecimals, rewardAmountRaw: c.amount },
      );
      expect(ours).toBeCloseTo(Number(sdk), 12);
    });
  }
});

describe('the live BAYLA pool, priced', () => {
  it('is 0.003 BAYLA per BAYLA per day = 109.5% a year', () => {
    expect(rewardRatePerPeriod(BAYLA_POOL, BAYLA_REWARD)).toBeCloseTo(0.003, 12);
    expect(configuredAnnualRate(BAYLA_POOL, BAYLA_REWARD, 30 * DAY)).toBeCloseTo(1.095, 9);
  });

  it('pays the SAME rate at every lock length — the pool has no duration bonus', () => {
    // minWeight == maxWeight on the live pool. A UI that implied "lock longer,
    // earn more" here would be inventing a boost curve the program does not have.
    expect(isFlatWeight(BAYLA_POOL)).toBe(true);
    const rates = [1, 7, 30, 90, 180, 365].map((d) => configuredAnnualRate(BAYLA_POOL, BAYLA_REWARD, d * DAY));
    expect(new Set(rates.map((r) => r.toFixed(9))).size).toBe(1);
    expect(stakeWeight(BAYLA_POOL, 365 * DAY)).toBe(1);
  });

  it('is quotable as a percentage only because the reward mint IS the stake mint', () => {
    expect(rateIsPercent(BAYLA_POOL, BAYLA_REWARD)).toBe(true);
    expect(rateIsPercent(BAYLA_POOL, { mint: 'SomeOtherMint111111111111111111111111111111' })).toBe(false);
    // An unset reward mint is not "the same token", it is unknown.
    expect(rateIsPercent(BAYLA_POOL, { mint: '' })).toBe(false);
  });

  it('rewards MORE for a longer lock once a pool actually weights duration', () => {
    const weighted = { ...BAYLA_POOL, maxWeightScaled: 2n * WEIGHT_SCALE };
    expect(isFlatWeight(weighted)).toBe(false);
    const short = configuredAnnualRate(weighted, BAYLA_REWARD, DAY);
    const long = configuredAnnualRate(weighted, BAYLA_REWARD, 365 * DAY);
    expect(short).toBeCloseTo(1.095, 9);
    expect(long).toBeCloseTo(2.19, 9);
  });
});

describe('vaultRunwaySecs', () => {
  const staked = { ...BAYLA_POOL, totalStakeRaw: 1_000_000_000n, totalEffectiveStakeRaw: 1_000_000_000n }; // 1,000 BAYLA
  it('answers in real time at TODAY\'s stake and rate', () => {
    // 1,000 staked x 0.003/day = 3 BAYLA a day; a 30 BAYLA vault lasts 10 days.
    const rp = { ...BAYLA_REWARD, fundedRaw: 30_000_000n };
    expect(vaultRunwaySecs(staked, rp)).toBe(10 * DAY);
  });
  it('refuses to answer rather than guess', () => {
    // Empty vault, unreadable vault, and nothing staked are three different
    // unknowables — none of them is a runway number.
    expect(vaultRunwaySecs(staked, { ...BAYLA_REWARD, fundedRaw: 0n })).toBe(null);
    expect(vaultRunwaySecs(staked, { ...BAYLA_REWARD, fundedRaw: null })).toBe(null);
    expect(vaultRunwaySecs(BAYLA_POOL, { ...BAYLA_REWARD, fundedRaw: 30_000_000n })).toBe(null);
    expect(vaultRunwaySecs(staked, { ...BAYLA_REWARD, fundedRaw: 30_000_000n, rewardAmountRaw: '0' })).toBe(null);
  });
});

describe('defaultLockDays', () => {
  // Safety invariant, not a preference: this program has no early exit at any
  // price, so whatever the picker pre-selects is what an inattentive staker is
  // held to with no recourse. If this test ever fails because someone wanted a
  // "better" default, the default is wrong — not the test.
  it('pre-selects the SHORTEST lock the pool allows, never a mid-range one', () => {
    const presets = lockPresets(BAYLA_POOL);
    expect(presets.map((p) => p.days)).toContain(30);
    expect(defaultLockDays(presets, 1)).toBe(1);
  });

  it('honours a pool whose own minimum is longer than a day', () => {
    const weekMin = { ...BAYLA_POOL, minDurationSecs: 7 * DAY, maxDurationSecs: 90 * DAY };
    expect(defaultLockDays(lockPresets(weekMin), 7)).toBe(7);
  });

  it('falls back to the pool minimum when there are no presets', () => {
    expect(defaultLockDays([], 3)).toBe(3);
  });
});

describe('lockPresets', () => {
  it('offers the venue idiom, clamped to what the pool will accept', () => {
    expect(lockPresets(BAYLA_POOL).map((p) => p.label)).toEqual([
      '1 Day', '7 Days', '30 Days', '90 Days', '6 Months', '1 Year',
    ]);
    expect(lockPresets(BAYLA_POOL).map((p) => p.days)).toEqual([1, 7, 30, 90, 180, 365]);
    expect(lockPresets(BAYLA_POOL)[2]!.seconds).toBe(30 * DAY);
  });

  it('drops presets the program would reject and keeps the pool\'s own bounds', () => {
    const narrow = lockPresets({ minDurationSecs: 14 * DAY, maxDurationSecs: 100 * DAY });
    expect(narrow.map((p) => p.days)).toEqual([14, 30, 90, 100]);
    // Neither bound is a round number here, so both appear on their own.
    expect(narrow[0]!.label).toBe('14 Days');
    expect(narrow[narrow.length - 1]!.label).toBe('100 Days');
  });

  it('never emits a duplicate, even when a bound IS a preset', () => {
    const p = lockPresets({ minDurationSecs: 7 * DAY, maxDurationSecs: 365 * DAY });
    expect(p.map((x) => x.days)).toEqual([7, 30, 90, 180, 365]);
  });

  it('degenerates to a single button when the pool allows one duration', () => {
    expect(lockPresets({ minDurationSecs: 30 * DAY, maxDurationSecs: 30 * DAY }).map((p) => p.days)).toEqual([30]);
  });
});

describe('labelForDays', () => {
  it('speaks months and years where they are exact', () => {
    expect(labelForDays(1)).toBe('1 Day');
    expect(labelForDays(7)).toBe('7 Days');
    expect(labelForDays(30)).toBe('1 Month');
    expect(labelForDays(180)).toBe('6 Months');
    expect(labelForDays(365)).toBe('1 Year');
    expect(labelForDays(730)).toBe('2 Years');
    expect(labelForDays(45)).toBe('45 Days');
  });
});

describe('unlockTs', () => {
  it('is when the program stops refusing an unstake', () => {
    expect(unlockTs({ createdTs: 1_800_000_000, durationSecs: 30 * DAY })).toBe(1_800_000_000 + 30 * DAY);
  });
});

describe('SECONDS_PER_YEAR', () => {
  it('is the 365-day year the annualisation assumes', () => {
    expect(SECONDS_PER_YEAR).toBe(31_536_000);
  });
});
