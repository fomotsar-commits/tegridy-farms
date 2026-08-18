// AUDIT F-7 — the stale-boost detector, and the reason it needs its own test.
//
// This hook existed for months and was imported by nothing. A hook nobody mounts
// is a hook nobody can prove works, so these cases pin the two things a caller
// depends on: that `needsRefresh` fires ONLY on the real mismatch (staked LP +
// confirmed JBAC + effective balance below the boosted line), and that the
// auto-fire path is gated per (wallet, JBAC count) so a declined prompt or a
// failed transaction cannot loop.
//
// The 1.4x threshold below is not arbitrary: the contract boost is 1.5x, and the
// detector deliberately sits under it so rounding never reads as "unboosted".

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';

import { useAutoRefreshBoost } from './useAutoRefreshBoost';
import { LP_FARMING_ADDRESS, CHAIN_ID } from '../lib/constants';

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const JBAC = '0xd37264c71e9af940e49795f0d3a8336afaafdda9' as const;

/** Stub the JBAC/gold balanceOf reads that useNFTBoost makes. */
function stubJbac(count: bigint): void {
  wagmiMock.addReadPredicate({
    match: (spec) => spec.functionName === 'balanceOf' && spec.address?.toLowerCase() === JBAC,
    result: count,
    status: 'success',
  });
}

function stubFarmBalances(raw: bigint, effective: bigint): void {
  wagmiMock.setReadResult({ functionName: 'rawBalanceOf', address: LP_FARMING_ADDRESS, result: raw });
  wagmiMock.setReadResult({ functionName: 'effectiveBalanceOf', address: LP_FARMING_ADDRESS, result: effective });
}

describe('useAutoRefreshBoost', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setAccount({ address: WALLET, isConnected: true });
    wagmiMock.setChainId(CHAIN_ID);
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  it('flags a refresh when a JBAC holder is staked at the unboosted rate', () => {
    stubJbac(1n);
    stubFarmBalances(100n * 10n ** 18n, 100n * 10n ** 18n); // effective == raw → no boost applied
    const { result } = renderHook(() => useAutoRefreshBoost({}));
    expect(result.current.needsRefresh).toBe(true);
    expect(result.current.rawBalance).toBe(100n * 10n ** 18n);
  });

  it('stays quiet once the boost is actually applied', () => {
    stubJbac(1n);
    stubFarmBalances(100n * 10n ** 18n, 150n * 10n ** 18n); // the contract's 1.5x
    const { result } = renderHook(() => useAutoRefreshBoost({}));
    expect(result.current.needsRefresh).toBe(false);
  });

  it('does not read rounding as a missing boost', () => {
    // Just under 1.5x but comfortably past the 1.4x detection line.
    stubJbac(1n);
    stubFarmBalances(100n * 10n ** 18n, 149n * 10n ** 18n);
    const { result } = renderHook(() => useAutoRefreshBoost({}));
    expect(result.current.needsRefresh).toBe(false);
  });

  it('stays quiet for a wallet with no JBAC — there is no boost to be missing', () => {
    stubJbac(0n);
    stubFarmBalances(100n * 10n ** 18n, 100n * 10n ** 18n);
    const { result } = renderHook(() => useAutoRefreshBoost({}));
    expect(result.current.needsRefresh).toBe(false);
  });

  it('stays quiet with nothing staked', () => {
    stubJbac(1n);
    stubFarmBalances(0n, 0n);
    const { result } = renderHook(() => useAutoRefreshBoost({}));
    expect(result.current.needsRefresh).toBe(false);
  });

  it('stays quiet on the wrong chain — an L2 read is not evidence about mainnet', () => {
    wagmiMock.setChainId(8453);
    stubJbac(1n);
    stubFarmBalances(100n * 10n ** 18n, 100n * 10n ** 18n);
    const { result } = renderHook(() => useAutoRefreshBoost({}));
    expect(result.current.needsRefresh).toBe(false);
  });

  it('never fires the callback in prompt mode, however many times it re-renders', () => {
    const onRefreshNeeded = vi.fn();
    stubJbac(1n);
    stubFarmBalances(100n * 10n ** 18n, 100n * 10n ** 18n);
    const { result, rerender } = renderHook(() => useAutoRefreshBoost({ onRefreshNeeded }));
    rerender();
    rerender();
    expect(result.current.needsRefresh).toBe(true);
    expect(onRefreshNeeded).not.toHaveBeenCalled();
  });

  it('auto mode fires exactly once per (wallet, JBAC count), not once per render', () => {
    const onRefreshNeeded = vi.fn();
    stubJbac(1n);
    stubFarmBalances(100n * 10n ** 18n, 100n * 10n ** 18n);
    const { rerender } = renderHook(() => useAutoRefreshBoost({ onRefreshNeeded, auto: true }));
    rerender();
    rerender();
    expect(onRefreshNeeded).toHaveBeenCalledTimes(1);
    expect(onRefreshNeeded).toHaveBeenCalledWith(WALLET);
  });

  it('a read-only surface can mount it with no callback at all', () => {
    stubJbac(1n);
    stubFarmBalances(100n * 10n ** 18n, 100n * 10n ** 18n);
    // auto:true with no callback must not throw — the Dashboard mounts this
    // shape for detection and has no write path to hand it.
    expect(() => renderHook(() => useAutoRefreshBoost({ auto: true }))).not.toThrow();
  });
});
