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
import { toast } from 'sonner';
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

  // OUTAGE-AS-ZERO. An unstubbed read is a read that did not land, and 0n was
  // precisely the value telling pendingEthGuard there was nothing to forfeit.
  it('exposes pendingEth = null when no read stub is registered', () => {
    const { result } = renderHook(() => useFarmActions());
    expect(result.current.pendingEth).toBeNull();
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

  it('stake() soft-fails on invalid amount (toast, no throw, no write) — F484', () => {
    const { result } = renderHook(() => useFarmActions());
    vi.mocked(toast.error).mockClear();
    // F484: parsed ≤ 0 or NaN now toast + return instead of throwing — a throw
    // on an onClick path would nuke the ErrorBoundary (matches approve()).
    for (const bad of ['0', '-1', 'not-a-number']) {
      expect(() => act(() => result.current.stake(bad, 86400n))).not.toThrow();
    }
    expect(toast.error).toHaveBeenCalledWith('Invalid amount');
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
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

  it('withdraw() proceeds normally on a successful on-chain pendingEth of 0', () => {
    // Re-pointed at an explicit 0n. This previously used an UNSTUBBED read as its
    // stand-in for a zero balance - the exact conflation the guard now refuses.
    // A genuine zero must still withdraw with no extra click and no toast.
    wagmiMock.setReadResult({ functionName: 'pendingETH', result: 0n });
    const { result } = renderHook(() => useFarmActions());
    act(() => result.current.withdraw(1n));
    expect(wagmiMock.writeContract()).toHaveBeenCalledTimes(1);
  });

  // ───── unread pendingEth fails CLOSED (incident 2026-09-04) ─────────

  it('withdraw() is blocked when pendingEth could not be read', () => {
    // No stub === the read never landed. This collapsed to 0n, and the guard
    // waved the withdraw through, forfeiting the user's unclaimed ETH revenue.
    const { result } = renderHook(() => useFarmActions());
    act(() => result.current.withdraw(42n));
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });

  it('force=true does NOT bypass an unread pendingEth', () => {
    // force is the user overriding a figure they have been shown. On an unread
    // balance there is no figure, so there is nothing to consent to.
    const { result } = renderHook(() => useFarmActions());
    act(() => result.current.withdraw(42n, true));
    act(() => result.current.earlyWithdraw(7n, true));
    act(() => result.current.emergencyExit(9n, true));
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });

  it('the unread refusal does not present itself as a zero balance', () => {
    vi.mocked(toast.error).mockClear();
    const { result } = renderHook(() => useFarmActions());
    act(() => result.current.withdraw(42n));
    const msg = String(vi.mocked(toast.error).mock.calls[0][0]);
    expect(msg).toMatch(/could not be read/i);
    expect(msg).toMatch(/not a statement that you have none/i);
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
