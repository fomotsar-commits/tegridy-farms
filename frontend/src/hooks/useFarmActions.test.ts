import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { parseEther } from 'viem';
import { wagmiMock } from '../test-utils/wagmi-mocks';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));
vi.mock('../lib/analytics', () => ({ trackStake: vi.fn() }));
vi.mock('../lib/explorer', () => ({ getTxUrl: () => 'https://example.test/tx' }));

import { useFarmActions } from './useFarmActions';
import {
  TEGRIDY_STAKING_ADDRESS,
  TOWELI_ADDRESS,
  CHAIN_ID,
} from '../lib/constants';

const USER = '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}`;

describe('useFarmActions', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setChainId(CHAIN_ID);
    wagmiMock.setAccount({ address: USER, isConnected: true });
  });

  // ───── pendingEth read surface (Spartan TF-03) ──────────────────────

  it('exposes pendingEth = 0n when no read stub is registered', () => {
    const { result } = renderHook(() => useFarmActions());
    expect(result.current.pendingEth).toBe(0n);
  });

  it('propagates pendingEth from the on-chain read', () => {
    wagmiMock.setReadResult({ functionName: 'pendingETH', result: 5n * 10n ** 17n });
    const { result } = renderHook(() => useFarmActions());
    expect(result.current.pendingEth).toBe(5n * 10n ** 17n);
  });

  // ───── approve ──────────────────────────────────────────────────────

  it('approve() writes to the TOWELI contract with parsed amount', () => {
    const { result } = renderHook(() => useFarmActions());
    act(() => result.current.approve('100'));
    const call = wagmiMock.writeContract().mock.calls[0][0];
    expect(call).toMatchObject({
      address: TOWELI_ADDRESS,
      functionName: 'approve',
    });
    expect(call.args).toEqual([TEGRIDY_STAKING_ADDRESS, parseEther('100')]);
  });

  it('approve() blocks on wrong network', () => {
    wagmiMock.setChainId(11155111);
    const { result } = renderHook(() => useFarmActions());
    act(() => result.current.approve('1'));
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });

  it('approve() no-ops on blank / invalid / zero amount', () => {
    const { result } = renderHook(() => useFarmActions());
    act(() => result.current.approve(''));
    act(() => result.current.approve('0'));
    act(() => result.current.approve('-5'));
    act(() => result.current.approve('not-a-number'));
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });

  // ───── stake ────────────────────────────────────────────────────────

  it('stake() writes to TegridyStaking with parsed amount + lockDuration', () => {
    const { result } = renderHook(() => useFarmActions());
    const oneYear = 365n * 86400n;
    act(() => result.current.stake('250', oneYear));
    const call = wagmiMock.writeContract().mock.calls[0][0];
    expect(call).toMatchObject({
      address: TEGRIDY_STAKING_ADDRESS,
      functionName: 'stake',
    });
    expect(call.args).toEqual([parseEther('250'), oneYear]);
  });

  it('stake() blocks on wrong network', () => {
    wagmiMock.setChainId(10);
    const { result } = renderHook(() => useFarmActions());
    expect(() => {
      act(() => result.current.stake('10', 7n * 86400n));
    }).not.toThrow();
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });

  it('stake() throws on invalid amount', () => {
    const { result } = renderHook(() => useFarmActions());
    // parsed ≤ 0 or NaN both hit the Invalid amount branch.
    expect(() => result.current.stake('0', 86400n)).toThrow(/Invalid amount/);
    expect(() => result.current.stake('-1', 86400n)).toThrow(/Invalid amount/);
    expect(() => result.current.stake('not-a-number', 86400n)).toThrow(/Invalid amount/);
  });

  // ───── withdraw / earlyWithdraw — pendingEth guard (Spartan TF-03) ──

  it('withdraw() is blocked when pendingEth > 0 and force=false', () => {
    wagmiMock.setReadResult({ functionName: 'pendingETH', result: 10n ** 16n });
    const { result } = renderHook(() => useFarmActions());
    act(() => result.current.withdraw(42n));
    // Guard trips, no write
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });

  it('withdraw() with force=true bypasses the pendingEth guard', () => {
    wagmiMock.setReadResult({ functionName: 'pendingETH', result: 10n ** 16n });
    const { result } = renderHook(() => useFarmActions());
    act(() => result.current.withdraw(42n, true));
    const call = wagmiMock.writeContract().mock.calls[0][0];
    expect(call).toMatchObject({
      address: TEGRIDY_STAKING_ADDRESS,
      functionName: 'withdraw',
    });
    expect(call.args).toEqual([42n]);
  });

  it('withdraw() proceeds normally when pendingEth=0', () => {
    const { result } = renderHook(() => useFarmActions());
    act(() => result.current.withdraw(1n));
    expect(wagmiMock.writeContract()).toHaveBeenCalledTimes(1);
  });

  it('earlyWithdraw() shares the pendingEth guard with withdraw()', () => {
    wagmiMock.setReadResult({ functionName: 'pendingETH', result: 1n });
    const { result } = renderHook(() => useFarmActions());
    act(() => result.current.earlyWithdraw(7n));
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();

    act(() => result.current.earlyWithdraw(7n, true));
    const call = wagmiMock.writeContract().mock.calls[0][0];
    expect(call).toMatchObject({ functionName: 'earlyWithdraw' });
    expect(call.args).toEqual([7n]);
  });

  // ───── emergencyExit — same guard ───────────────────────────────────

  it('emergencyExit() is guarded + uses emergencyExitPosition', () => {
    wagmiMock.setReadResult({ functionName: 'pendingETH', result: 1n });
    const { result } = renderHook(() => useFarmActions());
    act(() => result.current.emergencyExit(9n));
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();

    act(() => result.current.emergencyExit(9n, true));
    const call = wagmiMock.writeContract().mock.calls[0][0];
    expect(call).toMatchObject({
      address: TEGRIDY_STAKING_ADDRESS,
      functionName: 'emergencyExitPosition',
    });
    expect(call.args).toEqual([9n]);
  });

  // ───── other actions ────────────────────────────────────────────────

  it('claim() calls getReward with tokenId', () => {
    const { result } = renderHook(() => useFarmActions());
    act(() => result.current.claim(123n));
    const call = wagmiMock.writeContract().mock.calls[0][0];
    expect(call).toMatchObject({
      address: TEGRIDY_STAKING_ADDRESS,
      functionName: 'getReward',
    });
    expect(call.args).toEqual([123n]);
  });

  it('toggleAutoMaxLock() passes tokenId through', () => {
    const { result } = renderHook(() => useFarmActions());
    act(() => result.current.toggleAutoMaxLock(77n));
    const call = wagmiMock.writeContract().mock.calls[0][0];
    expect(call).toMatchObject({ functionName: 'toggleAutoMaxLock' });
    expect(call.args).toEqual([77n]);
  });

  it('extendLock() passes both args', () => {
    const { result } = renderHook(() => useFarmActions());
    act(() => result.current.extendLock(5n, 730n * 86400n));
    const call = wagmiMock.writeContract().mock.calls[0][0];
    expect(call).toMatchObject({ functionName: 'extendLock' });
    expect(call.args).toEqual([5n, 730n * 86400n]);
  });

  it('claimUnsettled() fires no-arg call', () => {
    const { result } = renderHook(() => useFarmActions());
    act(() => result.current.claimUnsettled());
    const call = wagmiMock.writeContract().mock.calls[0][0];
    expect(call).toMatchObject({ functionName: 'claimUnsettled' });
    expect(call.args).toBeUndefined();
  });

  it('revalidateBoost() passes tokenId', () => {
    const { result } = renderHook(() => useFarmActions());
    act(() => result.current.revalidateBoost(99n));
    const call = wagmiMock.writeContract().mock.calls[0][0];
    expect(call).toMatchObject({ functionName: 'revalidateBoost' });
    expect(call.args).toEqual([99n]);
  });

  // ───── network-gate coverage on the rest ────────────────────────────

  it('every write action respects the chainId guard', () => {
    wagmiMock.setChainId(56); // BNB
    const { result } = renderHook(() => useFarmActions());
    act(() => result.current.withdraw(1n, true));
    act(() => result.current.earlyWithdraw(1n, true));
    act(() => result.current.claim(1n));
    act(() => result.current.toggleAutoMaxLock(1n));
    act(() => result.current.extendLock(1n, 86400n));
    act(() => result.current.emergencyExit(1n, true));
    act(() => result.current.claimUnsettled());
    act(() => result.current.revalidateBoost(1n));
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });
});
