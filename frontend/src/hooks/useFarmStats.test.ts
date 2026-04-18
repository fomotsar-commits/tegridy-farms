import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';

// Controllable price mock for the PriceContext hook the farm-stats hook reads.
// Tests toggle `currentPrice.priceInUsd` before rendering the hook.
const currentPrice: { priceInUsd: number } = { priceInUsd: 0 };
vi.mock('../contexts/PriceContext', () => ({
  useTOWELIPrice: () => currentPrice,
}));

import { useFarmStats } from './useFarmStats';

const USER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;

describe('useFarmStats', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setAccount({ address: USER, isConnected: true });
    currentPrice.priceInUsd = 0;
  });

  // ───── Default / zero state ──────────────────────────────────────────

  it('returns zero-state strings when no reads are stubbed and price is 0', () => {
    const { result } = renderHook(() => useFarmStats());
    // No stub registered => useReadContracts returns failure => defaults to 0n.
    expect(result.current.tvl).toBe('0 TOWELI');
    expect(result.current.rewardsDistributed).toBe('0 TOWELI');
    expect(result.current.toweliPrice).toBe('–');
  });

  it('isDeployed is true when the staking address is non-zero', () => {
    const { result } = renderHook(() => useFarmStats());
    expect(result.current.isDeployed).toBe(true);
  });

  it('exposes a boolean isLoading field from the wagmi mock', () => {
    const { result } = renderHook(() => useFarmStats());
    expect(typeof result.current.isLoading).toBe('boolean');
    expect(result.current.isLoading).toBe(false);
  });

  // ───── TVL (totalStaked) propagation & formatting ────────────────────

  it('formats totalStaked into a locale TVL string when positive', () => {
    // 1000 TOWELI — formatWei gives "1000.0000" → Number → "1,000"
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: 1000n * 10n ** 18n });
    const { result } = renderHook(() => useFarmStats());
    expect(result.current.tvl).toBe('1,000 TOWELI');
  });

  it('formats large staked amounts with thousand separators', () => {
    // 1,234,567.89 TOWELI
    wagmiMock.setReadResult({
      functionName: 'totalStaked',
      result: 1_234_567_890_000_000_000_000_000n, // 1,234,567.89 * 10^18
    });
    const { result } = renderHook(() => useFarmStats());
    // formatWei gives "1234567.8900" → Number("1234567.89") → "1,234,567.89"
    expect(result.current.tvl).toBe('1,234,567.89 TOWELI');
  });

  it('tvl is exactly "0 TOWELI" when totalStaked is zero', () => {
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: 0n });
    const { result } = renderHook(() => useFarmStats());
    expect(result.current.tvl).toBe('0 TOWELI');
  });

  // ───── Rewards distributed (totalRewardsFunded) propagation ──────────

  it('formats totalRewardsFunded into a locale string', () => {
    wagmiMock.setReadResult({ functionName: 'totalRewardsFunded', result: 500n * 10n ** 18n });
    const { result } = renderHook(() => useFarmStats());
    expect(result.current.rewardsDistributed).toBe('500 TOWELI');
  });

  it('rewardsDistributed reflects zero when totalRewardsFunded read returns 0n', () => {
    wagmiMock.setReadResult({ functionName: 'totalRewardsFunded', result: 0n });
    const { result } = renderHook(() => useFarmStats());
    // With isDeployed=true and totalFunded=0, the hook emits the locale form
    // of "0.0000" → "0 TOWELI".
    expect(result.current.rewardsDistributed).toBe('0 TOWELI');
  });

  it('handles both reads independently (TVL + rewards together)', () => {
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: 250n * 10n ** 18n });
    wagmiMock.setReadResult({ functionName: 'totalRewardsFunded', result: 750n * 10n ** 18n });
    const { result } = renderHook(() => useFarmStats());
    expect(result.current.tvl).toBe('250 TOWELI');
    expect(result.current.rewardsDistributed).toBe('750 TOWELI');
  });

  // ───── Token price formatting ────────────────────────────────────────

  it('renders the TOWELI price via formatCurrency(price, 6) when > 0', () => {
    currentPrice.priceInUsd = 0.001234;
    const { result } = renderHook(() => useFarmStats());
    // formatCurrency with 6 decimals + value < 0.01 takes the max(6,8)=8-decimal branch.
    expect(result.current.toweliPrice).toBe('$0.00123400');
  });

  it('renders a regular currency string for prices >= 0.01', () => {
    currentPrice.priceInUsd = 1.5;
    const { result } = renderHook(() => useFarmStats());
    expect(result.current.toweliPrice).toBe('$1.500000');
  });

  it('returns "–" for toweliPrice when priceInUsd is 0 (unavailable)', () => {
    currentPrice.priceInUsd = 0;
    const { result } = renderHook(() => useFarmStats());
    expect(result.current.toweliPrice).toBe('–');
  });

  it('returns "–" for toweliPrice when priceInUsd is negative (defensive)', () => {
    currentPrice.priceInUsd = -5;
    const { result } = renderHook(() => useFarmStats());
    expect(result.current.toweliPrice).toBe('–');
  });

  // ───── Edge cases ────────────────────────────────────────────────────

  it('fractional-only totalStaked renders without a trailing TOWELI formatting glitch', () => {
    // 0.5 TOWELI — formatWei gives "0.5000" → Number("0.5000").toLocaleString() → "0.5"
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: 5n * 10n ** 17n });
    const { result } = renderHook(() => useFarmStats());
    expect(result.current.tvl).toBe('0.5 TOWELI');
  });

  it('very small totalStaked (below 4-decimal display precision) is truncated to 0 and rendered as "0 TOWELI"', () => {
    // 1 wei → formatWei(1, 18, 4) = "0.0000" → Number(..) = 0 → branch: totalStaked > 0n
    // but string becomes "0" via toLocaleString. This documents the current behaviour.
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: 1n });
    const { result } = renderHook(() => useFarmStats());
    expect(result.current.tvl).toBe('0 TOWELI');
  });

  it('failed reads (explicit failure status) also fall back to the zero-state strings', () => {
    wagmiMock.setReadResult({ functionName: 'totalStaked', status: 'failure', result: 0n });
    wagmiMock.setReadResult({ functionName: 'totalRewardsFunded', status: 'failure', result: 0n });
    const { result } = renderHook(() => useFarmStats());
    expect(result.current.tvl).toBe('0 TOWELI');
    expect(result.current.rewardsDistributed).toBe('0 TOWELI');
  });
});
