import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { parseEther } from 'viem';
import { wagmiMock } from '../test-utils/wagmi-mocks';

// Sonner mock — hook calls toast.* from multiple effects and guards; stub to no-ops.
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('../lib/explorer', () => ({ getTxUrl: () => 'https://example.test/tx' }));

import { useRestaking } from './useRestaking';
import {
  TEGRIDY_RESTAKING_ADDRESS,
  TEGRIDY_STAKING_ADDRESS,
  CHAIN_ID,
} from '../lib/constants';

const USER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;

/**
 * Helper: stub the restakers() tuple read result.
 * Struct is [tokenId, amount, boosted, lastRewardTs, rewardDebt].
 */
function stubRestaker(opts: {
  tokenId?: bigint;
  amount?: bigint;
  boosted?: bigint;
  lastRewardTs?: bigint;
  rewardDebt?: bigint;
}) {
  const tup: readonly [bigint, bigint, bigint, bigint, bigint] = [
    opts.tokenId ?? 0n,
    opts.amount ?? 0n,
    opts.boosted ?? 0n,
    opts.lastRewardTs ?? 0n,
    opts.rewardDebt ?? 0n,
  ];
  wagmiMock.setReadResult({
    functionName: 'restakers',
    address: TEGRIDY_RESTAKING_ADDRESS,
    result: tup,
  });
}

/** Stub the pendingTotal() tuple read as [base, bonus]. */
function stubPending(base: bigint, bonus: bigint) {
  wagmiMock.setReadResult({
    functionName: 'pendingTotal',
    address: TEGRIDY_RESTAKING_ADDRESS,
    result: [base, bonus] as readonly [bigint, bigint],
  });
}

describe('useRestaking', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setChainId(CHAIN_ID);
    wagmiMock.setAccount({ address: USER, isConnected: true });
  });

  // ───────────── Read-side: defaults + derived values ────────────────────

  it('defaults to zero state when no reads are stubbed', () => {
    const { result } = renderHook(() => useRestaking());
    expect(result.current.hasStakingPosition).toBe(false);
    expect(result.current.isRestaked).toBe(false);
    expect(result.current.restakedAmount).toBe(0n);
    expect(result.current.restakedBoosted).toBe(0n);
    expect(result.current.pendingBase).toBe(0n);
    expect(result.current.pendingBonus).toBe(0n);
    expect(result.current.pendingTotal).toBe(0n);
    expect(result.current.totalRestaked).toBe(0n);
    expect(result.current.totalBonusFunded).toBe(0n);
    expect(result.current.totalBonusDistributed).toBe(0n);
    expect(result.current.bonusRewardPerSecond).toBe(0n);
    expect(result.current.bonusAPR).toBe(0);
    expect(result.current.restakedFormatted).toBe(0);
    expect(result.current.pendingTotalFormatted).toBe(0);
  });

  it('hasStakingPosition is true when userTokenId > 0', () => {
    wagmiMock.setReadResult({
      functionName: 'userTokenId',
      address: TEGRIDY_STAKING_ADDRESS,
      result: 42n,
    });
    const { result } = renderHook(() => useRestaking());
    expect(result.current.hasStakingPosition).toBe(true);
  });

  it('isRestaked derives from restakers tuple[0] (tokenId) > 0', () => {
    stubRestaker({ tokenId: 7n, amount: parseEther('10'), boosted: parseEther('12') });
    const { result } = renderHook(() => useRestaking());
    expect(result.current.isRestaked).toBe(true);
    expect(result.current.restakedAmount).toBe(parseEther('10'));
    expect(result.current.restakedBoosted).toBe(parseEther('12'));
    expect(result.current.restakedFormatted).toBe(10);
  });

  it('isRestaked is false when tokenId is 0 even if other fields are non-zero', () => {
    stubRestaker({ tokenId: 0n, amount: parseEther('5') });
    const { result } = renderHook(() => useRestaking());
    expect(result.current.isRestaked).toBe(false);
  });

  it('propagates every read field from the useReadContracts batch', () => {
    wagmiMock.setReadResult({
      functionName: 'userTokenId',
      address: TEGRIDY_STAKING_ADDRESS,
      result: 3n,
    });
    stubRestaker({
      tokenId: 3n,
      amount: parseEther('100'),
      boosted: parseEther('125'),
      lastRewardTs: 111n,
      rewardDebt: 222n,
    });
    stubPending(parseEther('1'), parseEther('0.5'));
    wagmiMock.setReadResult({
      functionName: 'totalRestaked',
      address: TEGRIDY_RESTAKING_ADDRESS,
      result: parseEther('50000'),
    });
    wagmiMock.setReadResult({
      functionName: 'totalBonusFunded',
      address: TEGRIDY_RESTAKING_ADDRESS,
      result: parseEther('1000'),
    });
    wagmiMock.setReadResult({
      functionName: 'totalBonusDistributed',
      address: TEGRIDY_RESTAKING_ADDRESS,
      result: parseEther('250'),
    });
    wagmiMock.setReadResult({
      functionName: 'bonusRewardPerSecond',
      address: TEGRIDY_RESTAKING_ADDRESS,
      result: 10n ** 15n, // 0.001 per sec
    });

    const { result } = renderHook(() => useRestaking());
    expect(result.current.hasStakingPosition).toBe(true);
    expect(result.current.isRestaked).toBe(true);
    expect(result.current.restakedAmount).toBe(parseEther('100'));
    expect(result.current.restakedBoosted).toBe(parseEther('125'));
    expect(result.current.pendingBase).toBe(parseEther('1'));
    expect(result.current.pendingBonus).toBe(parseEther('0.5'));
    expect(result.current.pendingTotal).toBe(parseEther('1.5'));
    expect(result.current.pendingBaseFormatted).toBe(1);
    expect(result.current.pendingBonusFormatted).toBe(0.5);
    expect(result.current.pendingTotalFormatted).toBe(1.5);
    expect(result.current.totalRestaked).toBe(parseEther('50000'));
    expect(result.current.totalRestakedFormatted).toBe(50000);
    expect(result.current.totalBonusFunded).toBe(parseEther('1000'));
    expect(result.current.totalBonusDistributed).toBe(parseEther('250'));
    expect(result.current.bonusRewardPerSecond).toBe(10n ** 15n);
  });

  it('bonusAPR is 0 when totalRestaked is zero (division guard)', () => {
    wagmiMock.setReadResult({
      functionName: 'bonusRewardPerSecond',
      address: TEGRIDY_RESTAKING_ADDRESS,
      result: 10n ** 18n,
    });
    // No totalRestaked stub → defaults to 0n.
    const { result } = renderHook(() => useRestaking());
    expect(result.current.bonusAPR).toBe(0);
  });

  it('bonusAPR annualizes bonusRewardPerSecond against totalRestaked', () => {
    // rate = 1 token/sec → 31,536,000 tokens/yr ; pool = 31,536,000 → 100% APR.
    wagmiMock.setReadResult({
      functionName: 'bonusRewardPerSecond',
      address: TEGRIDY_RESTAKING_ADDRESS,
      result: 10n ** 18n,
    });
    wagmiMock.setReadResult({
      functionName: 'totalRestaked',
      address: TEGRIDY_RESTAKING_ADDRESS,
      result: 31_536_000n * 10n ** 18n,
    });
    const { result } = renderHook(() => useRestaking());
    expect(result.current.bonusAPR).toBeCloseTo(100, 5);
  });

  // ───────────── Action-side: restake() ──────────────────────────────────

  it('restake calls writeContract with the user tokenId', () => {
    wagmiMock.setReadResult({
      functionName: 'userTokenId',
      address: TEGRIDY_STAKING_ADDRESS,
      result: 42n,
    });
    stubRestaker({ tokenId: 0n }); // not yet restaked
    const { result } = renderHook(() => useRestaking());
    act(() => result.current.restake());
    const write = wagmiMock.writeContract();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatchObject({
      address: TEGRIDY_RESTAKING_ADDRESS,
      functionName: 'restake',
    });
    expect(write.mock.calls[0][0].args).toEqual([42n]);
  });

  it('restake blocks on wrong network', () => {
    wagmiMock.setChainId(11155111);
    wagmiMock.setReadResult({
      functionName: 'userTokenId',
      address: TEGRIDY_STAKING_ADDRESS,
      result: 42n,
    });
    const { result } = renderHook(() => useRestaking());
    act(() => result.current.restake());
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });

  it('restake is blocked when user has no staking position', () => {
    // userTokenId defaults to 0n → hasStakingPosition false
    const { result } = renderHook(() => useRestaking());
    act(() => result.current.restake());
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });

  it('restake is blocked when already restaked', () => {
    wagmiMock.setReadResult({
      functionName: 'userTokenId',
      address: TEGRIDY_STAKING_ADDRESS,
      result: 42n,
    });
    stubRestaker({ tokenId: 42n, amount: parseEther('10') });
    const { result } = renderHook(() => useRestaking());
    act(() => result.current.restake());
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });

  // ───────────── Action-side: unrestake() ────────────────────────────────

  it('unrestake calls writeContract with no args when currently restaked', () => {
    stubRestaker({ tokenId: 5n, amount: parseEther('10') });
    const { result } = renderHook(() => useRestaking());
    act(() => result.current.unrestake());
    const write = wagmiMock.writeContract();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatchObject({
      address: TEGRIDY_RESTAKING_ADDRESS,
      functionName: 'unrestake',
    });
    expect(write.mock.calls[0][0].args).toBeUndefined();
  });

  it('unrestake no-ops when not currently restaked', () => {
    const { result } = renderHook(() => useRestaking());
    act(() => result.current.unrestake());
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });

  it('unrestake blocks on wrong network', () => {
    wagmiMock.setChainId(10);
    stubRestaker({ tokenId: 5n, amount: parseEther('10') });
    const { result } = renderHook(() => useRestaking());
    act(() => result.current.unrestake());
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });

  // ───────────── Action-side: claimAll() ─────────────────────────────────

  it('claimAll calls writeContract with functionName=claimAll when rewards exist', () => {
    stubPending(parseEther('1'), parseEther('0.25'));
    const { result } = renderHook(() => useRestaking());
    act(() => result.current.claimAll());
    const write = wagmiMock.writeContract();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatchObject({
      address: TEGRIDY_RESTAKING_ADDRESS,
      functionName: 'claimAll',
    });
  });

  it('claimAll no-ops when there are no pending rewards', () => {
    stubPending(0n, 0n);
    const { result } = renderHook(() => useRestaking());
    act(() => result.current.claimAll());
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });

  it('claimAll blocks on wrong network even with rewards pending', () => {
    wagmiMock.setChainId(137);
    stubPending(parseEther('10'), 0n);
    const { result } = renderHook(() => useRestaking());
    act(() => result.current.claimAll());
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });
});
