import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { parseEther, formatEther } from 'viem';
import { wagmiMock } from '../test-utils/wagmi-mocks';

// Sonner: not used by usePoolData but keep the pattern symmetrical in case
// of transitive imports.
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { usePoolData } from './usePoolData';
import { TEGRIDY_STAKING_ADDRESS, OLD_STAKING_CONTRACT } from '../lib/constants';

const USER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
// Staking release 1 pays out over a four-year schedule: a pool is only paying before its end.
const SCHEDULE_RUNNING = BigInt(Math.floor(Date.now() / 1000) + 4 * 365 * 86400);

describe('usePoolData', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setAccount({ address: USER, isConnected: true });
  });

  it('defaults to zero-formatted strings when no reads are stubbed', () => {
    const { result } = renderHook(() => usePoolData());
    expect(result.current.totalStaked).toBe('0');
    expect(result.current.totalStakedRaw).toBe(0n);
    expect(result.current.totalBoostedStake).toBe('0');
    expect(result.current.rewardRate).toBe('0');
    expect(result.current.totalRewardsFunded).toBe('0');
    expect(result.current.totalPenalties).toBe('0');
    expect(result.current.apr).toBe('0');
    expect(result.current.aprCapped).toBe(false);
  });

  it('isDeployed is true for the canonical staking address', () => {
    const { result } = renderHook(() => usePoolData());
    expect(result.current.isDeployed).toBe(true);
  });

  it('aprDisclaimer is the fixed display string', () => {
    const { result } = renderHook(() => usePoolData());
    // Copy updated with the bootstrap-rate framing on outlier APRs
    // (was "Current rate, subject to change").
    expect(result.current.aprDisclaimer).toBe('Bootstrap rate — falls as staking grows');
  });

  it('isLoading propagates as a boolean', () => {
    const { result } = renderHook(() => usePoolData());
    // The wagmi mock returns isLoading: false for useReadContracts.
    expect(typeof result.current.isLoading).toBe('boolean');
    expect(result.current.isLoading).toBe(false);
  });

  it('propagates totalStaked from the read batch (raw + formatted)', () => {
    const staked = 1234n * 10n ** 18n;
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: staked });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.totalStakedRaw).toBe(staked);
    expect(result.current.totalStaked).toBe('1234');
  });

  it('propagates totalBoostedStake and rewardRate as formatted ether', () => {
    // totalLocked was dropped from the hook: the deployed staking contract has
    // no totalLocked() (2026-05-30 EIP-170 golf), so the read always reverted
    // and the field could only ever be '0'.
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: parseEther('500') });
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: parseEther('0.1') });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.totalBoostedStake).toBe('500');
    expect(result.current.rewardRate).toBe('0.1');
  });

  it('propagates totalRewardsFunded and totalPenalties as formatted ether', () => {
    wagmiMock.setReadResult({ functionName: 'totalRewardsFunded', result: parseEther('1000000') });
    wagmiMock.setReadResult({ functionName: 'totalPenaltiesCollected', result: parseEther('42.5') });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.totalRewardsFunded).toBe('1000000');
    expect(result.current.totalPenalties).toBe('42.5');
  });

  it('falls back to 0 when individual reads return failure, and SAYS the read did not land', () => {
    // Stack: success then failure — last match wins per findRead().
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: parseEther('100') });
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: 0n, status: 'failure' });
    const { result } = renderHook(() => usePoolData());
    // The display collapse to 0 is the house pattern and stays (see
    // scripts/check-unread-signal.mjs) — what may NOT stay is a collapse a
    // caller cannot tell apart from a real zero.
    expect(result.current.totalStaked).toBe('0');
    expect(result.current.totalStakedRaw).toBe(0n);
    expect(result.current.totalStakedUnread).toBe(true);
  });

  it('apr is 0 when rewardRate is 0 (no reward flow)', () => {
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: parseEther('1000') });
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: 0n });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.apr).toBe('0');
    expect(result.current.aprCapped).toBe(false);
  });

  it('apr is 0 when totalBoostedStake is 0 (avoids div-by-zero)', () => {
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: parseEther('1') });
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: 0n });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.apr).toBe('0');
    expect(result.current.aprCapped).toBe(false);
  });

  it('computes apr correctly for a realistic reward/stake ratio', () => {
    wagmiMock.setReadResult({ functionName: 'periodFinish', result: SCHEDULE_RUNNING });
    // rewardRate = 1 wei/sec vs boosted stake of 31_536_000 wei.
    // APR = rewardRate * secs_per_year / totalBoostedStake = 1.0 (i.e. 100%).
    // Formatted with 2 decimals: "100.00".
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: 1n });
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: 31_536_000n });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.apr).toBe('100.00');
    expect(result.current.aprNum).toBe(100);
    expect(result.current.aprCapped).toBe(false);
  });

  it('computes a small apr with preserved precision (scaling by 1e18)', () => {
    wagmiMock.setReadResult({ functionName: 'periodFinish', result: SCHEDULE_RUNNING });
    // rewardRate = 1 wei/sec, totalBoostedStake = 31_536_000 * 100 = 3_153_600_000
    // APR = 1%  → "1.00"
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: 1n });
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: 3_153_600_000n });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.apr).toBe('1.00');
    expect(result.current.aprNum).toBe(1);
    expect(result.current.aprCapped).toBe(false);
  });

  it('renders a very large apr as a comma integer with no cap (operator decision 2026-06-07)', () => {
    wagmiMock.setReadResult({ functionName: 'periodFinish', result: SCHEDULE_RUNNING });
    // rewardRate=100 wei/s, boostedStake=31_536_000 wei → APR = exactly 10,000%.
    // Post-2026-06-07 the hook shows the REAL APR (comma integer), not a ">9999" cap,
    // and exposes the numeric aprNum so consumers never parseFloat the comma string.
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: 100n });
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: 31_536_000n });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.apr).toBe((10000).toLocaleString());
    expect(result.current.aprNum).toBe(10000);
    expect(result.current.aprCapped).toBe(false);
  });

  it('scopes reads to the TEGRIDY_STAKING_ADDRESS contract', () => {
    // A stub matched to a different address must not affect this hook.
    wagmiMock.setReadResult({
      functionName: 'totalStaked',
      address: '0x0000000000000000000000000000000000000001',
      result: parseEther('9999'),
    });
    // A stub for the real staking address should be picked up.
    wagmiMock.setReadResult({
      functionName: 'totalStaked',
      address: TEGRIDY_STAKING_ADDRESS,
      result: parseEther('7'),
    });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.totalStaked).toBe('7');
  });

  // ── OUTAGE-AS-ZERO: the reward pool, the runway, and the dry clamp ──────
  //
  // rewardsRemaining is a DIFFERENCE of three separate reads:
  //   balanceOf(staking) − totalStaked − totalUnsettledRewards
  // so any one of them failing does not make the answer smaller or vaguer — it
  // makes it BIGGER and perfectly plausible. That is the shape this repo keeps
  // shipping: not a blank, a number.

  it('does not publish a reward pool or a runway when a subtrahend read failed', () => {
    // balanceOf lands; totalStaked does NOT (no stub => the mock fails it).
    // Pre-fix the hook subtracted 0 for the missing stake, so the ENTIRE staked
    // principal was reported as spendable reward reserve, with a runway to match.
    wagmiMock.setReadResult({ functionName: 'balanceOf', result: parseEther('1000000') });
    wagmiMock.setReadResult({ functionName: 'totalUnsettledRewards', result: 0n });
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: parseEther('1') });
    const { result } = renderHook(() => usePoolData());

    // The invariant: an unread input cannot be silently treated as zero in a
    // subtraction whose result is presented as TOWELI on screen.
    expect(result.current.rewardsRemainingUnread).toBe(true);
    expect(parseFloat(result.current.rewardsRemaining)).toBe(0);
    expect(result.current.secondsRemaining).toBe(0);
    expect(result.current.periodFinish).toBe(0);
    // ...and it must not swing the other way either: "unread" is not "empty".
    expect(result.current.isDry).toBe(false);
  });

  it('clamps APR to zero when the reserve is READ and is genuinely empty', () => {
    // STAKING_LOOK §2.2: on-chain accrual is clamped to the pool, so a
    // rate-derived APR on an empty reserve is a lie. Pre-fix the "did the reads
    // land?" test was `stakingBalance > 0n`, which a truthfully-empty reserve
    // fails — so the dry clamp never armed on the one day it exists for.
    wagmiMock.setReadResult({ functionName: 'balanceOf', result: 0n });
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: 0n });
    wagmiMock.setReadResult({ functionName: 'totalUnsettledRewards', result: 0n });
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: 1n });
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: 31_536_000n });
    const { result } = renderHook(() => usePoolData());

    expect(result.current.rewardsRemainingUnread).toBe(false);
    expect(result.current.isDry).toBe(true);
    expect(result.current.aprNum).toBe(0);
    expect(result.current.apr).toBe('0');
  });

  it('an APR of zero from a total outage is distinguishable from a real zero rate', () => {
    // No stubs at all: every entry fails. Pre-fix this was byte-identical to a
    // live pool paying nothing — same '0', same aprNum, no way to tell.
    const { result } = renderHook(() => usePoolData());
    expect(result.current.apr).toBe('0');
    expect(result.current.aprUnread).toBe(true);
    expect(result.current.rewardRateUnread).toBe(true);
    expect(result.current.rewardsFundedUnread).toBe(true);
    expect(result.current.totalStakedUnread).toBe(true);
    // An outage is not an empty reserve.
    expect(result.current.isDry).toBe(false);
  });

  it('a live pool paying a real zero rate is NOT reported as unread', () => {
    wagmiMock.setReadResult({ functionName: 'periodFinish', result: SCHEDULE_RUNNING });
    // The mirror image of the test above — pins that the signal tracks read
    // STATUS, not the value, so it cannot be satisfied by a `> 0n` proxy.
    wagmiMock.setReadResult({ functionName: 'balanceOf', result: parseEther('10') });
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: 0n });
    wagmiMock.setReadResult({ functionName: 'totalUnsettledRewards', result: 0n });
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: 0n });
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: 0n });
    wagmiMock.setReadResult({ functionName: 'totalRewardsFunded', result: 0n });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.rewardRateUnread).toBe(false);
    expect(result.current.aprUnread).toBe(false);
    expect(result.current.totalStakedUnread).toBe(false);
    expect(result.current.rewardsFundedUnread).toBe(false);
    expect(result.current.rewardsRemainingUnread).toBe(false);
    expect(result.current.apr).toBe('0');
  });

  it('totalStaked handles fractional ether correctly via formatEther', () => {
    const raw = parseEther('0.000123');
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: raw });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.totalStaked).toBe(formatEther(raw));
    expect(result.current.totalStakedRaw).toBe(raw);
  });

  // ── 2026-10-18: the four-year schedule ─────────────────────────────────
  function stubPayingPool() {
    wagmiMock.setReadResult({ functionName: 'balanceOf', result: parseEther('2000000') });
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: parseEther('100000') });
    wagmiMock.setReadResult({ functionName: 'totalUnsettledRewards', result: 0n });
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: parseEther('0.01') });
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: parseEther('100000') });
    wagmiMock.setReadResult({ functionName: 'totalRewardsFunded', result: parseEther('1460000') });
  }

  it('reads the end of payouts from the contract, not pot / rate', () => {
    stubPayingPool();
    wagmiMock.setReadResult({ functionName: 'periodFinish', result: SCHEDULE_RUNNING });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.periodFinish).toBe(Number(SCHEDULE_RUNNING));
    expect(result.current.scheduleEnded).toBe(false);
    expect(result.current.aprNum).toBeGreaterThan(0);
  });

  it('a rate past periodFinish pays nothing: APR 0 and the schedule reads as ended', () => {
    stubPayingPool();
    wagmiMock.setReadResult({ functionName: 'periodFinish', result: BigInt(Math.floor(Date.now() / 1000) - 60) });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.scheduleEnded).toBe(true);
    expect(result.current.apr).toBe('0');
    expect(result.current.aprNum).toBe(0);
    expect(result.current.secondsRemaining).toBe(0);
    expect(result.current.aprUnread).toBe(false);
  });

  it('an unfunded pool (periodFinish 0) is not paying', () => {
    stubPayingPool();
    wagmiMock.setReadResult({ functionName: 'periodFinish', result: 0n });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.scheduleEnded).toBe(true);
    expect(result.current.aprNum).toBe(0);
  });

  it('an unread periodFinish is unknown, not "paying" and not "ended"', () => {
    stubPayingPool();
    // periodFinish not stubbed: the mock fails it.
    const { result } = renderHook(() => usePoolData());
    expect(result.current.scheduleUnread).toBe(true);
    expect(result.current.scheduleEnded).toBe(false);
    expect(result.current.aprUnread).toBe(true);
    expect(result.current.aprNum).toBe(0);
  });
  it('the first contract has no schedule: periodFinish is never asked, and nothing reads as ended', () => {
    // An ended periodFinish answers if asked: a hook that asked would clamp the APR to 0.
    wagmiMock.setReadResult({ functionName: 'periodFinish', result: 1n });
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: 1n });
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: 31_536_000n });
    const { result } = renderHook(() => usePoolData(OLD_STAKING_CONTRACT));
    expect(result.current.scheduleUnread).toBe(false);
    expect(result.current.scheduleEnded).toBe(false);
    expect(result.current.periodFinish).toBe(0);
    expect(result.current.apr).toBe('100.00');
  });
});
