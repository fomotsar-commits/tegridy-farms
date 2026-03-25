import { useRef, useEffect, useState } from 'react';
import { useReadContract } from 'wagmi';
import { UNISWAP_V2_PAIR_ABI, CHAINLINK_FEED_ABI } from '../lib/contracts';
import { TOWELI_WETH_LP_ADDRESS, ETH_USD_FEED, TOWELI_ADDRESS, isDeployed as checkDeployed } from '../lib/constants';

// Maximum staleness for Chainlink data (1 hour)
const MAX_STALENESS_SECONDS = 3600;

export function useToweliPrice() {
  const pairAddr = TOWELI_WETH_LP_ADDRESS;
  const hasPair = checkDeployed(pairAddr);

  const { data: reserves } = useReadContract({
    address: pairAddr,
    abi: UNISWAP_V2_PAIR_ABI,
    functionName: 'getReserves',
    query: { enabled: hasPair, refetchInterval: 30_000 },
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
  // Load cached price synchronously so first render has a value
  const [apiFallbackPrice, setApiFallbackPrice] = useState<number>(() => {
    try {
      const cached = localStorage.getItem('tegridy_api_price');
      if (cached) {
        const { price: cp, ts } = JSON.parse(cached);
        if (Date.now() - ts < 600_000 && cp > 0) return cp;
      }
    } catch {}
    return 0;
  });

  // GeckoTerminal API — always fetch fresh price
  useEffect(() => {

    // Always fetch fresh price
    fetch(`https://api.geckoterminal.com/api/v2/simple/networks/eth/token_price/${TOWELI_ADDRESS.toLowerCase()}`)
      .then(r => r.json())
      .then(d => {
        const p = parseFloat(d?.data?.attributes?.token_prices?.[TOWELI_ADDRESS.toLowerCase()] ?? '0');
        if (p > 0) {
          setApiFallbackPrice(p);
          localStorage.setItem('tegridy_api_price', JSON.stringify({ price: p, ts: Date.now() }));
        }
      })
      .catch(() => {});
  }, []);

  // Validate Chainlink data
  let ethUsd = 0;
  let oracleStale = false;

  if (ethUsdData) {
    const [roundId, answer, , updatedAt, answeredInRound] = ethUsdData;
    const answerNum = Number(answer);
    const updatedAtNum = Number(updatedAt);
    const now = Math.floor(Date.now() / 1000);

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

  // Prefer GeckoTerminal API price — it matches the embedded chart and
  // accounts for actual market conditions better than on-chain reserves
  if (apiFallbackPrice > 0) {
    priceInUsd = apiFallbackPrice;
    isLoaded = true;
  }

  // Track price change vs stored baseline
  const priceChange = prevPriceRef.current > 0 && priceInUsd > 0
    ? ((priceInUsd - prevPriceRef.current) / prevPriceRef.current) * 100
    : 0;

  useEffect(() => {
    if (priceInUsd <= 0) return;

    // Load baseline on first price load
    if (prevPriceRef.current === 0) {
      try {
        const stored = localStorage.getItem('tegridy_price_baseline');
        if (stored) {
          const { price: p, ts } = JSON.parse(stored);
          if (Date.now() - ts < 86400000 && p > 0) {
            prevPriceRef.current = p;
            return; // Don't overwrite on same tick
          }
        }
      } catch {}
      prevPriceRef.current = priceInUsd;
    }

    // Throttled write (every 5 min)
    try {
      const stored = localStorage.getItem('tegridy_price_baseline');
      const lastTs = stored ? JSON.parse(stored).ts : 0;
      if (Date.now() - lastTs > 300000) {
        localStorage.setItem('tegridy_price_baseline', JSON.stringify({ price: priceInUsd, ts: Date.now() }));
      }
    } catch {}
  }, [priceInUsd]);

  return {
    priceInEth,
    priceInUsd,
    ethUsd,
    isLoaded,
    oracleStale,
    priceChange,
  };
}
