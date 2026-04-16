import { useRef, useEffect, useState } from 'react';
import { useReadContract } from 'wagmi';
import { UNISWAP_V2_PAIR_ABI, CHAINLINK_FEED_ABI } from '../lib/contracts';
import { TOWELI_WETH_LP_ADDRESS, ETH_USD_FEED, TOWELI_ADDRESS, isDeployed as checkDeployed } from '../lib/constants';
import { safeSetItem } from '../lib/storage';

// Maximum staleness for Chainlink data (5 minutes)
const MAX_STALENESS_SECONDS = 300;

export function useToweliPrice() {
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

  // ALL hooks MUST be called before any early returns (Rules of Hooks)
  const prevPriceRef = useRef<number>(0);
  // API price — used for display only; never for swap calculations.
  // localStorage cache is display-only with staleness tracking.
  const [apiFallbackPrice, setApiFallbackPrice] = useState<number>(0);
  const [apiPriceStale, setApiPriceStale] = useState(false);

  // Load cached price for display-only (marked stale if old)
  useEffect(() => {
    try {
      const cached = localStorage.getItem('tegridy_api_price');
      if (cached) {
        const { price: cp, ts } = JSON.parse(cached);
        if (cp > 0) {
          setApiFallbackPrice(cp);
          // Mark stale if older than 5 minutes
          setApiPriceStale(Date.now() - ts > 300_000);
        }
      }
    } catch {}
  }, []);

  // GeckoTerminal API — always fetch fresh price
  // AUDIT FIX #53: AbortController timeout prevents hanging requests from blocking UI
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000); // 10s timeout
    fetch(
      `https://api.geckoterminal.com/api/v2/simple/networks/eth/token_price/${TOWELI_ADDRESS.toLowerCase()}`,
      { signal: controller.signal },
    )
      .then(r => r.json())
      .then(d => {
        const p = parseFloat(d?.data?.attributes?.token_prices?.[TOWELI_ADDRESS.toLowerCase()] ?? '0');
        if (p > 0) {
          setApiFallbackPrice(p);
          setApiPriceStale(false);
          safeSetItem('tegridy_api_price', JSON.stringify({ price: p, ts: Date.now() }));
        }
      })
      .catch(() => {});
    return () => { clearTimeout(timeout); controller.abort(); };
  }, []);

  // Validate Chainlink data
  let ethUsd = 0;
  let oracleStale = false;

  if (ethUsdData) {
    const [roundId, answer, , updatedAt, answeredInRound] = ethUsdData;
    const answerNum = Number(answer);
    const updatedAtNum = Number(updatedAt);
    const now = Math.floor(Date.now() / 1000);

    const ETH_USD_MIN = 100_00000000; // $100 with 8 decimals
    const ETH_USD_MAX = 100000_00000000; // $100,000 with 8 decimals

    if (
      answerNum > 0 &&
      updatedAtNum > 0 &&
      now - updatedAtNum < MAX_STALENESS_SECONDS &&
      answeredInRound >= roundId
    ) {
      ethUsd = answerNum / 1e8;
    } else {
      oracleStale = true;
    }

    if (answerNum < ETH_USD_MIN || answerNum > ETH_USD_MAX) {
      oracleStale = true;
    }
  }

  // Compute price (may be 0 if data not loaded)
  let priceInEth = 0;
  let priceInUsd = 0;
  let isLoaded = false;

  if (hasPair && reserves && token0) {
    const isToken0Toweli = token0.toLowerCase() === TOWELI_ADDRESS.toLowerCase();
    const toweliReserve = isToken0Toweli ? reserves[0] : reserves[1];
    const wethReserve = isToken0Toweli ? reserves[1] : reserves[0];

    if (toweliReserve > 0n && wethReserve > 0n) {
      const scaledPrice = (wethReserve * 10n ** 18n) / toweliReserve;
      priceInEth = Number(scaledPrice) / 1e18;
    }

    priceInUsd = ethUsd > 0 ? priceInEth * ethUsd : 0;
    isLoaded = true;
  }

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
      safeSetItem('tegridy_price_baseline', JSON.stringify({ price: priceInUsd, ts: Date.now() }));
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
    isLoaded,
    oracleStale,
    priceChange: sessionPriceChange,
    priceUnavailable,
    displayPriceStale,
    apiPriceDiscrepant,
    priceDiscrepancy,
    priceSafeForSwaps: priceInUsd > 0 && !displayPriceStale && !oracleStale,
  };
}
