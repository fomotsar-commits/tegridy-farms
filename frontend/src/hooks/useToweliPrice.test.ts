import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';

// Sonner: hook doesn't call toast directly, but stub for safety in case
// transitive imports do.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// storage.safeSetItem is called inside useEffect for the baseline/cache write;
// stub to no-op so tests don't pollute real localStorage semantics.
vi.mock('../lib/storage', () => ({ safeSetItem: vi.fn() }));

import { useToweliPrice } from './useToweliPrice';
import { TOWELI_ADDRESS, TOWELI_WETH_LP_ADDRESS, ETH_USD_FEED } from '../lib/constants';

// ───────────────────────── Helpers ─────────────────────────

/** Build a valid Chainlink round tuple that passes every sanity check. */
function validChainlinkRound(ethUsdDollars: number, ageSecondsAgo = 30): readonly [bigint, bigint, bigint, bigint, bigint] {
  const now = Math.floor(Date.now() / 1000);
  const updatedAt = BigInt(now - ageSecondsAgo);
  // Chainlink ETH/USD has 8 decimals.
  const answer = BigInt(Math.round(ethUsdDollars * 1e8));
  const roundId = 100n;
  const startedAt = updatedAt;
  const answeredInRound = roundId;
  return [roundId, answer, startedAt, updatedAt, answeredInRound];
}

/**
 * Install a global fetch stub that mimics the GeckoTerminal simple-price API
 * shape. Pass priceUsd=0 to simulate "no data" (returns empty token_prices).
 */
function stubGeckoTerminalFetch(priceUsd: number): void {
  const key = TOWELI_ADDRESS.toLowerCase();
  const body =
    priceUsd > 0
      ? { data: { attributes: { token_prices: { [key]: String(priceUsd) } } } }
      : { data: { attributes: { token_prices: {} } } };
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
}

// Reserves tuple — Uniswap V2 getReserves returns [reserve0, reserve1, blockTimestampLast]
function reserves(r0: bigint, r1: bigint): readonly [bigint, bigint, number] {
  return [r0, r1, 0];
}

// Two distinct 20-byte hex addresses to represent token0/token1.
// TOWELI at 0x420698…F9D, WETH (non-TOWELI) placeholder:
const NON_TOWELI_ADDR = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const;

describe('useToweliPrice', () => {
  beforeEach(() => {
    wagmiMock.reset();
    // Default: GeckoTerminal returns nothing so it doesn't interfere with
    // on-chain-only tests. Individual tests can override.
    stubGeckoTerminalFetch(0);
    // Clear any price baseline that other tests might have left behind.
    try {
      localStorage.clear();
    } catch {}
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Zero state ────────────────────────────────────────────────────────
  it('defaults to unavailable zero state when no reads are stubbed', () => {
    const { result } = renderHook(() => useToweliPrice());
    expect(result.current.priceInEth).toBe(0);
    expect(result.current.priceInUsd).toBe(0);
    expect(result.current.ethUsd).toBe(0);
    expect(result.current.isLoaded).toBe(false);
    expect(result.current.priceUnavailable).toBe(true);
    expect(result.current.priceSafeForSwaps).toBe(false);
    expect(result.current.twapPriceInEth).toBe(0);
    expect(result.current.twapOverrideActive).toBe(false);
  });

  // 2. Happy path ────────────────────────────────────────────────────────
  it('computes priceInEth and priceInUsd from pair reserves + Chainlink', () => {
    // WETH (token0) : TOWELI (token1) = 1e18 : 1e22  →  1 TOWELI = 1e14 WETH
    //                                                          = 0.0001 WETH
    wagmiMock.setReadResult({ functionName: 'token0', result: NON_TOWELI_ADDR });
    wagmiMock.setReadResult({
      functionName: 'getReserves',
      result: reserves(10n ** 18n, 10n ** 22n),
    });
    wagmiMock.setReadResult({
      functionName: 'latestRoundData',
      address: ETH_USD_FEED,
      result: validChainlinkRound(2000),
    });

    const { result } = renderHook(() => useToweliPrice());
    expect(result.current.priceInEth).toBeCloseTo(0.0001, 10);
    expect(result.current.ethUsd).toBe(2000);
    expect(result.current.priceInUsd).toBeCloseTo(0.2, 6);
    expect(result.current.isLoaded).toBe(true);
    expect(result.current.oracleStale).toBe(false);
    expect(result.current.priceUnavailable).toBe(false);
    expect(result.current.priceSafeForSwaps).toBe(true);
  });

  // 3. oracleStale when updatedAt is too old ─────────────────────────────
  it('flips oracleStale when Chainlink updatedAt exceeds MAX_STALENESS_SECONDS', () => {
    // 400s old > 300s threshold
    wagmiMock.setReadResult({
      functionName: 'latestRoundData',
      result: validChainlinkRound(2000, 400),
    });
    const { result } = renderHook(() => useToweliPrice());
    expect(result.current.oracleStale).toBe(true);
    expect(result.current.ethUsd).toBe(0);
  });

  // 4. oracleStale when answer is out of sanity range ────────────────────
  it('flips oracleStale when Chainlink ETH/USD is below $100', () => {
    wagmiMock.setReadResult({
      functionName: 'latestRoundData',
      result: validChainlinkRound(50), // $50 < $100 min
    });
    const { result } = renderHook(() => useToweliPrice());
    expect(result.current.oracleStale).toBe(true);
  });

  it('flips oracleStale when Chainlink ETH/USD exceeds $100,000', () => {
    wagmiMock.setReadResult({
      functionName: 'latestRoundData',
      result: validChainlinkRound(200_000), // $200k > $100k max
    });
    const { result } = renderHook(() => useToweliPrice());
    expect(result.current.oracleStale).toBe(true);
  });

  // 5. oracleStale when answeredInRound < roundId ────────────────────────
  it('flips oracleStale when answeredInRound is behind roundId', () => {
    const now = Math.floor(Date.now() / 1000);
    const updatedAt = BigInt(now - 30);
    const answer = BigInt(2000 * 1e8);
    // answeredInRound (5) < roundId (10) → stale-round condition
    const tuple: [bigint, bigint, bigint, bigint, bigint] = [10n, answer, updatedAt, updatedAt, 5n];
    wagmiMock.setReadResult({ functionName: 'latestRoundData', result: tuple });
    const { result } = renderHook(() => useToweliPrice());
    expect(result.current.oracleStale).toBe(true);
  });

  // 6. TWAP override active ──────────────────────────────────────────────
  it('prefers TWAP and sets twapOverrideActive=true when spot diverges > 2%', () => {
    // Spot: 1 TOWELI = 0.0001 WETH
    wagmiMock.setReadResult({ functionName: 'token0', result: NON_TOWELI_ADDR });
    wagmiMock.setReadResult({
      functionName: 'getReserves',
      result: reserves(10n ** 18n, 10n ** 22n),
    });
    // TWAP: 1 TOWELI = 0.0002 WETH (100% divergence → well beyond 2%)
    wagmiMock.setReadResult({
      functionName: 'consult',
      result: 2n * 10n ** 14n,
    });
    wagmiMock.setReadResult({
      functionName: 'latestRoundData',
      result: validChainlinkRound(2000),
    });

    const { result } = renderHook(() => useToweliPrice());
    expect(result.current.twapPriceInEth).toBeCloseTo(0.0002, 10);
    expect(result.current.twapOverrideActive).toBe(true);
    // TWAP wins over spot
    expect(result.current.priceInEth).toBeCloseTo(0.0002, 10);
    expect(result.current.priceInUsd).toBeCloseTo(0.4, 6);
  });

  // 7. TWAP within threshold → spot used, no override ────────────────────
  it('uses spot and leaves twapOverrideActive=false when divergence is within 2%', () => {
    wagmiMock.setReadResult({ functionName: 'token0', result: NON_TOWELI_ADDR });
    wagmiMock.setReadResult({
      functionName: 'getReserves',
      result: reserves(10n ** 18n, 10n ** 22n),
    });
    // Spot = 0.0001, TWAP = 0.0001005 → 0.5% divergence < 2%
    wagmiMock.setReadResult({
      functionName: 'consult',
      result: 1_005n * 10n ** 11n, // 1.005e14
    });
    wagmiMock.setReadResult({
      functionName: 'latestRoundData',
      result: validChainlinkRound(2000),
    });

    const { result } = renderHook(() => useToweliPrice());
    expect(result.current.twapPriceInEth).toBeCloseTo(0.0001005, 10);
    expect(result.current.twapOverrideActive).toBe(false);
    expect(result.current.priceInEth).toBeCloseTo(0.0001, 10);
  });

  // 7b. No TWAP data → fallback to spot, no override ─────────────────────
  it('falls back to spot when TWAP is unavailable (consult returns 0)', () => {
    wagmiMock.setReadResult({ functionName: 'token0', result: NON_TOWELI_ADDR });
    wagmiMock.setReadResult({
      functionName: 'getReserves',
      result: reserves(10n ** 18n, 10n ** 22n),
    });
    wagmiMock.setReadResult({ functionName: 'consult', result: 0n });
    wagmiMock.setReadResult({
      functionName: 'latestRoundData',
      result: validChainlinkRound(2000),
    });

    const { result } = renderHook(() => useToweliPrice());
    expect(result.current.twapPriceInEth).toBe(0);
    expect(result.current.twapOverrideActive).toBe(false);
    expect(result.current.priceInEth).toBeCloseTo(0.0001, 10);
  });

  // 8. Token ordering correctness ────────────────────────────────────────
  it('handles TOWELI as token1 (WETH = token0) ordering correctly', () => {
    // token0 = WETH (non-TOWELI), reserves[0]=WETH, reserves[1]=TOWELI
    wagmiMock.setReadResult({ functionName: 'token0', result: NON_TOWELI_ADDR });
    wagmiMock.setReadResult({
      functionName: 'getReserves',
      result: reserves(10n ** 18n, 10n ** 22n), // 1 WETH : 10000 TOWELI
    });
    wagmiMock.setReadResult({
      functionName: 'latestRoundData',
      result: validChainlinkRound(2000),
    });
    const { result } = renderHook(() => useToweliPrice());
    // 1 WETH / 10000 TOWELI = 0.0001 WETH per TOWELI
    expect(result.current.priceInEth).toBeCloseTo(0.0001, 10);
  });

  it('handles TOWELI as token0 ordering correctly (flipped reserves)', () => {
    // token0 = TOWELI, so reserves[0]=TOWELI=1e22, reserves[1]=WETH=1e18
    wagmiMock.setReadResult({ functionName: 'token0', result: TOWELI_ADDRESS });
    wagmiMock.setReadResult({
      functionName: 'getReserves',
      result: reserves(10n ** 22n, 10n ** 18n),
    });
    wagmiMock.setReadResult({
      functionName: 'latestRoundData',
      result: validChainlinkRound(2000),
    });
    const { result } = renderHook(() => useToweliPrice());
    // Same ratio: 1 WETH / 10000 TOWELI = 0.0001 WETH per TOWELI
    expect(result.current.priceInEth).toBeCloseTo(0.0001, 10);
  });

  // 9. priceSafeForSwaps matrix ──────────────────────────────────────────
  it('priceSafeForSwaps is false when oracleStale even if priceInUsd > 0', () => {
    // Valid reserves; stale Chainlink via old updatedAt.
    wagmiMock.setReadResult({ functionName: 'token0', result: NON_TOWELI_ADDR });
    wagmiMock.setReadResult({
      functionName: 'getReserves',
      result: reserves(10n ** 18n, 10n ** 22n),
    });
    wagmiMock.setReadResult({
      functionName: 'latestRoundData',
      result: validChainlinkRound(2000, 400), // stale
    });
    const { result } = renderHook(() => useToweliPrice());
    // On-chain priceInEth still computes, but ethUsd=0 → priceInUsd=0.
    expect(result.current.priceInEth).toBeGreaterThan(0);
    expect(result.current.priceInUsd).toBe(0);
    expect(result.current.oracleStale).toBe(true);
    expect(result.current.priceSafeForSwaps).toBe(false);
  });

  it('priceSafeForSwaps is false when priceInUsd is zero', () => {
    // No reads at all → no USD.
    const { result } = renderHook(() => useToweliPrice());
    expect(result.current.priceSafeForSwaps).toBe(false);
  });

  // 10. GeckoTerminal API divergence ─────────────────────────────────────
  it('flags apiPriceDiscrepant=true and keeps on-chain price when API diverges > 1%', async () => {
    // On-chain $0.20; API $0.25 → 25% deviation, way past 1% band.
    stubGeckoTerminalFetch(0.25);
    wagmiMock.setReadResult({ functionName: 'token0', result: NON_TOWELI_ADDR });
    wagmiMock.setReadResult({
      functionName: 'getReserves',
      result: reserves(10n ** 18n, 10n ** 22n),
    });
    wagmiMock.setReadResult({
      functionName: 'latestRoundData',
      result: validChainlinkRound(2000),
    });

    const { result, rerender } = renderHook(() => useToweliPrice());
    // Let the fetch promise settle and re-render to pick up state.
    await new Promise((r) => setTimeout(r, 0));
    rerender();

    expect(result.current.apiPriceDiscrepant).toBe(true);
    expect(result.current.priceDiscrepancy).toBe(true);
    // On-chain wins: 0.0001 WETH * $2000 = $0.20, NOT the API's $0.25.
    expect(result.current.priceInUsd).toBeCloseTo(0.2, 6);
  });

  it('uses API price when within 1% of on-chain (no discrepancy flag)', async () => {
    // On-chain = $0.20, API = $0.2015 → 0.75% deviation < 1%
    stubGeckoTerminalFetch(0.2015);
    wagmiMock.setReadResult({ functionName: 'token0', result: NON_TOWELI_ADDR });
    wagmiMock.setReadResult({
      functionName: 'getReserves',
      result: reserves(10n ** 18n, 10n ** 22n),
    });
    wagmiMock.setReadResult({
      functionName: 'latestRoundData',
      result: validChainlinkRound(2000),
    });

    const { result, rerender } = renderHook(() => useToweliPrice());
    await new Promise((r) => setTimeout(r, 0));
    rerender();

    expect(result.current.apiPriceDiscrepant).toBe(false);
    expect(result.current.priceInUsd).toBeCloseTo(0.2015, 6);
  });

  // 11. Price change baseline ────────────────────────────────────────────
  it('priceChange is 0 on first render (baseline pinned, no prior price)', () => {
    wagmiMock.setReadResult({ functionName: 'token0', result: NON_TOWELI_ADDR });
    wagmiMock.setReadResult({
      functionName: 'getReserves',
      result: reserves(10n ** 18n, 10n ** 22n),
    });
    wagmiMock.setReadResult({
      functionName: 'latestRoundData',
      result: validChainlinkRound(2000),
    });
    const { result } = renderHook(() => useToweliPrice());
    expect(result.current.priceChange).toBe(0);
  });

  it('priceChange reflects delta from session baseline after rerender', () => {
    wagmiMock.setReadResult({ functionName: 'token0', result: NON_TOWELI_ADDR });
    wagmiMock.setReadResult({
      functionName: 'getReserves',
      result: reserves(10n ** 18n, 10n ** 22n), // spot = 0.0001 WETH
    });
    wagmiMock.setReadResult({
      functionName: 'latestRoundData',
      result: validChainlinkRound(2000),
    });

    const { result, rerender } = renderHook(() => useToweliPrice());
    // First render: baseline = $0.20 (set inside useEffect).
    expect(result.current.priceInUsd).toBeCloseTo(0.2, 6);

    // Bump reserves so WETH:TOWELI ratio shifts: 1.1e18 WETH : 1e22 TOWELI
    // → 1.1e-4 WETH per TOWELI → $0.22 USD → +10% vs baseline.
    wagmiMock.setReadResult({
      functionName: 'getReserves',
      result: reserves(11n * 10n ** 17n, 10n ** 22n),
    });
    rerender();
    expect(result.current.priceInUsd).toBeCloseTo(0.22, 6);
    expect(result.current.priceChange).toBeCloseTo(10, 1);
  });

  // Extra: priceUnavailable when neither source returns data ─────────────
  it('priceUnavailable reflects both on-chain-zero and API-zero', () => {
    // No reads, default fetch stub returns no price.
    const { result } = renderHook(() => useToweliPrice());
    expect(result.current.priceUnavailable).toBe(true);
  });
});
