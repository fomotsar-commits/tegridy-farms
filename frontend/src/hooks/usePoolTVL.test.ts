import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { parseEther } from 'viem';
import { wagmiMock } from '../test-utils/wagmi-mocks';

// PriceContext mock — controllable per test.
//
// Both ETH/USD fields are present because the real context exposes both and they
// track DIFFERENT freshness windows. usePoolTVL reads `ethUsdForDisplay` (the
// feed's own 3900s heartbeat window); `ethUsd` is the 300s swap window and is
// mocked here only so the shape matches — a test that sets `ethUsd` alone must
// NOT produce a TVL, or the hook has quietly gone back to the swap price and the
// Farm will dash out ~85% of the time again.
const currentPrice: { ethUsd: number; ethUsdForDisplay: number; priceInUsd: number; priceInEth: number } = {
  ethUsd: 0,
  ethUsdForDisplay: 0,
  priceInUsd: 0,
  priceInEth: 0,
};
vi.mock('../contexts/PriceContext', () => ({
  useTOWELIPrice: () => currentPrice,
}));

// Sonner safety net (transitive imports).
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { usePoolTVL } from './usePoolTVL';
import { TOWELI_ADDRESS, CHAIN_ID } from '../lib/constants';

/**
 * R043 (H-062-03): regression coverage for the NaN/Infinity/cap guard on
 * `tvl = wethFloat * 2 * ethUsdForDisplay`. The hook must zero-out non-finite
 * results and clamp at MAX_TVL_USD ($1T) so a flash-loan-injected reserve
 * or a corrupted oracle price can't propagate into APR/volume math.
 */
describe('usePoolTVL — H-062-03 sanity guards', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setChainId(CHAIN_ID);
    currentPrice.ethUsd = 0;
    currentPrice.ethUsdForDisplay = 0;
    currentPrice.priceInUsd = 0;
    currentPrice.priceInEth = 0;
  });

  it('returns isLoaded:false when the display price is 0 (no NaN propagation)', () => {
    // wethReserve set, but no price → guard short-circuits before the math.
    wagmiMock.setReadResult({
      functionName: 'getReserves',
      result: [parseEther('100'), parseEther('100'), 0] as const,
    });
    wagmiMock.setReadResult({ functionName: 'token0', result: TOWELI_ADDRESS });
    const { result } = renderHook(() => usePoolTVL());
    expect(result.current.isLoaded).toBe(false);
    expect(result.current.tvl).toBe(0);
  });

  it('zeros TVL when the display price is NaN (corrupted oracle)', () => {
    currentPrice.ethUsdForDisplay = Number.NaN;
    wagmiMock.setReadResult({
      functionName: 'getReserves',
      result: [parseEther('100'), parseEther('100'), 0] as const,
    });
    wagmiMock.setReadResult({ functionName: 'token0', result: TOWELI_ADDRESS });
    const { result } = renderHook(() => usePoolTVL());
    // ethUsdForDisplay<=0 (NaN <=0 is false, but the `ethUsd <= 0` short-circuit
    // also fails on NaN — we end up in the math branch but the guard kicks
    // in. Either way, tvl should be 0, never NaN.
    expect(Number.isNaN(result.current.tvl)).toBe(false);
    expect(result.current.tvl).toBe(0);
  });

  it('caps TVL at MAX_TVL_USD ($1T) when reserves * price would otherwise blow up', () => {
    // 1e30 WETH * $1 = $1e30 USD → must clamp to 1e12.
    currentPrice.ethUsdForDisplay = 1;
    // Use a reserve big enough that wethFloat * 2 * 1 exceeds 1e12 USD.
    wagmiMock.setReadResult({
      functionName: 'getReserves',
      // A very large WETH reserve (in wei) — 2e18 ETH = 2e36 wei.
      result: [parseEther('2000000000000'), parseEther('2000000000000'), 0] as const,
    });
    wagmiMock.setReadResult({ functionName: 'token0', result: TOWELI_ADDRESS });
    const { result } = renderHook(() => usePoolTVL());
    // 2e12 ETH * 2 * $1 = 4e12 USD → clamps to 1e12.
    expect(result.current.tvl).toBe(1e12);
    expect(Number.isFinite(result.current.tvl)).toBe(true);
  });

  it('computes TVL normally for sane inputs', () => {
    currentPrice.ethUsdForDisplay = 3000;
    wagmiMock.setReadResult({
      functionName: 'getReserves',
      // 100 WETH on each side
      result: [parseEther('100'), parseEther('100'), 0] as const,
    });
    wagmiMock.setReadResult({ functionName: 'token0', result: TOWELI_ADDRESS });
    const { result } = renderHook(() => usePoolTVL());
    // 100 WETH * 2 * $3000 = $600,000
    expect(result.current.tvl).toBe(600_000);
    expect(result.current.isLoaded).toBe(true);
  });

  it('prices off the DISPLAY window, not the swap window', () => {
    // The regression that dashed out the Farm. Mainnet ETH/USD publishes on a
    // 3600s heartbeat, so the 300s swap window is closed ~85% of the time and
    // `ethUsd` is 0 for most of the day. If this hook ever reads `ethUsd` again,
    // TVL / APR / 24h volume go back to rendering an em dash on a healthy feed.
    currentPrice.ethUsd = 3000;          // swap window: fresh
    currentPrice.ethUsdForDisplay = 0;   // display window: nothing usable
    wagmiMock.setReadResult({
      functionName: 'getReserves',
      result: [parseEther('100'), parseEther('100'), 0] as const,
    });
    wagmiMock.setReadResult({ functionName: 'token0', result: TOWELI_ADDRESS });
    const { result } = renderHook(() => usePoolTVL());
    // Reading the swap price here would yield $600,000.
    expect(result.current.tvl).toBe(0);
    expect(result.current.isLoaded).toBe(false);
  });

  it('renders a real TVL from a round the swap window would have rejected', () => {
    // The other direction, and the actual production case: a healthy round that
    // is simply older than 300s. `ethUsd` is 0, `ethUsdForDisplay` is not, and
    // the pool card must show a number rather than a dash.
    currentPrice.ethUsd = 0;             // swap window: closed
    currentPrice.ethUsdForDisplay = 3000; // display window: healthy
    wagmiMock.setReadResult({
      functionName: 'getReserves',
      result: [parseEther('100'), parseEther('100'), 0] as const,
    });
    wagmiMock.setReadResult({ functionName: 'token0', result: TOWELI_ADDRESS });
    const { result } = renderHook(() => usePoolTVL());
    expect(result.current.tvl).toBe(600_000);
    expect(result.current.tvlFormatted).not.toBe('–');
    expect(result.current.isLoaded).toBe(true);
  });

  it('does not branch into APR/volume math when TVL is zero', () => {
    // Sanity: a clamped/zeroed TVL must NOT produce a non-zero APR through
    // the dailyVolumeRatio fallback branch (line ~83-92 in the hook). The
    // ratio is selected from the manipulated `tvl` value — if that ever
    // leaked back in unbounded, an attacker could pick the high-side
    // bracket and inflate the displayed APR.
    currentPrice.ethUsdForDisplay = 0; // forces zero-state branch
    wagmiMock.setReadResult({
      functionName: 'getReserves',
      result: [parseEther('1'), parseEther('1'), 0] as const,
    });
    wagmiMock.setReadResult({ functionName: 'token0', result: TOWELI_ADDRESS });
    const { result } = renderHook(() => usePoolTVL());
    expect(result.current.tvl).toBe(0);
    expect(result.current.aprNum).toBe(0);
  });
});

// OUTAGE-AS-ZERO (2026-09-10): two collapses the file had no signal for.
// [4] feeBps: volume is fees ÷ rate, and a failed rate read collapsed to 0n and
// landed in the 0.3% fallback, printed as an exact figure. [2] LP totalSupply:
// collapsed to 0n, and the no-TVL early return hardcoded 0n even when it WAS
// read — TreasuryPage turned either into "0.00% of LP supply".
describe('usePoolTVL — the fee rate and the LP supply are read, not assumed', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setChainId(CHAIN_ID);
    currentPrice.ethUsd = 0;
    currentPrice.ethUsdForDisplay = 0;
  });

  /** $600,000 of TVL and `fees` of routed ETH fees, every other read landed. */
  function loadedPool(fees: bigint) {
    currentPrice.ethUsdForDisplay = 3000;
    wagmiMock.setReadResult({ functionName: 'getReserves', result: [parseEther('100'), parseEther('100'), 0] as const });
    wagmiMock.setReadResult({ functionName: 'token0', result: TOWELI_ADDRESS });
    wagmiMock.setReadResult({ functionName: 'totalSupply', result: parseEther('100') });
    wagmiMock.setReadResult({ functionName: 'totalETHFees', result: fees });
  }

  it('an unread fee RATE gives no volume — not one at an assumed 0.3%', () => {
    // OLD: feeBps 0n → `vol24h = dailyFees / 0.003`, volIsEstimated false → a
    // confident "$…" computed from a rate nobody read.
    loadedPool(parseEther('1'));
    wagmiMock.setReadResult({ functionName: 'feeBps', result: undefined, status: 'failure' });
    const { result } = renderHook(() => usePoolTVL());

    expect(result.current.feeBpsReadOk).toBe(false);
    expect(result.current.vol24hFormatted).toBe('–');
    // APR never used the rate; it is still the chain's figure.
    expect(result.current.aprIsEstimated).toBe(false);
    expect(result.current.apr).not.toBe('–');
  });

  it('a fee rate READ as 0 still gives a volume — marked as the estimate it is', () => {
    // A real 0 (applyFee accepts it) means the historical rate is off-chain, so
    // 0.3% is an assumption. OLD: printed exact. NEW: "~… (est.)".
    loadedPool(parseEther('1'));
    wagmiMock.setReadResult({ functionName: 'feeBps', result: 0n });
    const { result } = renderHook(() => usePoolTVL());

    expect(result.current.feeBpsReadOk).toBe(true);
    expect(result.current.volIsEstimated).toBe(true);
    expect(result.current.vol24hFormatted).toMatch(/^~\$.+ \(est\.\)$/);
  });

  it('a read, non-zero fee rate gives the chain\'s volume, unmarked', () => {
    // NOT DISCRIMINATING — the unchanged path; fails if the fix over-widens.
    loadedPool(parseEther('1'));
    wagmiMock.setReadResult({ functionName: 'feeBps', result: 50n });
    const { result } = renderHook(() => usePoolTVL());

    expect(result.current.volIsEstimated).toBe(false);
    expect(result.current.vol24hFormatted).toMatch(/^\$/);
  });

  it('an unread LP supply is flagged — its 0n is not a supply', () => {
    loadedPool(0n);
    wagmiMock.setReadResult({ functionName: 'totalSupply', result: undefined, status: 'failure' });
    const { result } = renderHook(() => usePoolTVL());

    expect(result.current.lpSupplyReadOk).toBe(false);
    expect(result.current.lpSupply).toBe(0n);
  });

  it('a READ LP supply survives the no-TVL path instead of being zeroed', () => {
    // No display price → the early return. OLD: `lpSupply: 0n` regardless.
    loadedPool(0n);
    currentPrice.ethUsdForDisplay = 0;
    const { result } = renderHook(() => usePoolTVL());

    expect(result.current.isLoaded).toBe(false);
    expect(result.current.lpSupplyReadOk).toBe(true);
    expect(result.current.lpSupply).toBe(parseEther('100'));
  });
});
