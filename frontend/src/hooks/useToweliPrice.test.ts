import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

import { useToweliPrice, evaluateEthUsdFeed, type ChainlinkRound } from './useToweliPrice';
import { TOWELI_ADDRESS, ETH_USD_FEED, TEGRIDY_LP_ADDRESS, TOWELI_WETH_LP_ADDRESS } from '../lib/constants';

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

  // 12. WHICH POOL the headline price comes from ─────────────────────────
  //
  // The hook priced off TEGRIDY_LP_ADDRESS (our own native pair) on the premise
  // that it would be the deep one. On 2026-08-02 that pair held 0.00383 WETH —
  // about $7 a side — while the Uniswap V2 pair held 7.49 WETH, ~1,956x deeper.
  // Every existing test above stubs on `functionName` ALONE with no `address`,
  // so a single unscoped stub answers for whichever pair the hook asks about and
  // not one of them can tell the two apart. That is precisely why the defect
  // shipped green. These stubs are address-scoped (wagmi-mocks.ts:110) and
  // register BOTH pairs at their real mainnet reserves, so the hook's choice of
  // pool is the only thing under test.
  describe('price source pool', () => {
    // Real mainnet state, read 2026-08-02. token0 is TOWELI on both pairs.
    const NATIVE_TOWELI = 146_258_413_709_023_551_111_936n;
    const NATIVE_WETH = 3_830_891_242_585_222n; // 0.00383 WETH
    const UNI_TOWELI = 274_657_533_970_735_849_999_999_999n;
    const UNI_WETH = 7_493_598_886_468_978_000n; // 7.4936 WETH

    /** Stub both pairs, each at its own reserves, plus a healthy ETH/USD round. */
    function stubBothPairs(nativeWeth: bigint, uniWeth: bigint): void {
      wagmiMock.setReadResult({ address: TEGRIDY_LP_ADDRESS, functionName: 'token0', result: TOWELI_ADDRESS });
      wagmiMock.setReadResult({
        address: TEGRIDY_LP_ADDRESS,
        functionName: 'getReserves',
        result: reserves(NATIVE_TOWELI, nativeWeth),
      });
      wagmiMock.setReadResult({ address: TOWELI_WETH_LP_ADDRESS, functionName: 'token0', result: TOWELI_ADDRESS });
      wagmiMock.setReadResult({
        address: TOWELI_WETH_LP_ADDRESS,
        functionName: 'getReserves',
        result: reserves(UNI_TOWELI, uniWeth),
      });
      wagmiMock.setReadResult({
        address: ETH_USD_FEED,
        functionName: 'latestRoundData',
        result: validChainlinkRound(1871.7),
      });
    }

    // Expected prices are DERIVED from the stubbed reserves, not hard-coded, so
    // this keeps pinning the invariant if the reserve fixtures are ever refreshed.
    const impliedPrice = (weth: bigint, toweli: bigint) => Number(weth) / Number(toweli);

    it('prices off the DEEP Uniswap pool, never the drained native pair', () => {
      stubBothPairs(NATIVE_WETH, UNI_WETH);
      const uniPrice = impliedPrice(UNI_WETH, UNI_TOWELI); // 2.7283e-8
      const nativePrice = impliedPrice(NATIVE_WETH, NATIVE_TOWELI); // 2.6193e-8

      const { result } = renderHook(() => useToweliPrice());

      // Relative, not absolute — toBeCloseTo's absolute epsilon is meaningless
      // against a number of magnitude 1e-8.
      expect(result.current.priceInEth / uniPrice).toBeCloseTo(1, 3);
      expect(Math.abs(result.current.priceInEth - nativePrice) / nativePrice).toBeGreaterThan(0.03);
    });

    it('still ignores the native pair when the two pools disagree wildly', () => {
      // Same setup, but the native pair is drained 10x further so the two pools'
      // implied prices are an order of magnitude apart. Live reserves differ by
      // only ~4%; if that ever narrows, the test above could pass by coincidence
      // while this one cannot.
      stubBothPairs(NATIVE_WETH / 10n, UNI_WETH);
      const uniPrice = impliedPrice(UNI_WETH, UNI_TOWELI);

      const { result } = renderHook(() => useToweliPrice());

      expect(result.current.priceInEth / uniPrice).toBeCloseTo(1, 3);
      // ETH at $1871.70 → the deep pool's price in USD, not the dust pool's.
      expect(result.current.priceInUsd).toBeCloseTo(uniPrice * 1871.7, 10);
    });
  });
});

// ─────────── Wiring guard: the price source pool ───────────
//
// Mirrors launchPriceWiring.test.ts, which exists for this same failure class: a
// one-identifier change that breaks no behavioural test. The address-scoped tests
// above DO catch a revert, but this pins it at the source too, because the failure
// mode is a well-meaning "restore the native pair" edit and the diff should be the
// thing that argues back.

describe('useToweliPrice price-source wiring', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'hooks', 'useToweliPrice.ts'), 'utf8');

  /** Strip comments so the prose explaining the switch cannot satisfy or trip a check. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('reads the pair TOWELI actually trades in, not the protocol-owned dust pool', () => {
    expect(code).toMatch(/const pairAddr = TOWELI_WETH_LP_ADDRESS/);
    expect(code).not.toMatch(/const pairAddr = TEGRIDY_LP_ADDRESS/);
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
