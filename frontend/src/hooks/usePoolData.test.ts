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
import { TEGRIDY_STAKING_ADDRESS } from '../lib/constants';

const USER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;

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
    expect(result.current.totalLocked).toBe('0');
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
    expect(result.current.aprDisclaimer).toBe('Current rate, subject to change');
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

  it('propagates totalBoostedStake, totalLocked and rewardRate as formatted ether', () => {
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: parseEther('500') });
    wagmiMock.setReadResult({ functionName: 'totalLocked', result: parseEther('250') });
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: parseEther('0.1') });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.totalBoostedStake).toBe('500');
    expect(result.current.totalLocked).toBe('250');
    expect(result.current.rewardRate).toBe('0.1');
  });

  it('propagates totalRewardsFunded and totalPenalties as formatted ether', () => {
    wagmiMock.setReadResult({ functionName: 'totalRewardsFunded', result: parseEther('1000000') });
    wagmiMock.setReadResult({ functionName: 'totalPenaltiesCollected', result: parseEther('42.5') });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.totalRewardsFunded).toBe('1000000');
    expect(result.current.totalPenalties).toBe('42.5');
  });

  it('falls back to 0 when individual reads return failure', () => {
    // Stack: success then failure — last match wins per findRead().
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: parseEther('100') });
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: 0n, status: 'failure' });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.totalStaked).toBe('0');
    expect(result.current.totalStakedRaw).toBe(0n);
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
    // rewardRate = 1 wei/sec vs boosted stake of 31_536_000 wei.
    // APR = rewardRate * secs_per_year / totalBoostedStake = 1.0 (i.e. 100%).
    // Formatted with 2 decimals: "100.00".
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: 1n });
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: 31_536_000n });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.apr).toBe('100.00');
    expect(result.current.aprCapped).toBe(false);
  });

  it('computes a small apr with preserved precision (scaling by 1e18)', () => {
    // rewardRate = 1 wei/sec, totalBoostedStake = 31_536_000 * 100 = 3_153_600_000
    // APR = 1%  → "1.00"
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: 1n });
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: 3_153_600_000n });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.apr).toBe('1.00');
    expect(result.current.aprCapped).toBe(false);
  });

  it('caps apr at ">9999" when the computed percentage exceeds 999999', () => {
    // Huge reward rate, tiny boosted stake → enormous APR → cap trips.
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: parseEther('1000000') });
    wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: 1n });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.apr).toBe('>9999');
    expect(result.current.aprCapped).toBe(true);
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

  it('totalStaked handles fractional ether correctly via formatEther', () => {
    const raw = parseEther('0.000123');
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: raw });
    const { result } = renderHook(() => usePoolData());
    expect(result.current.totalStaked).toBe(formatEther(raw));
    expect(result.current.totalStakedRaw).toBe(raw);
  });
});
