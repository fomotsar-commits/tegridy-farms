import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { useBribes } from './useBribes';
import { VOTE_INCENTIVES_ADDRESS, TOWELI_WETH_LP_ADDRESS } from '../lib/constants';

const USER = '0xdddddddddddddddddddddddddddddddddddddddd' as `0x${string}`;

describe('useBribes', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setAccount({ address: USER, isConnected: true });
  });

  // ───── Read-side ────────────────────────────────────────────────────

  it('returns zero state when no reads are stubbed', () => {
    const { result } = renderHook(() => useBribes());
    expect(result.current.isDeployed).toBe(true); // VOTE_INCENTIVES_ADDRESS is non-zero
    expect(result.current.epochCount).toBe(0);
    expect(result.current.currentEpoch).toBe(0);
    // Default bribe fee falls back to 300 bps (3%) when read fails.
    expect(result.current.bribeFeeBps).toBe(300);
    expect(result.current.latestEpoch).toBeNull();
    expect(result.current.claimableTokens).toEqual([]);
  });

  it('propagates global stats from useReadContracts batch', () => {
    wagmiMock.setReadResult({ functionName: 'epochCount', result: 5n });
    wagmiMock.setReadResult({ functionName: 'currentEpoch', result: 4n });
    wagmiMock.setReadResult({ functionName: 'bribeFeeBps', result: 250n });

    const { result } = renderHook(() => useBribes());
    expect(result.current.epochCount).toBe(5);
    expect(result.current.currentEpoch).toBe(4);
    expect(result.current.bribeFeeBps).toBe(250);
  });

  it('latestEpoch resolves when epochs read returns a (totalPower, timestamp) tuple', () => {
    const ts = 1_700_000_000n;
    wagmiMock.setReadResult({ functionName: 'epochCount', result: 3n });
    wagmiMock.setReadResult({
      functionName: 'epochs',
      result: [100_000n, ts],
    });

    const { result } = renderHook(() => useBribes());
    expect(result.current.latestEpoch).toEqual({
      totalPower: 100_000n,
      timestamp: Number(ts),
    });
  });

  it('latestEpoch stays null when epochCount is 0', () => {
    wagmiMock.setReadResult({ functionName: 'epochCount', result: 0n });
    const { result } = renderHook(() => useBribes());
    expect(result.current.latestEpoch).toBeNull();
  });

  it('claimableTokens filters out zero-amount entries', () => {
    wagmiMock.setReadResult({ functionName: 'epochCount', result: 2n });
    // claimable returns [tokens[], amounts[]]
    wagmiMock.setReadResult({
      functionName: 'claimable',
      result: [
        [
          '0x0000000000000000000000000000000000000000', // ETH
          '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D', // TOWELI
        ],
        [5n * 10n ** 17n, 0n], // 0.5 ETH claimable, 0 TOWELI
      ],
    });

    const { result } = renderHook(() => useBribes());
    expect(result.current.claimableTokens).toHaveLength(1);
    expect(result.current.claimableTokens[0].isETH).toBe(true);
    expect(result.current.claimableTokens[0].amount).toBe(5n * 10n ** 17n);
    expect(result.current.claimableTokens[0].formatted).toBe('0.5');
  });

  it('marks ETH claimables correctly via the zero-address sentinel', () => {
    wagmiMock.setReadResult({ functionName: 'epochCount', result: 1n });
    wagmiMock.setReadResult({
      functionName: 'claimable',
      result: [
        [
          '0x0000000000000000000000000000000000000000',
          '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D',
        ],
        [1n, 2n],
      ],
    });
    const { result } = renderHook(() => useBribes());
    const eth = result.current.claimableTokens.find((t) => t.isETH);
    const toweli = result.current.claimableTokens.find((t) => !t.isETH);
    expect(eth).toBeDefined();
    expect(toweli).toBeDefined();
    expect(toweli!.token).toBe('0x420698CFdEDdEa6bc78D59bC17798113ad278F9D');
  });

  // ───── Action-side ──────────────────────────────────────────────────

  it('claimBribes writes with (epoch, pair) args', () => {
    const { result } = renderHook(() => useBribes());
    act(() => result.current.claimBribes(7, TOWELI_WETH_LP_ADDRESS));
    const call = wagmiMock.writeContract().mock.calls[0][0];
    expect(call).toMatchObject({
      address: VOTE_INCENTIVES_ADDRESS,
      functionName: 'claimBribes',
    });
    expect(call.args).toEqual([7n, TOWELI_WETH_LP_ADDRESS]);
  });

  it('claimBribesBatch writes with (start, end, pair) args', () => {
    const { result } = renderHook(() => useBribes());
    act(() => result.current.claimBribesBatch(3, 7, TOWELI_WETH_LP_ADDRESS));
    const call = wagmiMock.writeContract().mock.calls[0][0];
    expect(call).toMatchObject({
      address: VOTE_INCENTIVES_ADDRESS,
      functionName: 'claimBribesBatch',
    });
    expect(call.args).toEqual([3n, 7n, TOWELI_WETH_LP_ADDRESS]);
  });

  it('advanceEpoch writes with no args (permissionless)', () => {
    const { result } = renderHook(() => useBribes());
    act(() => result.current.advanceEpoch());
    const call = wagmiMock.writeContract().mock.calls[0][0];
    expect(call).toMatchObject({
      address: VOTE_INCENTIVES_ADDRESS,
      functionName: 'advanceEpoch',
    });
    expect(call.args).toBeUndefined();
  });

  it('depositBribeETH writes with (pair) + value=wei', () => {
    const { result } = renderHook(() => useBribes());
    const oneEth = 10n ** 18n;
    act(() => result.current.depositBribeETH(TOWELI_WETH_LP_ADDRESS, oneEth));
    const call = wagmiMock.writeContract().mock.calls[0][0];
    expect(call).toMatchObject({
      address: VOTE_INCENTIVES_ADDRESS,
      functionName: 'depositBribeETH',
    });
    expect(call.args).toEqual([TOWELI_WETH_LP_ADDRESS]);
    expect(call.value).toBe(oneEth);
  });

  // ───── Cooldown tracking ────────────────────────────────────────────

  it('cooldownRemaining is 0 when no latest epoch exists', () => {
    const { result } = renderHook(() => useBribes());
    expect(result.current.cooldownRemaining).toBe(0);
  });

  it('cooldownRemaining reflects MIN_EPOCH_INTERVAL minus elapsed time', () => {
    const now = Math.floor(Date.now() / 1000);
    const lastEpochAt = now - 600; // 10 minutes ago
    wagmiMock.setReadResult({ functionName: 'epochCount', result: 1n });
    wagmiMock.setReadResult({
      functionName: 'epochs',
      result: [0n, BigInt(lastEpochAt)],
    });

    const { result } = renderHook(() => useBribes());
    // MIN_EPOCH_INTERVAL is 3600; elapsed ~600 → remaining ~3000s
    // Allow a few-seconds tolerance for interval setup.
    expect(result.current.cooldownRemaining).toBeGreaterThan(2950);
    expect(result.current.cooldownRemaining).toBeLessThanOrEqual(3000);
  });

  it('cooldownRemaining is 0 when the epoch is older than MIN_EPOCH_INTERVAL', () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = now - 10_000; // > 1 hour ago
    wagmiMock.setReadResult({ functionName: 'epochCount', result: 1n });
    wagmiMock.setReadResult({
      functionName: 'epochs',
      result: [0n, BigInt(stale)],
    });

    const { result } = renderHook(() => useBribes());
    expect(result.current.cooldownRemaining).toBe(0);
  });
});
