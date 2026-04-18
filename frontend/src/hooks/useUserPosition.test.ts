import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';
import { useUserPosition } from './useUserPosition';

const USER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as `0x${string}`;

describe('useUserPosition', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setAccount({ address: USER, isConnected: true });
  });

  // ───── Disconnected / zero state ────────────────────────────────────

  it('returns zero state when no reads are stubbed', () => {
    const { result } = renderHook(() => useUserPosition());
    expect(result.current.tokenId).toBe(0n);
    expect(result.current.hasPosition).toBe(false);
    expect(result.current.stakedAmount).toBe(0n);
    expect(result.current.pendingReward).toBe(0n);
    expect(result.current.walletBalance).toBe(0n);
    expect(result.current.allowance).toBe(0n);
    expect(result.current.boostBps).toBe(0);
    expect(result.current.boostMultiplier).toBe(0);
    expect(result.current.isLocked).toBe(false);
    expect(result.current.canWithdraw).toBe(false);
    expect(result.current.autoMaxLock).toBe(false);
    expect(result.current.isPaused).toBe(false);
    expect(result.current.isDeployed).toBe(true);
  });

  it('formats zero bigints as "0" strings (safe for display)', () => {
    const { result } = renderHook(() => useUserPosition());
    expect(result.current.stakedFormatted).toBe('0');
    expect(result.current.pendingFormatted).toBe('0');
    expect(result.current.walletBalanceFormatted).toBe('0');
    expect(result.current.unsettledFormatted).toBe('0');
  });

  // ───── Reads batch 1: tokenId / balance / allowance / paused / unsettled ──

  it('propagates wallet balance + allowance from ERC-20 reads', () => {
    wagmiMock.setReadResult({ functionName: 'balanceOf', result: 500n * 10n ** 18n });
    wagmiMock.setReadResult({ functionName: 'allowance', result: 100n * 10n ** 18n });
    const { result } = renderHook(() => useUserPosition());
    expect(result.current.walletBalance).toBe(500n * 10n ** 18n);
    expect(result.current.allowance).toBe(100n * 10n ** 18n);
    expect(result.current.walletBalanceFormatted).toBe('500');
  });

  it('propagates paused + unsettledRewards from staking reads', () => {
    wagmiMock.setReadResult({ functionName: 'paused', result: true });
    wagmiMock.setReadResult({ functionName: 'unsettledRewards', result: 3n * 10n ** 17n });
    const { result } = renderHook(() => useUserPosition());
    expect(result.current.isPaused).toBe(true);
    expect(result.current.unsettledRewards).toBe(3n * 10n ** 17n);
    expect(result.current.unsettledFormatted).toBe('0.3');
  });

  it('tokenId surfaces from userTokenId read', () => {
    wagmiMock.setReadResult({ functionName: 'userTokenId', result: 42n });
    const { result } = renderHook(() => useUserPosition());
    expect(result.current.tokenId).toBe(42n);
  });

  // ───── Reads batch 2: getPosition + earned (gated on tokenId > 0) ────

  it('does NOT populate position data when tokenId is 0', () => {
    // No getPosition stub — with tokenId=0 the hook's enabled flag on the
    // second useReadContracts call gates the read. Combined with the
    // hasPosition derivation being tokenId>0 && stakedAmount>0, this
    // verifies the "new user / no position" case.
    wagmiMock.setReadResult({ functionName: 'userTokenId', result: 0n });
    const { result } = renderHook(() => useUserPosition());
    expect(result.current.hasPosition).toBe(false);
    expect(result.current.stakedAmount).toBe(0n);
  });

  it('populates position details when tokenId > 0 and getPosition returns data', () => {
    const lockEnd = Math.floor(Date.now() / 1000) + 365 * 86400; // 1 year out
    wagmiMock.setReadResult({ functionName: 'userTokenId', result: 7n });
    wagmiMock.setReadResult({
      functionName: 'getPosition',
      // [amount, boostBps, lockEnd, lockDuration, autoMaxLock, canWithdraw]
      result: [
        1000n * 10n ** 18n, // 1000 TOWELI
        25000n,             // 2.5× boost
        BigInt(lockEnd),
        BigInt(365 * 86400),
        true,
        false,
      ],
    });
    wagmiMock.setReadResult({ functionName: 'earned', result: 5n * 10n ** 18n });

    const { result } = renderHook(() => useUserPosition());
    expect(result.current.hasPosition).toBe(true);
    expect(result.current.stakedAmount).toBe(1000n * 10n ** 18n);
    expect(result.current.stakedFormatted).toBe('1000');
    expect(result.current.boostBps).toBe(25000);
    expect(result.current.boostMultiplier).toBe(2.5);
    expect(result.current.lockEnd).toBe(lockEnd);
    expect(result.current.lockDuration).toBe(365 * 86400);
    expect(result.current.autoMaxLock).toBe(true);
    expect(result.current.canWithdraw).toBe(false);
    expect(result.current.isLocked).toBe(true);
    expect(result.current.pendingReward).toBe(5n * 10n ** 18n);
    expect(result.current.pendingFormatted).toBe('5');
  });

  it('isLocked flips false once lockEnd has passed', () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    wagmiMock.setReadResult({ functionName: 'userTokenId', result: 1n });
    wagmiMock.setReadResult({
      functionName: 'getPosition',
      result: [1n, 10000n, BigInt(past), 0n, false, true],
    });
    const { result } = renderHook(() => useUserPosition());
    expect(result.current.isLocked).toBe(false);
    expect(result.current.canWithdraw).toBe(true);
  });

  it('hasPosition requires both tokenId > 0 AND stakedAmount > 0', () => {
    // tokenId exists but position reports 0 stakedAmount (pathological state).
    wagmiMock.setReadResult({ functionName: 'userTokenId', result: 1n });
    wagmiMock.setReadResult({
      functionName: 'getPosition',
      result: [0n, 0n, 0n, 0n, false, true],
    });
    const { result } = renderHook(() => useUserPosition());
    expect(result.current.hasPosition).toBe(false);
  });

  // ───── needsApproval predicate ──────────────────────────────────────

  it('needsApproval() — false when allowance >= required', () => {
    wagmiMock.setReadResult({ functionName: 'balanceOf', result: 1000n });
    wagmiMock.setReadResult({ functionName: 'allowance', result: 2000n });
    const { result } = renderHook(() => useUserPosition());
    expect(result.current.needsApproval()).toBe(false);
    expect(result.current.needsApproval(500n)).toBe(false);
  });

  it('needsApproval() — true when allowance < required', () => {
    wagmiMock.setReadResult({ functionName: 'balanceOf', result: 1000n });
    wagmiMock.setReadResult({ functionName: 'allowance', result: 500n });
    const { result } = renderHook(() => useUserPosition());
    expect(result.current.needsApproval()).toBe(true);
    expect(result.current.needsApproval(700n)).toBe(true);
  });

  it('needsApproval() — false when required is zero', () => {
    wagmiMock.setReadResult({ functionName: 'balanceOf', result: 0n });
    wagmiMock.setReadResult({ functionName: 'allowance', result: 0n });
    const { result } = renderHook(() => useUserPosition());
    expect(result.current.needsApproval()).toBe(false);
    expect(result.current.needsApproval(0n)).toBe(false);
  });

  it('needsApproval() explicit amount overrides walletBalance default', () => {
    wagmiMock.setReadResult({ functionName: 'balanceOf', result: 10_000n });
    wagmiMock.setReadResult({ functionName: 'allowance', result: 100n });
    const { result } = renderHook(() => useUserPosition());
    // Requesting a small amount within allowance → no approval needed.
    expect(result.current.needsApproval(50n)).toBe(false);
    // Exceeding allowance → approval needed.
    expect(result.current.needsApproval(5_000n)).toBe(true);
  });

  // ───── boost multiplier math ────────────────────────────────────────

  it('boostMultiplier divides boostBps by 10000', () => {
    wagmiMock.setReadResult({ functionName: 'userTokenId', result: 1n });
    wagmiMock.setReadResult({
      functionName: 'getPosition',
      result: [1n, 45000n, 0n, 0n, false, false],
    });
    const { result } = renderHook(() => useUserPosition());
    expect(result.current.boostMultiplier).toBe(4.5);
  });

  it('boostMultiplier stays 0 when boostBps is 0 (no position)', () => {
    const { result } = renderHook(() => useUserPosition());
    expect(result.current.boostMultiplier).toBe(0);
  });
});
