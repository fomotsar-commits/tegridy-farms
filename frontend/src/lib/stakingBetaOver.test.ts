import { describe, expect, it } from 'vitest';
import {
  BETA_OVER_HEADING,
  BETA_OVER_LINE,
  NEW_STAKES_CLOSED_LINE,
  betaReadsFromHooks,
  stakingBetaPhase,
  type StakingBetaReads,
} from './stakingBetaOver';
import { OLD_STAKING_CONTRACT } from './constants';

const E18 = 10n ** 18n;
/** Every read landed: the rate still runs, the reserve holds 1,000 TOWELI, no wallet. */
const LANDED: StakingBetaReads = { loading: false, paused: false, rewardRate: 8n * 10n ** 17n, rewardsRemaining: 1000n * E18 };

describe('stakingBetaPhase: each phase of the owner plan, from the chain', () => {
  it('rate still running: closing', () => {
    expect(stakingBetaPhase(LANDED)).toBe('closing');
    // Today's mainnet: the rate runs on an EMPTY reserve. The line is the plan, and
    // the Claimable tile's own dry note (#1029) says a claim pays 0.
    expect(stakingBetaPhase({ ...LANDED, rewardsRemaining: 0n })).toBe('closing');
  });

  it('rate 0 and the reserve covers what this wallet is owed: claim now', () => {
    expect(stakingBetaPhase({ ...LANDED, rewardRate: 0n, owed: 400n * E18 })).toBe('claim-now');
    expect(stakingBetaPhase({ ...LANDED, rewardRate: 0n, owed: 1000n * E18 })).toBe('claim-now');
    // No position to weigh: a non-empty reserve is all there is to check.
    expect(stakingBetaPhase({ ...LANDED, rewardRate: 0n })).toBe('claim-now');
  });

  it('rate 0 and the reserve short of what this wallet is owed: reserve-short', () => {
    expect(stakingBetaPhase({ ...LANDED, rewardRate: 0n, owed: 1000n * E18 + 1n })).toBe('reserve-short');
  });

  it('rate 0 and the reserve empty (before the refill): reserve-empty, never claim-now', () => {
    expect(stakingBetaPhase({ ...LANDED, rewardRate: 0n, rewardsRemaining: 0n })).toBe('reserve-empty');
    expect(stakingBetaPhase({ ...LANDED, rewardRate: 0n, rewardsRemaining: 0n, owed: 0n })).toBe('reserve-empty');
  });

  it('paused: paused, whatever the rate and the reserve say', () => {
    expect(stakingBetaPhase({ ...LANDED, paused: true })).toBe('paused');
    expect(stakingBetaPhase({ ...LANDED, paused: true, rewardRate: 0n, rewardsRemaining: 0n })).toBe('paused');
    // A read pause is enough on its own: the other reads failing does not hide the exit.
    expect(stakingBetaPhase({ loading: false, paused: true, rewardRate: null, rewardsRemaining: null, owed: null })).toBe('paused');
  });
});

describe('stakingBetaPhase: a read that did not land never reads as fine', () => {
  it('an unread pause is unread, not "running"', () => {
    expect(stakingBetaPhase({ ...LANDED, paused: null })).toBe('unread');
  });

  it('an unread rate is unread, not "rewards stopped"', () => {
    expect(stakingBetaPhase({ ...LANDED, rewardRate: null })).toBe('unread');
  });

  it('rate 0 with an unread reserve is unread, not "claim now"', () => {
    expect(stakingBetaPhase({ ...LANDED, rewardRate: 0n, rewardsRemaining: null })).toBe('unread');
  });

  it('rate 0 with this wallet\'s rewards unread is unread, not "claim now"', () => {
    expect(stakingBetaPhase({ ...LANDED, rewardRate: 0n, owed: null })).toBe('unread');
  });

  it('while the first load runs, the same gaps say checking instead', () => {
    expect(stakingBetaPhase({ loading: true, paused: null, rewardRate: null, rewardsRemaining: null })).toBe('checking');
    expect(stakingBetaPhase({ ...LANDED, loading: true, rewardRate: 0n, owed: null })).toBe('checking');
  });
});

describe('betaReadsFromHooks: a value counts only beside its own landed flag', () => {
  const pool = {
    isLoading: false, paused: false as boolean | null,
    rewardRateRaw: 0n, rewardRateUnread: false, rewardsRemainingRaw: 5n, rewardsRemainingUnread: false,
  };

  it('passes landed reads through', () => {
    expect(betaReadsFromHooks(pool)).toEqual({ loading: false, paused: false, rewardRate: 0n, rewardsRemaining: 5n, owed: undefined });
  });

  it("treats usePoolData's forced 0n as unread when its flag says so", () => {
    const r = betaReadsFromHooks({ ...pool, rewardRateUnread: true, rewardsRemainingUnread: true, paused: null });
    expect(r).toMatchObject({ paused: null, rewardRate: null, rewardsRemaining: null });
    expect(stakingBetaPhase(r)).toBe('unread');
  });

  it('a hook without the flags at all is unread, never a zero', () => {
    expect(betaReadsFromHooks({})).toEqual({ loading: false, paused: null, rewardRate: null, rewardsRemaining: null, owed: undefined });
  });

  it("prefers the wallet's own pause read, and falls back to the pool's when it did not land", () => {
    expect(betaReadsFromHooks(pool, { isPaused: true }).paused).toBe(true);
    expect(betaReadsFromHooks({ ...pool, paused: true }, { isPaused: null }).paused).toBe(true);
  });

  it("weighs the wallet's unclaimed rewards only when its position was read", () => {
    expect(betaReadsFromHooks(pool, { hasPosition: true, pendingReward: 9n }).owed).toBe(9n);
    expect(betaReadsFromHooks(pool, { positionUnread: true, hasPosition: false, pendingReward: 0n }).owed).toBeNull();
    expect(betaReadsFromHooks(pool, { hasPosition: false, pendingReward: 0n }).owed).toBeUndefined();
  });

  it('is loading while either hook is', () => {
    expect(betaReadsFromHooks({ ...pool, isLoading: true }).loading).toBe(true);
    expect(betaReadsFromHooks(pool, { isLoading: true }).loading).toBe(true);
  });
});

describe('the copy', () => {
  it('is the heading plus one line per phase, names TOWELI or rewards, and has no em dash', () => {
    expect(BETA_OVER_HEADING).toBe('Beta is over');
    for (const line of [...Object.values(BETA_OVER_LINE), NEW_STAKES_CLOSED_LINE]) {
      expect(line).not.toMatch(/—/);
      expect(line.length).toBeLessThan(160);
    }
    expect(BETA_OVER_LINE.closing).toMatch(/TOWELI staking v1 is closing/);
    expect(BETA_OVER_LINE.closing).toMatch(/no 25% penalty/);
    expect(BETA_OVER_LINE.paused).toMatch(/no penalty/);
    expect(BETA_OVER_LINE['claim-now']).toMatch(/can't be made while it's paused/);
    expect(BETA_OVER_LINE.unread).toMatch(/could not read/);
  });

  it('v1 is the old contract: it takes no new stakes, and its fee is 25%, not the new 75%', () => {
    expect(OLD_STAKING_CONTRACT.acceptsStakes).toBe(false);
    expect(OLD_STAKING_CONTRACT.penaltyBps).toBe(2500);
  });
});
