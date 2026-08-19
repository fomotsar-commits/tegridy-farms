import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Address } from 'viem';
import { wagmiMock } from '../test-utils/wagmi-mocks';

/**
 * The rail is undeployed today, so the interesting behaviour — what happens to the
 * availability flags once there IS a view to read — would be unreachable without this.
 * The address is overridden so the deployed path is the path under test; everything
 * else in constants stays real.
 */
vi.mock('../lib/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/constants')>();
  // Inline literal, not a module-level const: `vi.mock` is hoisted above every
  // top-level binding in this file.
  return { ...actual, LAUNCH_LOCK_VIEW_ADDRESS: '0x00000000000000000000000000000000000000ff' };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { useVestingLockView } from './useVestingLockView';

const TOKEN = '0x1111111111111111111111111111111111111111' as Address;

function snapshotResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    vestingSourceAvailable: true,
    lockSourceAvailable: true,
    vestedInflow: 1000n,
    vestingWalletCount: 2n,
    lockedTotal: 500n,
    lockedScanned: 500n,
    earliestUnlockAt: 1_800_000_000n,
    latestUnlockAt: 1_900_000_000n,
    activeLockCount: 3n,
    nextLockOffset: 0n,
    ...overrides,
  };
}

describe('useVestingLockView keeps "unavailable" apart from "zero"', () => {
  beforeEach(() => wagmiMock.reset());

  it('passes both availability flags through untouched', () => {
    wagmiMock.setReadResult({ functionName: 'snapshot', result: snapshotResult() });
    const { result } = renderHook(() => useVestingLockView(TOKEN));
    expect(result.current.snapshot?.vestingSourceAvailable).toBe(true);
    expect(result.current.snapshot?.lockSourceAvailable).toBe(true);
    expect(result.current.snapshot?.lockedTotal).toBe(500n);
  });

  it('keeps a false flag false even though its numbers arrive as zeros', () => {
    // This is the shape the contract emits for an unset or reverting rail: the flag is
    // false and every number beside it is zero because nothing was read. The hook must
    // not "helpfully" report lockedTotal 0 as a fact.
    wagmiMock.setReadResult({
      functionName: 'snapshot',
      result: snapshotResult({
        lockSourceAvailable: false,
        lockedTotal: 0n,
        lockedScanned: 0n,
        earliestUnlockAt: 0n,
        latestUnlockAt: 0n,
        activeLockCount: 0n,
      }),
    });
    const { result } = renderHook(() => useVestingLockView(TOKEN));
    expect(result.current.snapshot?.lockSourceAvailable).toBe(false);
    expect(result.current.snapshot?.vestingSourceAvailable).toBe(true);
  });

  it('reports an available rail that genuinely holds nothing as available', () => {
    // The counterweight: a true flag with zeros is a real answer and must stay one,
    // or the viewer would render every empty token as an outage.
    wagmiMock.setReadResult({
      functionName: 'snapshot',
      result: snapshotResult({ lockedTotal: 0n, activeLockCount: 0n, earliestUnlockAt: 0n, latestUnlockAt: 0n }),
    });
    const { result } = renderHook(() => useVestingLockView(TOKEN));
    expect(result.current.snapshot?.lockSourceAvailable).toBe(true);
    expect(result.current.snapshot?.lockedTotal).toBe(0n);
  });

  it('returns a null snapshot and readFailed when the view itself does not answer', () => {
    wagmiMock.setReadResult({ functionName: 'snapshot', result: undefined, status: 'failure' });
    const { result } = renderHook(() => useVestingLockView(TOKEN));
    expect(result.current.snapshot).toBeNull();
    expect(result.current.readFailed).toBe(true);
  });

  it('does not claim a failed read when nothing was queried', () => {
    const { result } = renderHook(() => useVestingLockView(null));
    expect(result.current.snapshot).toBeNull();
    expect(result.current.readFailed).toBe(false);
  });

  it('surfaces a truncated scan through nextLockOffset', () => {
    wagmiMock.setReadResult({ functionName: 'snapshot', result: snapshotResult({ nextLockOffset: 64n }) });
    const { result } = renderHook(() => useVestingLockView(TOKEN));
    expect(result.current.snapshot?.nextLockOffset).toBe(64);
  });
});
