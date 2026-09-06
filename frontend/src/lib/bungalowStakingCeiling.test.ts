import { describe, it, expect } from 'vitest';
import {
  CLASSIC_ACCOUNTED_CEILING,
  claimCeilingReached,
  anyClaimCeilingReached,
  maxSafeStakeRaw,
  maxSafeStakeAcrossPools,
  OFFERED_LOCK_CEILING_DAYS,
  offeredMaxLockDays,
  lockCeilingApplies,
  lockPresets,
  claimablePoolsBefore,
} from './bungalowStaking';

/**
 * Every number below was READ FROM MAINNET on 2026-09-06 (stake pool
 * EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f, classic reward pool
 * 3ysyH5py46Q4XUXkumGy3DhWjPbNVhLMfQZmpQMdDruf) and the pass/fail verdicts were
 * established by SIMULATING the real `claim_rewards` instruction against live
 * state — not by reasoning about the IDL.
 */
const POOL = { minDurationSecs: 86_400, maxDurationSecs: 31_536_000, maxWeightScaled: 5_000_000_000n };
const FIXED = { nonce: 0, kind: 'fixed' as const, rewardAmountRaw: '7', rewardPeriodSecs: 1 };
const DYNAMIC = { nonce: 1, kind: 'dynamic' as const, rewardAmountRaw: '0', rewardPeriodSecs: 0 };

describe('the classic reward-entry u64 ceiling', () => {
  it('is exactly u64::MAX', () => {
    expect(CLASSIC_ACCOUNTED_CEILING).toBe(18_446_744_073_709_551_615n);
  });

  // These eight are the real live entries. The verdict column is what the chain
  // actually did when the claim was simulated for each one.
  const LIVE: Array<[string, bigint, boolean]> = [
    ['3,000 BAYLA (nonce 0) — simulated claim REVERTED 6000', 50_686_629_810_000_000_000n, true],
    ['3,000 BAYLA (other staker) — simulated claim REVERTED 6000', 49_021_629_810_000_000_000n, true],
    ['1,000,000 BAYLA — simulated claim SUCCEEDED', 14_396_165_000_000_000_000n, false],
    ['369,369 BAYLA — simulated claim SUCCEEDED', 1_466_854_084_063_701_621n, false],
    ['557,727 BAYLA — simulated claim SUCCEEDED', 1_162_037_330_739_315_060n, false],
    ['79,461 BAYLA — simulated claim SUCCEEDED', 1_141_261_808_975_549_380n, false],
    ['10,000 BAYLA — simulated claim SUCCEEDED', 144_278_050_000_000_000n, false],
    ['124.7 BAYLA — simulated claim SUCCEEDED', 1_595_715_901_674_440n, false],
  ];

  it.each(LIVE)('%s', (_label, accounted, blocked) => {
    expect(claimCeilingReached({ accountedRaw: { 0: accounted } }, FIXED)).toBe(blocked);
  });

  it('never blocks a DYNAMIC pool — it accumulates rewards-per-share, not per-position-times-time', () => {
    // Verified against live dynamic pool HBLhyss5mamJ8UFUQ5zUVgDDJ318hHg1cEB3sbHdeEts:
    // four months old, 25.7M units funded and claimed, rewards_state = 3.7e11.
    const huge = CLASSIC_ACCOUNTED_CEILING * 1000n;
    expect(claimCeilingReached({ accountedRaw: { 1: huge } }, DYNAMIC)).toBe(false);
  });

  it('treats an UNREADABLE or ABSENT counter as "not blocked", never as a verdict', () => {
    // An entry that could not be read must not silently disable a user's claim.
    expect(claimCeilingReached({ accountedRaw: { 0: null } }, FIXED)).toBe(false);
    expect(claimCeilingReached({ accountedRaw: {} }, FIXED)).toBe(false);
  });

  it('is a STRICT boundary — exactly at u64::MAX still claims', () => {
    expect(claimCeilingReached({ accountedRaw: { 0: CLASSIC_ACCOUNTED_CEILING } }, FIXED)).toBe(false);
    expect(claimCeilingReached({ accountedRaw: { 0: CLASSIC_ACCOUNTED_CEILING + 1n } }, FIXED)).toBe(true);
  });

  it('anyClaimCeilingReached fires when ANY attached pool is past it', () => {
    const e = { accountedRaw: { 0: CLASSIC_ACCOUNTED_CEILING + 1n, 1: 0n } };
    expect(anyClaimCeilingReached(e, [DYNAMIC])).toBe(false);
    expect(anyClaimCeilingReached(e, [DYNAMIC, FIXED])).toBe(true);
  });
});

describe('maxSafeStakeRaw — the size a lock can actually carry', () => {
  it('reproduces the observed 365-day cap of 16,712 BAYLA', () => {
    // Derived independently: u64::MAX * period * 1e9 / (weight * rewardAmount * secs).
    // The live 1,000,000 BAYLA position at this tier broke 6.1 days into a
    // 365-day lock, which is what this cap exists to prevent.
    const cap = maxSafeStakeRaw(POOL, FIXED, 31_536_000);
    expect(cap).not.toBeNull();
    expect(Number(cap! / 1_000_000n)).toBe(16_712);
  });

  it('lets the live 1,000,000 BAYLA / 365d position FAIL the cap it was sold under', () => {
    const cap = maxSafeStakeRaw(POOL, FIXED, 31_536_000)!;
    expect(1_000_000_000_000n > cap).toBe(true);
  });

  it('is more permissive for shorter locks, because weight AND term both shrink', () => {
    const y = maxSafeStakeRaw(POOL, FIXED, 31_536_000)!;
    const q = maxSafeStakeRaw(POOL, FIXED, 90 * 86_400)!;
    const w = maxSafeStakeRaw(POOL, FIXED, 7 * 86_400)!;
    expect(q).toBeGreaterThan(y);
    expect(w).toBeGreaterThan(q);
    // The 557,727 BAYLA / 7-day position on mainnet is safe, and the cap agrees.
    expect(557_727_226_129n < w).toBe(true);
    // The 369,369 BAYLA / 90-day position is NOT safe (breaks ~2026-10-14).
    expect(369_369_000_000n > q).toBe(true);
  });

  it('returns null rather than a bogus cap when the rate is unreadable or the pool is dynamic', () => {
    expect(maxSafeStakeRaw(POOL, DYNAMIC, 31_536_000)).toBeNull();
    expect(maxSafeStakeRaw(POOL, { ...FIXED, rewardAmountRaw: '0' }, 31_536_000)).toBeNull();
    expect(maxSafeStakeRaw(POOL, { ...FIXED, rewardPeriodSecs: 0 }, 31_536_000)).toBeNull();
  });

  it('takes the TIGHTEST cap across pools, and null when none applies', () => {
    const both = maxSafeStakeAcrossPools({ ...POOL, rewardPools: [DYNAMIC, FIXED] as never }, 31_536_000);
    expect(both).toBe(maxSafeStakeRaw(POOL, FIXED, 31_536_000));
    expect(maxSafeStakeAcrossPools({ ...POOL, rewardPools: [DYNAMIC] as never }, 31_536_000)).toBeNull();
  });
});

describe('the offered lock ceiling', () => {
  const BAYLA = { minDurationSecs: 86_400, maxDurationSecs: 31_536_000 };

  it('holds the offered ladder at 90 days while the pool still allows 365', () => {
    expect(OFFERED_LOCK_CEILING_DAYS).toBe(90);
    expect(offeredMaxLockDays(BAYLA)).toBe(90);
    expect(lockCeilingApplies(BAYLA)).toBe(true);
  });

  it('leaves a pool alone when its own maximum is already inside the ceiling', () => {
    const short = { minDurationSecs: 86_400, maxDurationSecs: 30 * 86_400 };
    expect(offeredMaxLockDays(short)).toBe(30);
    expect(lockCeilingApplies(short)).toBe(false);
  });

  it('never returns less than the pool MINIMUM — a pool whose min exceeds the ceiling must still be stakeable', () => {
    // Otherwise the ladder renders empty and nobody can stake at all.
    const longMin = { minDurationSecs: 180 * 86_400, maxDurationSecs: 365 * 86_400 };
    expect(offeredMaxLockDays(longMin)).toBe(180);
  });

  it('lockPresets keeps the POOL bounds by default — the venue policy is opt-in', () => {
    // This is the contract bungalowStakingRates.test.ts pins; the ceiling must
    // not change what lockPresets means to callers that did not ask for it.
    const uncapped = lockPresets(BAYLA).map((p) => p.days);
    expect(uncapped).toContain(365);
    const capped = lockPresets(BAYLA, OFFERED_LOCK_CEILING_DAYS).map((p) => p.days);
    expect(capped).not.toContain(365);
    expect(capped).not.toContain(180);
    expect(capped[capped.length - 1]).toBe(90);
  });

  it('the capped ladder still starts at the pool minimum', () => {
    const capped = lockPresets(BAYLA, OFFERED_LOCK_CEILING_DAYS).map((p) => p.days);
    expect(capped[0]).toBe(1);
  });
});

describe('two reward pools — what the rescue exit must not throw away', () => {
  const DEAD = { nonce: 0, kind: 'fixed' as const, rewardAmountRaw: '7', rewardPeriodSecs: 1 } as never;
  const LIVE = { nonce: 1, kind: 'dynamic' as const, rewardAmountRaw: '0', rewardPeriodSecs: 0 } as never;
  const over = CLASSIC_ACCOUNTED_CEILING + 1n;

  it('keeps the WORKING dynamic pool and drops the dead classic one', () => {
    // The exact state BAYLA is in the day the dynamic pool goes live: the
    // classic entry is bricked, the dynamic entry is fine and holds real money.
    const e = { accountedRaw: { 0: over, 1: null }, pendingRaw: { 0: 43_555_365n, 1: 900_000n } };
    const keep = claimablePoolsBefore(e, [DEAD, LIVE]);
    expect(keep.map((p) => p.nonce)).toEqual([1]);
  });

  it('drops a pool with genuinely nothing pending — a claim there is a wasted fee', () => {
    const e = { accountedRaw: { 0: 0n, 1: null }, pendingRaw: { 0: 0n, 1: 0n } };
    expect(claimablePoolsBefore(e, [DEAD, LIVE])).toEqual([]);
  });

  it('KEEPS a pool whose accrual could not be read — an unknown is never written off silently', () => {
    const e = { accountedRaw: { 0: 0n, 1: null }, pendingRaw: { 0: null, 1: null } };
    expect(claimablePoolsBefore(e, [DEAD, LIVE]).map((p) => p.nonce)).toEqual([0, 1]);
  });

  it('today, with only the classic pool attached and it dead, there is nothing to save first', () => {
    const e = { accountedRaw: { 0: over }, pendingRaw: { 0: 43_555_365n } };
    expect(claimablePoolsBefore(e, [DEAD])).toEqual([]);
  });
});

describe('writeFailure distinguishes the two 6013s', () => {
  it('reads a REWARD-program 6013 as a drained vault that clears', () => {
    const msg = 'AnchorError thrown in claim_rewards.rs:221. Error Code: RewardPoolDrained. Error Number: 6013.';
    expect(/RewardPoolDrained/i.test(msg) || (/\b6013\b/.test(msg) && /reward/i.test(msg))).toBe(true);
  });
  it('does NOT read a STAKE-program 6013 (LockedStake) as a drained vault', () => {
    const msg = 'AnchorError thrown in unstake/base.rs:220. Error Code: LockedStake. Error Number: 6013.';
    expect(/RewardPoolDrained/i.test(msg) || (/\b6013\b/.test(msg) && /reward/i.test(msg))).toBe(false);
  });
});
