import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';

// Sonner: hook doesn't call toast directly, but stub for safety in case
// transitive imports do.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// AUDIT (Wave-2 2026-05-20): mock the full surface the hook actually imports.
// `safeGetItem` + `safeJsonParse` were added to the hook's versioned-cache read
// after this mock was first written; without them the test fails at module
// load with "No safeGetItem export defined on storage mock".
vi.mock('../lib/storage', () => ({
  safeSetItem: vi.fn(),
  safeGetItem: vi.fn().mockReturnValue(null),
  safeJsonParse: <T,>(_str: unknown, fallback: T) => fallback,
}));

import {
  useToweliPrice,
  evaluateEthUsdFeed,
  reservesSupportPricing,
  MIN_PRICEABLE_WETH_RESERVE,
  type ChainlinkRound,
} from './useToweliPrice';
import { TOWELI_ADDRESS, ETH_USD_FEED } from '../lib/constants';

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
    } catch { /* ignore */ }
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
      result: reserves(10n ** 20n, 10n ** 24n),
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

  // 2b. The drained pool must not price the site ────────────────────────
  it('does not price from a pool too thin to price against, and says so', () => {
    // The LIVE reserves, read on-chain 2026-08-01: 146,258 TOWELI + 0.00383 WETH.
    // Before the floor, this fed `priceInUsd` site-wide with its only manipulation
    // guard (TWAP `consult()`) already reverting `ReservesBelowFloor`.
    stubGeckoTerminalFetch(0);
    wagmiMock.setReadResult({ functionName: 'token0', result: NON_TOWELI_ADDR });
    wagmiMock.setReadResult({
      functionName: 'getReserves',
      result: reserves(3_830_891_242_585_222n, 146_258_413_709_023_551_111_936n),
    });
    wagmiMock.setReadResult({
      functionName: 'latestRoundData',
      address: ETH_USD_FEED,
      result: validChainlinkRound(2000),
    });

    const { result } = renderHook(() => useToweliPrice());
    // Nothing was priced from the pair, and the hook admits it rather than
    // publishing a figure ten dollars can move.
    expect(result.current.pairTooThinToPrice).toBe(true);
    expect(result.current.priceInEth).toBe(0);
    expect(result.current.priceInUsd).toBe(0);
    expect(result.current.priceUnavailable).toBe(true);
    expect(result.current.priceSafeForSwaps).toBe(false);
    // A spot reconstructed from refused reserves is not evidence of a TWAP override.
    expect(result.current.twapOverrideActive).toBe(false);
  });

  it('lets the API leg answer for a thin pair, and derives the ETH leg from it', async () => {
    // `LendingSection` multiplies a TOWELI amount by `priceInEth` and self-gates only
    // on `priceUnavailable` — false here, because the API is answering. A zero
    // `priceInEth` would render collateral worth "0 ETH", so the cross-rate is
    // derived from two reads we actually made rather than left at zero.
    stubGeckoTerminalFetch(0.2);
    wagmiMock.setReadResult({ functionName: 'token0', result: NON_TOWELI_ADDR });
    wagmiMock.setReadResult({
      functionName: 'getReserves',
      result: reserves(3_830_891_242_585_222n, 146_258_413_709_023_551_111_936n),
    });
    wagmiMock.setReadResult({
      functionName: 'latestRoundData',
      address: ETH_USD_FEED,
      result: validChainlinkRound(2000),
    });

    const { result, rerender } = renderHook(() => useToweliPrice());
    // Let the fetch promise settle and re-render to pick up state.
    await new Promise((r) => setTimeout(r, 0));
    rerender();

    expect(result.current.pairTooThinToPrice).toBe(true);
    expect(result.current.priceInUsd).toBeCloseTo(0.2, 6);
    expect(result.current.priceInEth).toBeCloseTo(0.0001, 10); // 0.2 USD / 2000 USD-per-ETH
    expect(result.current.priceUnavailable).toBe(false);
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

  // 3b. ethUsdForDisplay survives the swap window ────────────────────────
  it('keeps a display price when the round is older than the 300s SWAP window', () => {
    // 940s is what the live mainnet feed actually read on 2026-09-03 — a
    // perfectly healthy round on a 3600s heartbeat. Under the swap window alone
    // this became ethUsd = 0, and every USD figure on the Farm rendered as a
    // dash. This is THE regression to keep out: if ethUsdForDisplay ever goes to
    // 0 here, the pool card silently dashes out again.
    wagmiMock.setReadResult({
      functionName: 'latestRoundData',
      result: validChainlinkRound(2000, 940),
    });
    const { result } = renderHook(() => useToweliPrice());
    expect(result.current.ethUsdForDisplay).toBe(2000);
    // The swap window and the staleness flag are deliberately UNCHANGED — this
    // must not become a backdoor that loosens swap pricing.
    expect(result.current.ethUsd).toBe(0);
    expect(result.current.oracleStale).toBe(true);
  });

  it('drops the display price once the feed misses its own heartbeat', () => {
    // 4000s > MAX_LAUNCH_STALENESS_SECONDS (3900). Past the feed's own liveness
    // definition, a dash is the honest output.
    wagmiMock.setReadResult({
      functionName: 'latestRoundData',
      result: validChainlinkRound(2000, 4000),
    });
    const { result } = renderHook(() => useToweliPrice());
    expect(result.current.ethUsdForDisplay).toBe(0);
  });

  it('refuses an out-of-band answer for display even when it is fresh', () => {
    // Display is stricter than `ethUsd` here on purpose: `ethUsd` has never
    // required the sanity band, but an absurd price must not reach a dollar
    // figure on screen.
    wagmiMock.setReadResult({
      functionName: 'latestRoundData',
      result: validChainlinkRound(50, 10), // $50, fresh
    });
    const { result } = renderHook(() => useToweliPrice());
    expect(result.current.ethUsdForDisplay).toBe(0);
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
      result: reserves(10n ** 20n, 10n ** 24n),
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
      result: reserves(10n ** 20n, 10n ** 24n),
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
      result: reserves(10n ** 20n, 10n ** 24n),
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
      result: reserves(10n ** 20n, 10n ** 24n), // 100 WETH : 1,000,000 TOWELI — same ratio, above the pricing floor
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
      result: reserves(10n ** 24n, 10n ** 20n),
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
      result: reserves(10n ** 20n, 10n ** 24n),
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
      result: reserves(10n ** 20n, 10n ** 24n),
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
      result: reserves(10n ** 20n, 10n ** 24n),
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
      result: reserves(10n ** 20n, 10n ** 24n),
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
      result: reserves(10n ** 20n, 10n ** 24n), // spot = 0.0001 WETH
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
      result: reserves(11n * 10n ** 19n, 10n ** 24n),
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

  // R080: the API leg is untrusted input to the site-wide display price ───
  //
  // This hook is the API leg's ONLY consumer, and with the native pair below
  // its pricing floor the API leg is frequently the only source answering — so
  // whatever survives this fetch is what the whole site shows. Until the schema
  // was applied here, the value was read with optional chaining and handed to
  // parseFloat: a number, a scientific-notation string, or a nested object all
  // walked straight through. These cases pin refusal.

  /** Stub GeckoTerminal with a literal body, valid or not. */
  function stubRawFetch(body: unknown): void {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(body),
    }) as unknown as typeof fetch;
  }

  const KEY = TOWELI_ADDRESS.toLowerCase();

  it('accepts the documented shape — the control for the refusals below', async () => {
    stubRawFetch({ data: { attributes: { token_prices: { [KEY]: '0.2' } } } });
    const { result, rerender } = renderHook(() => useToweliPrice());
    await new Promise((r) => setTimeout(r, 0));
    rerender();
    expect(result.current.priceInUsd).toBeCloseTo(0.2, 6);
    expect(result.current.priceUnavailable).toBe(false);
  });

  it('refuses a malformed price payload instead of pricing the site from it', async () => {
    const hostile: unknown[] = [
      // Number where the API documents a string — parseFloat would have taken it.
      { data: { attributes: { token_prices: { [KEY]: 0.2 } } } },
      // Scientific notation: Number() loses precision on the tail.
      { data: { attributes: { token_prices: { [KEY]: '2e-7' } } } },
      // Envelope drift / a proxy returning someone else's JSON.
      { token_prices: { [KEY]: '0.2' } },
      { data: { attributes: { token_prices: [['0.2']] } } },
      { data: null },
      'not json at all',
    ];
    for (const body of hostile) {
      stubRawFetch(body);
      const { result, rerender } = renderHook(() => useToweliPrice());
      await new Promise((r) => setTimeout(r, 0));
      rerender();
      // No on-chain reads are stubbed either, so the honest answer is "no price".
      expect(result.current.priceInUsd).toBe(0);
      expect(result.current.priceUnavailable).toBe(true);
    }
  });

  it('a refused payload never overwrites the on-chain price with a zero', async () => {
    // The failure that matters: an outage reading as a legitimate low value.
    stubRawFetch({ data: { attributes: { token_prices: { [KEY]: 'free' } } } });
    wagmiMock.setReadResult({ functionName: 'token0', result: NON_TOWELI_ADDR });
    wagmiMock.setReadResult({
      functionName: 'getReserves',
      result: reserves(10n ** 20n, 10n ** 24n),
    });
    wagmiMock.setReadResult({
      functionName: 'latestRoundData',
      address: ETH_USD_FEED,
      result: validChainlinkRound(2000),
    });

    const { result, rerender } = renderHook(() => useToweliPrice());
    await new Promise((r) => setTimeout(r, 0));
    rerender();

    expect(result.current.priceInUsd).toBeCloseTo(0.2, 6);
    expect(result.current.apiPriceDiscrepant).toBe(false);
  });
});

// ─────────── Launch-path freshness window (pure, no React) ───────────
//
// Mainnet ETH/USD (0x5f4eC3Df…8419) publishes on a ~3600s heartbeat plus a 0.5%-deviation
// trigger. The SWAP path deliberately demands a 300s-fresh round; the LAUNCH path must not,
// or it refuses against a perfectly healthy oracle. Measured over 40 consecutive rounds
// (~25.5h): every inter-round gap exceeded 300s and the tight gate was shut ~85% of
// wallclock — /launch refused roughly 6 attempts in 7 for no protective reason.
//
// These pin BOTH windows. Widening the swap window or narrowing the launch window fails here.

describe('evaluateEthUsdFeed — swap vs launch freshness windows', () => {
  const PRICE = 1913_41000000n; // $1913.41, 8 decimals
  const AT = 1_785_421_115; // a real observed updatedAt (2026-07-30)

  /** A well-formed round at `updatedAt`. */
  const round = (
    updatedAt: number,
    answer = PRICE,
    answeredInRound = 7n,
    roundId = 7n,
  ): ChainlinkRound => [roundId, answer, BigInt(updatedAt), BigInt(updatedAt), answeredInRound];

  it('a fresh round satisfies both paths', () => {
    const r = evaluateEthUsdFeed(round(AT), AT + 60);
    expect(r.ethUsd).toBeCloseTo(1913.41, 2);
    expect(r.ethUsdForLaunch).toBeCloseTo(1913.41, 2);
    expect(r.oracleStale).toBe(false);
  });

  it('THE FIX: a round past the 300s swap window still prices a LAUNCH', () => {
    // The exact live condition measured on 2026-07-30: age 2028s, feed healthy.
    const r = evaluateEthUsdFeed(round(AT), AT + 2028);
    expect(r.ethUsd).toBe(0); // swaps correctly refuse
    expect(r.oracleStale).toBe(true);
    // Pre-fix, LaunchPage read `ethUsd` here and hard-refused with
    // "ETH price unavailable right now" — the defect this test exists to prevent.
    expect(r.ethUsdForLaunch).toBeCloseTo(1913.41, 2);
  });

  it('holds up to the heartbeat, refuses once the feed itself is genuinely late', () => {
    expect(evaluateEthUsdFeed(round(AT), AT + 3899).ethUsdForLaunch).toBeGreaterThan(0);
    expect(evaluateEthUsdFeed(round(AT), AT + 3901).ethUsdForLaunch).toBe(0);
  });

  it('the two windows stay distinct — neither collapses into the other', () => {
    const midband = evaluateEthUsdFeed(round(AT), AT + 1800);
    expect(midband.ethUsd).toBe(0);
    expect(midband.ethUsdForLaunch).toBeGreaterThan(0);
  });

  it('refuses a launch on an out-of-band price even when perfectly fresh', () => {
    // The auction curve is priced off this number — a bad one is worse than none.
    for (const bad of [50_00000000n, 250000_00000000n]) {
      const r = evaluateEthUsdFeed(round(AT, bad), AT + 10);
      expect(r.ethUsdForLaunch).toBe(0);
      expect(r.oracleStale).toBe(true);
    }
  });

  it('refuses a launch on a malformed round', () => {
    expect(evaluateEthUsdFeed(round(AT, PRICE, 6n, 7n), AT + 10).ethUsdForLaunch).toBe(0); // answeredInRound < roundId
    expect(evaluateEthUsdFeed(round(AT, 0n), AT + 10).ethUsdForLaunch).toBe(0); // zero answer
    expect(evaluateEthUsdFeed(round(0), AT + 10).ethUsdForLaunch).toBe(0); // never updated
    expect(evaluateEthUsdFeed(undefined, AT + 10).ethUsdForLaunch).toBe(0); // not loaded yet
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Reserves this thin are not evidence of a price.
//
// Read on-chain 2026-08-01: the native pair 0x5587…a481 holds 146,258 TOWELI +
// **0.00383 WETH** (~$14), its LP totalSupply fell 138.03 → 23.67, and LP Farming's
// balance went 125.0 → 0. The Uniswap pair is ~1,950x deeper in WETH.
//
// `useToweliPrice` fed that pool's spot straight into the site-wide `priceInUsd`.
// The only manipulation guard is the TWAP leg, and `consult()` reverts
// `ReservesBelowFloor` on this pair — so the guard fails closed and spot passes
// through unchecked. The spot it produced was not far off the real price, which is
// exactly why this was easy to miss: the defect is not a wrong number, it is a
// number anyone can move for about ten dollars.
//
// The floor is not invented — it mirrors TegridyTWAP.DEFAULT_MIN_RESERVE_FLOOR_WEI
// (read on-chain as 1e19, with minReserveFloor1(pair) == 0 so the default applies).
describe('reservesSupportPricing — the protocol\'s own floor, applied to display', () => {
  const TOWELI = 146_258_413_709_023_551_111_936n; // live, 2026-08-01
  const WETH_LIVE = 3_830_891_242_585_222n; // live, 2026-08-01 — 0.00383 WETH

  it('refuses the pool as it actually stands today', () => {
    expect(reservesSupportPricing(TOWELI, WETH_LIVE)).toBe(false);
  });

  it('refuses anything below the floor and accepts at exactly the floor', () => {
    // Pinned as a boundary, not a literal: the point is that the threshold is the
    // oracle's, and that "just under" is refused rather than rounded through.
    expect(reservesSupportPricing(TOWELI, MIN_PRICEABLE_WETH_RESERVE - 1n)).toBe(false);
    expect(reservesSupportPricing(TOWELI, MIN_PRICEABLE_WETH_RESERVE)).toBe(true);
    expect(reservesSupportPricing(TOWELI, MIN_PRICEABLE_WETH_RESERVE * 100n)).toBe(true);
  });

  it('agrees with the on-chain oracle that refuses to quote this pair', () => {
    // TegridyTWAP.DEFAULT_MIN_RESERVE_FLOOR_WEI, read from mainnet 2026-08-01.
    expect(MIN_PRICEABLE_WETH_RESERVE).toBe(10_000_000_000_000_000_000n);
  });

  it('still refuses an empty TOWELI side even above the WETH floor', () => {
    // Guards the division, and a one-sided pool is not a price either.
    expect(reservesSupportPricing(0n, MIN_PRICEABLE_WETH_RESERVE * 10n)).toBe(false);
  });

  it('self-heals: the deepen that restores consult() also restores spot pricing', () => {
    // The floor is the SAME number the oracle enforces, so there is no second
    // operator action to remember — no code change is needed once the pool is deep.
    expect(reservesSupportPricing(TOWELI, WETH_LIVE)).toBe(false);
    expect(reservesSupportPricing(TOWELI, 11n * 10n ** 18n)).toBe(true);
  });
});
