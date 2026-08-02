import { useRef, useEffect, useState } from 'react';
import { useReadContract } from 'wagmi';
import { UNISWAP_V2_PAIR_ABI, CHAINLINK_FEED_ABI, TEGRIDY_TWAP_ABI } from '../lib/contracts';
import { TOWELI_WETH_LP_ADDRESS, ETH_USD_FEED, TOWELI_ADDRESS, TEGRIDY_TWAP_ADDRESS, isDeployed as checkDeployed } from '../lib/constants';
import { safeSetItem, safeGetItem, safeJsonParse } from '../lib/storage';

// R075: every cache key carries its own schema version. A stale entry from
// a different commit, a tampered `signedAt`, or a future-signed payload is
// invalidated on read. Bumping this number invalidates every cache entry.
export const PRICE_CACHE_VERSION = 2;
const CACHE_FRESHNESS_SLACK_MS = 60_000; // accept entries up to 60s in the future
const CACHE_MAX_AGE_MS = 24 * 60 * 60_000; // reject entries >24h old

interface VersionedCacheEntry<T> {
  version: number;
  data: T;
  signedAt: number;
}

function readVersionedCacheEntry<T>(key: string): T | null {
  const raw = safeGetItem(key);
  const parsed = safeJsonParse<Partial<VersionedCacheEntry<T>>>(raw, {} as Partial<VersionedCacheEntry<T>>);
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.version !== PRICE_CACHE_VERSION) {
    try { localStorage.removeItem(key); } catch { /* noop */ }
    return null;
  }
  if (typeof parsed.signedAt !== 'number' || !Number.isFinite(parsed.signedAt)) return null;
  const now = Date.now();
  if (parsed.signedAt > now + CACHE_FRESHNESS_SLACK_MS) return null;
  if (now - parsed.signedAt > CACHE_MAX_AGE_MS) return null;
  return (parsed.data as T) ?? null;
}

function writeVersionedCache<T>(key: string, data: T): void {
  const entry: VersionedCacheEntry<T> = { version: PRICE_CACHE_VERSION, data, signedAt: Date.now() };
  safeSetItem(key, JSON.stringify(entry));
}

// TWAP window: 30 minutes. Long enough to resist single-block manipulation,
// short enough to track real price movements at <1 min lag.
const TWAP_PERIOD_SECONDS = 1800n;
// If the live pair reserves and the TWAP disagree by more than this ratio,
// treat the pair reserves as potentially manipulated and prefer TWAP for
// swap-safe pricing. 2% handles normal volatility without over-triggering.
const TWAP_DIVERGENCE_THRESHOLD = 0.02;

// Maximum staleness for Chainlink data (5 minutes)
const MAX_STALENESS_SECONDS = 300;

/**
 * Launch-path staleness tolerance for ETH/USD — deliberately looser than the swap one.
 *
 * Mainnet ETH/USD publishes on a 3600s heartbeat (plus a 0.5%-deviation trigger), so the
 * 300s window above rejects a PERFECTLY HEALTHY feed most of the time. Measured over 40
 * consecutive rounds: every inter-round gap exceeded 300s, and the tight gate was closed
 * ~85% of wallclock — which is exactly how often /launch refused to launch.
 *
 * Swaps keep the tight window on purpose: a quote priced off a 50-minute-old round is a
 * real loss. A LAUNCH is not the same trade. The numeraire price only sets the auction's
 * starting market-cap band, and the wizard shows that band to the creator in USD before
 * they sign. Rejecting on anything short of the feed's own liveness definition breaks the
 * launcher without protecting anyone. 3600s heartbeat + 300s margin.
 */
const MAX_LAUNCH_STALENESS_SECONDS = 3900;

/** A Chainlink `latestRoundData` tuple, as wagmi returns it. */
export type ChainlinkRound = readonly [bigint, bigint, bigint, bigint, bigint];

/**
 * Pure evaluation of a Chainlink ETH/USD round against BOTH freshness windows.
 *
 * Extracted from the hook so the windows are unit-testable — the launch path's tolerance is
 * the difference between a launcher that works and one that refuses ~85% of the time, and
 * that is not something to leave pinned only by a React hook nobody can exercise.
 */
export function evaluateEthUsdFeed(
  round: ChainlinkRound | undefined,
  nowSeconds: number,
): { ethUsd: number; ethUsdForLaunch: number; oracleStale: boolean } {
  if (!round) return { ethUsd: 0, ethUsdForLaunch: 0, oracleStale: false };

  const [roundId, answer, , updatedAt, answeredInRound] = round;
  const answerNum = Number(answer);
  const updatedAtNum = Number(updatedAt);

  const ETH_USD_MIN = 100_00000000; // $100 with 8 decimals
  const ETH_USD_MAX = 100000_00000000; // $100,000 with 8 decimals

  const wellFormed = answerNum > 0 && updatedAtNum > 0 && answeredInRound >= roundId;
  const inBand = answerNum >= ETH_USD_MIN && answerNum <= ETH_USD_MAX;
  const ageSeconds = nowSeconds - updatedAtNum;

  let ethUsd = 0;
  let oracleStale = false;
  if (wellFormed && ageSeconds < MAX_STALENESS_SECONDS) {
    ethUsd = answerNum / 1e8;
  } else {
    oracleStale = true;
  }

  // Launch path: same well-formedness checks, heartbeat-sized freshness window.
  // Unlike `ethUsd` this ALSO requires the price to be inside the sanity band — an
  // out-of-band answer must never reach the auction-curve math. (`ethUsd`'s looser
  // handling is pre-existing behaviour that swap consumers guard via `priceSafeForSwaps`;
  // widening the band check to it would change swap pricing, out of scope for this fix.)
  const ethUsdForLaunch = wellFormed && inBand && ageSeconds < MAX_LAUNCH_STALENESS_SECONDS ? answerNum / 1e8 : 0;

  if (!inBand) oracleStale = true;

  return { ethUsd, ethUsdForLaunch, oracleStale };
}

export function useToweliPrice() {
  // Price off the pool TOWELI actually trades in, not the pool we happen to own.
  //
  // This read pointed at TEGRIDY_LP_ADDRESS (our native pair) on the premise that it
  // would be the deep one. It is not: on 2026-08-02 it held 146,258 TOWELI + 0.00383
  // WETH — about $7 a side, where a ~$10 trade moves the quote arbitrarily. The
  // Uniswap V2 pair holds 274.6M TOWELI + 7.49 WETH, ~1,956x deeper in WETH, and is
  // the ONLY pool GeckoTerminal indexes for this token. Everything else on the site
  // already prices off it: the chart (PriceChart.tsx), the 24h sparkline
  // (usePriceHistory.ts), the trades feed (useProtocolActivity.ts), and the API
  // fallback below. The headline number was the last surface reading the dust pool.
  //
  // The TWAP leg below does NOT cover this either way — TegridyTWAP.consult reverts
  // ReservesBelowFloor for BOTH pairs (10 ETH floor, side-0 and side-1) and
  // observationCount is 0 for both, so `twapPriceInEth` is always 0. Verified on
  // mainnet 2026-08-02. Do not treat the divergence branch as live protection.
  //
  // This does NOT make the price manipulation-proof — 7.49 WETH is thin in absolute
  // terms and the pair is dormant. It makes it ~1,956x harder to move, and sourced
  // from the real market rather than a $14 pool.
  //
  // Point this back at the native pair only once it is genuinely deeper — read both
  // pairs' getReserves and compare WETH before flipping it, don't flip it on intent.
  const pairAddr = TOWELI_WETH_LP_ADDRESS;
  const hasPair = checkDeployed(pairAddr);

  const { data: reserves } = useReadContract({
    address: pairAddr,
    abi: UNISWAP_V2_PAIR_ABI,
    functionName: 'getReserves',
    query: { enabled: hasPair, refetchInterval: 60_000, refetchOnWindowFocus: true },
  });

  const { data: token0 } = useReadContract({
    address: pairAddr,
    abi: UNISWAP_V2_PAIR_ABI,
    functionName: 'token0',
    query: { enabled: hasPair },
  });

  const { data: ethUsdData } = useReadContract({
    address: ETH_USD_FEED,
    abi: CHAINLINK_FEED_ABI,
    functionName: 'latestRoundData',
    query: { refetchInterval: 60_000 },
  });

  // TegridyTWAP.consult — third oracle leg for manipulation-resistant pricing.
  // Returns WETH output for 1 TOWELI averaged over TWAP_PERIOD_SECONDS.
  // Fails soft (returns 0n) for brand-new pairs without enough observation
  // history — we treat that as "no TWAP available" and fall back to the pair
  // reserves, which is the pre-existing behaviour.
  const hasTwap = checkDeployed(TEGRIDY_TWAP_ADDRESS);
  const { data: twapAmountOut } = useReadContract({
    address: TEGRIDY_TWAP_ADDRESS,
    abi: TEGRIDY_TWAP_ABI,
    functionName: 'consult',
    args: hasTwap && hasPair ? [pairAddr, TOWELI_ADDRESS, 10n ** 18n, TWAP_PERIOD_SECONDS] : undefined,
    query: {
      enabled: hasTwap && hasPair,
      refetchInterval: 60_000,
      retry: false, // observation history gaps produce expected reverts — don't spam
    },
  });

  // ALL hooks MUST be called before any early returns (Rules of Hooks)
  const prevPriceRef = useRef<number>(0);
  // API price — used for display only; never for swap calculations.
  // localStorage cache is display-only with staleness tracking.
  const [apiFallbackPrice, setApiFallbackPrice] = useState<number>(0);
  const [apiPriceStale, setApiPriceStale] = useState(false);

  // R075: load cached price via versioned-cache reader.
  useEffect(() => {
    const entry = readVersionedCacheEntry<{ price: number; ts: number }>('tegridy_api_price');
    if (!entry) return;
    if (typeof entry.price !== 'number' || !(entry.price > 0)) return;
    setApiFallbackPrice(entry.price);
    setApiPriceStale(Date.now() - entry.ts > 300_000);
  }, []);

  // GeckoTerminal API — fetch fresh price on mount and refresh on an interval.
  // F110: previously this ran once per mount (empty deps), so while the native
  // TOWELI/WETH pair is unseeded the headline price + sparkline were frozen for
  // the whole session even though the UI shows a "live" PulseDot next to it.
  // A 60s refresh (matching the on-chain read cadence) keeps the API fallback
  // current; it's gated on tab visibility so a backgrounded tab doesn't poll.
  // AUDIT FIX #53: AbortController timeout prevents hanging requests from blocking UI
  useEffect(() => {
    let cancelled = false;

    const fetchPrice = () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000); // 10s timeout
      fetch(
        `https://api.geckoterminal.com/api/v2/simple/networks/eth/token_price/${TOWELI_ADDRESS.toLowerCase()}`,
        { signal: controller.signal },
      )
        .then(r => r.json())
        .then(d => {
          if (cancelled) return;
          const p = parseFloat(d?.data?.attributes?.token_prices?.[TOWELI_ADDRESS.toLowerCase()] ?? '0');
          if (p > 0) {
            setApiFallbackPrice(p);
            setApiPriceStale(false);
            // R075: write through the versioned-cache helper.
            writeVersionedCache('tegridy_api_price', { price: p, ts: Date.now() });
          }
        })
        .catch((err) => {
          // GeckoTerminal fallback price fetch failed — not fatal (price falls
          // back to on-chain pool reserves). Log for diagnostics so silent
          // price-staleness bugs are visible in devtools.
          if (err?.name !== 'AbortError') {
            console.warn('[useToweliPrice] fallback price fetch failed:', err?.message ?? err);
          }
        })
        .finally(() => clearTimeout(timeout));
    };

    fetchPrice();
    const interval = setInterval(() => { if (!document.hidden) fetchPrice(); }, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Validate Chainlink data (pure — see evaluateEthUsdFeed).
  const { ethUsd, ethUsdForLaunch, oracleStale } = evaluateEthUsdFeed(
    ethUsdData as ChainlinkRound | undefined,
    Math.floor(Date.now() / 1000),
  );

  // Compute price (may be 0 if data not loaded)
  let priceInEth = 0;
  let priceInUsd = 0;
  let isLoaded = false;

  // TWAP: WETH per 1 TOWELI, raw bigint scaled by 10^18.
  const twapRaw = twapAmountOut as bigint | undefined;
  const twapPriceInEth = twapRaw && twapRaw > 0n ? Number(twapRaw) / 1e18 : 0;

  if (hasPair && reserves && token0) {
    const isToken0Toweli = token0.toLowerCase() === TOWELI_ADDRESS.toLowerCase();
    const toweliReserve = isToken0Toweli ? reserves[0] : reserves[1];
    const wethReserve = isToken0Toweli ? reserves[1] : reserves[0];

    let spotPriceInEth = 0;
    if (toweliReserve > 0n && wethReserve > 0n) {
      const scaledPrice = (wethReserve * 10n ** 18n) / toweliReserve;
      spotPriceInEth = Number(scaledPrice) / 1e18;
    }

    // Third oracle leg: if live reserves diverge from TWAP beyond threshold,
    // prefer TWAP. Single-block sandwich attacks can move `reserves` but
    // cannot meaningfully shift a 30-minute TWAP. If no TWAP is available
    // (new pair, not enough history), use spot unchanged.
    if (spotPriceInEth > 0 && twapPriceInEth > 0) {
      const divergence = Math.abs(spotPriceInEth - twapPriceInEth) / twapPriceInEth;
      priceInEth = divergence > TWAP_DIVERGENCE_THRESHOLD ? twapPriceInEth : spotPriceInEth;
    } else {
      priceInEth = spotPriceInEth;
    }

    priceInUsd = ethUsd > 0 ? priceInEth * ethUsd : 0;
    isLoaded = true;
  }

  // Expose whether TWAP overrode spot this frame so the UI can flag it.
  // Warning-level only — the user's quote still settles via the normal path,
  // but a persistent TWAP override means the pool is under active pressure.
  const twapOverrideActive =
    twapPriceInEth > 0 &&
    priceInEth > 0 &&
    // Reconstruct the spot price to compare; only possible if we had reserves.
    (() => {
      if (!hasPair || !reserves || !token0) return false;
      const isToken0Toweli = token0.toLowerCase() === TOWELI_ADDRESS.toLowerCase();
      const toweliReserve = isToken0Toweli ? reserves[0] : reserves[1];
      const wethReserve = isToken0Toweli ? reserves[1] : reserves[0];
      if (toweliReserve <= 0n || wethReserve <= 0n) return false;
      const spot = Number((wethReserve * 10n ** 18n) / toweliReserve) / 1e18;
      return Math.abs(spot - twapPriceInEth) / twapPriceInEth > TWAP_DIVERGENCE_THRESHOLD;
    })();

  // Use GeckoTerminal API price only if within ±1% of on-chain price,
  // or if on-chain price is unavailable (#24 + #81 audit fix)
  let apiPriceDiscrepant = false;
  if (apiFallbackPrice > 0) {
    if (priceInUsd > 0) {
      const deviation = Math.abs(apiFallbackPrice - priceInUsd) / priceInUsd;
      if (deviation <= 0.01) {
        // API price is within ±1% of on-chain — safe to use
        priceInUsd = apiFallbackPrice;
      } else {
        // API price diverges >1% from on-chain — use on-chain price, flag as discrepant
        apiPriceDiscrepant = true;
      }
    } else {
      // No on-chain price available — use API as fallback
      priceInUsd = apiFallbackPrice;
      isLoaded = true;
    }
  }

  // Track price change vs stored baseline (session-only, not 24h)
  const sessionPriceChange = prevPriceRef.current > 0 && priceInUsd > 0
    ? ((priceInUsd - prevPriceRef.current) / prevPriceRef.current) * 100
    : 0;

  useEffect(() => {
    if (priceInUsd <= 0) return;

    // Pin baseline to session start — only set once
    if (prevPriceRef.current === 0) {
      prevPriceRef.current = priceInUsd;
      // R075: versioned-cache write.
      writeVersionedCache('tegridy_price_baseline', { price: priceInUsd, ts: Date.now() });
    }
  }, [priceInUsd]);

  // Price is unavailable for transactions when both on-chain and fresh API fail
  const priceUnavailable = priceInUsd <= 0 && apiFallbackPrice <= 0;
  // Display price is stale when only localStorage cache is available
  const displayPriceStale = apiPriceStale && priceInEth <= 0;

  // Finding #24: expose priceDiscrepancy boolean for consumers
  const priceDiscrepancy = apiPriceDiscrepant;

  return {
    priceInEth,
    priceInUsd,
    ethUsd,
    /**
     * ETH/USD for the LAUNCH path only (see MAX_LAUNCH_STALENESS_SECONDS). 0 when the
     * feed is genuinely unhealthy — missed heartbeat, out-of-band price, or an
     * incomplete round. Never use this to price a swap.
     */
    ethUsdForLaunch,
    isLoaded,
    oracleStale,
    priceChange: sessionPriceChange,
    priceUnavailable,
    displayPriceStale,
    apiPriceDiscrepant,
    priceDiscrepancy,
    // Third-oracle TWAP signals for UI consumption.
    twapPriceInEth,
    twapOverrideActive,
    priceSafeForSwaps: priceInUsd > 0 && !displayPriceStale && !oracleStale,
  };
}
