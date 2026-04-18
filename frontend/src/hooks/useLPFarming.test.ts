import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { parseEther } from 'viem';
import { wagmiMock } from '../test-utils/wagmi-mocks';

// Sonner mock — hook calls toast.* from multiple effects; stub to no-ops.
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

// Explorer URL helper doesn't matter for unit tests.
vi.mock('../lib/explorer', () => ({ getTxUrl: () => 'https://example.test/tx' }));

import { useLPFarming } from './useLPFarming';
import { LP_FARMING_ADDRESS, TEGRIDY_LP_ADDRESS, CHAIN_ID } from '../lib/constants';

const USER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;

describe('useLPFarming', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setChainId(CHAIN_ID);
    wagmiMock.setAccount({ address: USER, isConnected: true });
  });

  // ───────────── Read-side: defaults + derived values ────────────────────

  it('defaults to zero state when no reads are stubbed', () => {
    const { result } = renderHook(() => useLPFarming());
    expect(result.current.totalStaked).toBe(0n);
    expect(result.current.rewardRate).toBe(0n);
    expect(result.current.stakedBalance).toBe(0n);
    expect(result.current.pendingReward).toBe(0n);
    expect(result.current.walletLPBalance).toBe(0n);
    expect(result.current.lpAllowance).toBe(0n);
    expect(result.current.isActive).toBe(false);
    expect(result.current.rewardRatePerDay).toBe(0);
    expect(result.current.rewardRatePerYear).toBe(0);
  });

  it('isActive is true when periodFinish is in the future', () => {
    const future = Math.floor(Date.now() / 1000) + 86400; // 1d out
    wagmiMock.setReadResult({ functionName: 'periodFinish', result: BigInt(future) });
    const { result } = renderHook(() => useLPFarming());
    expect(result.current.isActive).toBe(true);
  });

  it('isActive is false when periodFinish has passed', () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    wagmiMock.setReadResult({ functionName: 'periodFinish', result: BigInt(past) });
    const { result } = renderHook(() => useLPFarming());
    expect(result.current.isActive).toBe(false);
  });

  it('rewardRatePerDay = rewardRate (as bigint, 18 decimals) * 86400 seconds', () => {
    // 1 TOWELI/sec = 1e18/sec → 86400 TOWELI/day
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: 10n ** 18n });
    const { result } = renderHook(() => useLPFarming());
    expect(result.current.rewardRatePerDay).toBe(86400);
    // 86400 * 365
    expect(result.current.rewardRatePerYear).toBe(86400 * 365);
  });

  it('propagates every read field from the useReadContracts batch', () => {
    const periodFinish = BigInt(Math.floor(Date.now() / 1000) + 100000);
    wagmiMock.setReadResult({ functionName: 'totalSupply', address: LP_FARMING_ADDRESS, result: 5_000n * 10n ** 18n });
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: 2n * 10n ** 18n });
    wagmiMock.setReadResult({ functionName: 'periodFinish', result: periodFinish });
    wagmiMock.setReadResult({ functionName: 'rewardsDuration', result: 604800n });
    wagmiMock.setReadResult({ functionName: 'totalRewardsFunded', result: 1_000_000n * 10n ** 18n });
    wagmiMock.setReadResult({ functionName: 'balanceOf', address: LP_FARMING_ADDRESS, result: 100n * 10n ** 18n });
    wagmiMock.setReadResult({ functionName: 'earned', result: 50n * 10n ** 18n });
    wagmiMock.setReadResult({ functionName: 'balanceOf', address: TEGRIDY_LP_ADDRESS, result: 999n * 10n ** 18n });
    wagmiMock.setReadResult({ functionName: 'allowance', result: 500n * 10n ** 18n });
    wagmiMock.setReadResult({ functionName: 'totalSupply', address: TEGRIDY_LP_ADDRESS, result: 10_000n * 10n ** 18n });

    const { result } = renderHook(() => useLPFarming());
    expect(result.current.totalStaked).toBe(5_000n * 10n ** 18n);
    expect(result.current.rewardRate).toBe(2n * 10n ** 18n);
    expect(result.current.periodFinish).toBe(Number(periodFinish));
    expect(result.current.rewardsDuration).toBe(604800);
    expect(result.current.totalRewardsFunded).toBe(1_000_000n * 10n ** 18n);
    expect(result.current.stakedBalance).toBe(100n * 10n ** 18n);
    expect(result.current.pendingReward).toBe(50n * 10n ** 18n);
    expect(result.current.walletLPBalance).toBe(999n * 10n ** 18n);
    expect(result.current.lpAllowance).toBe(500n * 10n ** 18n);
    expect(result.current.lpTotalSupply).toBe(10_000n * 10n ** 18n);
  });

  it('emits *Formatted strings as 18-decimal ether format', () => {
    wagmiMock.setReadResult({ functionName: 'balanceOf', address: LP_FARMING_ADDRESS, result: 3n * 10n ** 18n });
    wagmiMock.setReadResult({ functionName: 'earned', result: parseEther('0.25') });
    const { result } = renderHook(() => useLPFarming());
    expect(result.current.stakedBalanceFormatted).toBe('3');
    expect(result.current.pendingRewardFormatted).toBe('0.25');
  });

  // ───────────── Action-side: writeContract args ─────────────────────────

  it('approveLP calls writeContract on the LP token with the right amount', () => {
    const { result } = renderHook(() => useLPFarming());
    act(() => result.current.approveLP('42'));
    const write = wagmiMock.writeContract();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatchObject({
      address: TEGRIDY_LP_ADDRESS,
      functionName: 'approve',
    });
    expect(write.mock.calls[0][0].args).toEqual([LP_FARMING_ADDRESS, parseEther('42')]);
  });

  it('approveLP blocks and no-ops on wrong network', () => {
    wagmiMock.setChainId(11155111); // Sepolia
    const { result } = renderHook(() => useLPFarming());
    act(() => result.current.approveLP('1'));
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });

  it('stake blocks when lpAllowance is insufficient', () => {
    // Allowance < want → proactive guard trips, no writeContract call
    wagmiMock.setReadResult({ functionName: 'allowance', result: parseEther('1') });
    const { result } = renderHook(() => useLPFarming());
    act(() => result.current.stake('5'));
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });

  it('stake succeeds when lpAllowance >= requested amount', () => {
    wagmiMock.setReadResult({ functionName: 'allowance', result: parseEther('1000') });
    const { result } = renderHook(() => useLPFarming());
    act(() => result.current.stake('5'));
    const write = wagmiMock.writeContract();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatchObject({
      address: LP_FARMING_ADDRESS,
      functionName: 'stake',
    });
    expect(write.mock.calls[0][0].args).toEqual([parseEther('5')]);
  });

  it('stake blocks on wrong network', () => {
    wagmiMock.setChainId(10);
    wagmiMock.setReadResult({ functionName: 'allowance', result: parseEther('1000') });
    const { result } = renderHook(() => useLPFarming());
    act(() => result.current.stake('5'));
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });

  it('withdraw calls writeContract with parsed amount', () => {
    const { result } = renderHook(() => useLPFarming());
    act(() => result.current.withdraw('2.5'));
    const write = wagmiMock.writeContract();
    expect(write.mock.calls[0][0]).toMatchObject({
      address: LP_FARMING_ADDRESS,
      functionName: 'withdraw',
    });
    expect(write.mock.calls[0][0].args).toEqual([parseEther('2.5')]);
  });

  it('claim calls getReward with no args', () => {
    const { result } = renderHook(() => useLPFarming());
    act(() => result.current.claim());
    const write = wagmiMock.writeContract();
    expect(write.mock.calls[0][0]).toMatchObject({
      address: LP_FARMING_ADDRESS,
      functionName: 'getReward',
    });
    // Contract call shape: no args provided → undefined in the wagmi input.
    expect(write.mock.calls[0][0].args).toBeUndefined();
  });

  it('exit calls the Synthetix-style exit() (session-1 addition)', () => {
    // This is the function the prior frontend called before the contract
    // existed — now both ends line up. Regression guard.
    const { result } = renderHook(() => useLPFarming());
    act(() => result.current.exit());
    const write = wagmiMock.writeContract();
    expect(write.mock.calls[0][0]).toMatchObject({
      address: LP_FARMING_ADDRESS,
      functionName: 'exit',
    });
  });

  it('emergencyWithdraw bypasses reward claim and calls emergencyWithdraw()', () => {
    const { result } = renderHook(() => useLPFarming());
    act(() => result.current.emergencyWithdraw());
    const write = wagmiMock.writeContract();
    expect(write.mock.calls[0][0]).toMatchObject({
      address: LP_FARMING_ADDRESS,
      functionName: 'emergencyWithdraw',
    });
  });

  it('isDeployed reflects the canonical LP farming address check', () => {
    const { result } = renderHook(() => useLPFarming());
    // LP_FARMING_ADDRESS is a non-zero canonical address, so isDeployed is true.
    expect(result.current.isDeployed).toBe(true);
  });
});
