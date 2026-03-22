import { useReadContract } from 'wagmi';
import { formatEther } from 'viem';
import { UNISWAP_V2_PAIR_ABI, CHAINLINK_FEED_ABI } from '../lib/contracts';
import { TOWELI_WETH_LP_ADDRESS, ETH_USD_FEED, TOWELI_ADDRESS } from '../lib/constants';

// Maximum staleness for Chainlink data (1 hour)
const MAX_STALENESS_SECONDS = 3600;

export function useToweliPrice() {
  const pairAddr = TOWELI_WETH_LP_ADDRESS;
  const hasPair = pairAddr !== '0x0000000000000000000000000000000000000000';

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

  // Validate Chainlink data: check answer > 0, staleness, and round completeness
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

  if (!hasPair || !reserves || !token0) {
    return {
      priceInEth: 0,
      priceInUsd: 0,
      ethUsd,
      isLoaded: false,
      oracleStale,
    };
  }

  const isToken0Toweli = token0.toLowerCase() === TOWELI_ADDRESS.toLowerCase();
  const toweliReserve = isToken0Toweli ? reserves[0] : reserves[1];
  const wethReserve = isToken0Toweli ? reserves[1] : reserves[0];

  // Use BigInt division for better precision with extreme supply ratios
  let priceInEth = 0;
  if (toweliReserve > 0n && wethReserve > 0n) {
    // Scale up for precision: (wethReserve * 1e18) / toweliReserve gives price in wei-per-token
    const scaledPrice = (wethReserve * 10n ** 18n) / toweliReserve;
    priceInEth = Number(scaledPrice) / 1e18;
  }

  const priceInUsd = ethUsd > 0 ? priceInEth * ethUsd : 0;

  return {
    priceInEth,
    priceInUsd,
    ethUsd,
    isLoaded: true,
    oracleStale,
  };
}
