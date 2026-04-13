import { useMemo } from 'react';
import { useReadContracts } from 'wagmi';
import { formatEther } from 'viem';
import { UNISWAP_V2_PAIR_ABI, ERC20_ABI, SWAP_FEE_ROUTER_ABI } from '../lib/contracts';
import { TOWELI_WETH_LP_ADDRESS, TOWELI_ADDRESS, SWAP_FEE_ROUTER_ADDRESS, isDeployed as checkDeployed } from '../lib/constants';
import { useTOWELIPrice } from '../contexts/PriceContext';

const MAX_APR = 500;
const POOL_LAUNCH_TIMESTAMP = new Date('2025-03-01').getTime() / 1000;

export function usePoolTVL() {
  const price = useTOWELIPrice();
  const hasFeeRouter = checkDeployed(SWAP_FEE_ROUTER_ADDRESS);

  const { data } = useReadContracts({
    contracts: [
      { address: TOWELI_WETH_LP_ADDRESS, abi: UNISWAP_V2_PAIR_ABI, functionName: 'getReserves' } as const,
      { address: TOWELI_WETH_LP_ADDRESS, abi: UNISWAP_V2_PAIR_ABI, functionName: 'token0' } as const,
      { address: TOWELI_WETH_LP_ADDRESS, abi: ERC20_ABI, functionName: 'totalSupply' } as const,
      ...(hasFeeRouter ? [
        { address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'totalETHFees' as const },
        { address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'totalSwaps' as const },
        { address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'feeBps' as const },
      ] : []),
    ] as any,
    query: { refetchInterval: 30_000, refetchOnWindowFocus: true },
  });

  return useMemo(() => {
    const reserves = data?.[0]?.status === 'success' ? data[0].result as readonly [bigint, bigint, number] : undefined;
    const token0 = data?.[1]?.status === 'success' ? (data[1].result as string).toLowerCase() : undefined;
    const lpSupply = data?.[2]?.status === 'success' ? data[2].result as bigint : 0n;

    if (!reserves || !token0 || price.ethUsd <= 0) {
      return { tvl: 0, tvlFormatted: '–', toweliReserve: 0n, wethReserve: 0n, lpSupply: 0n, apr: '–', aprNum: 0, vol24hFormatted: '–', aprIsEstimated: true, volIsEstimated: true, isLoaded: false };
    }

    const isToken0Toweli = token0 === TOWELI_ADDRESS.toLowerCase();
    const toweliReserve = isToken0Toweli ? reserves[0] : reserves[1];
    const wethReserve = isToken0Toweli ? reserves[1] : reserves[0];

    const wethFloat = parseFloat(formatEther(wethReserve));
    const tvl = wethFloat * 2 * price.ethUsd;

    let tvlFormatted: string;
    if (tvl >= 1_000_000) tvlFormatted = `$${(tvl / 1_000_000).toFixed(2)}M`;
    else if (tvl >= 1_000) tvlFormatted = `$${(tvl / 1_000).toFixed(1)}K`;
    else if (tvl > 0) tvlFormatted = `$${tvl.toFixed(0)}`;
    else tvlFormatted = '–';

    let aprNum = 0;
    let aprIsEstimated = true;
    let vol24h = 0;
    let volIsEstimated = true;

    const totalETHFees = hasFeeRouter && data?.[3]?.status === 'success' ? data[3].result as bigint : 0n;
    // totalSwaps read at index 4 — reserved for future volume tracking
    const feeBps = hasFeeRouter && data?.[5]?.status === 'success' ? data[5].result as bigint : 0n;

    if (totalETHFees > 0n && tvl > 0) {
      const totalFeesUsd = parseFloat(formatEther(totalETHFees)) * price.ethUsd;
      const now = Math.floor(Date.now() / 1000);
      const poolAgeSec = Math.max(now - POOL_LAUNCH_TIMESTAMP, 86400);
      const poolAgeDays = poolAgeSec / 86400;

      const dailyFees = totalFeesUsd / poolAgeDays;
      const annualFees = dailyFees * 365;
      aprNum = (annualFees / tvl) * 100;

      if (feeBps > 0n) {
        const feeRate = Number(feeBps) / 10000;
        vol24h = feeRate > 0 ? dailyFees / feeRate : 0;
      } else {
        vol24h = dailyFees / 0.003;
      }

      aprIsEstimated = false;
      volIsEstimated = false;
    } else if (tvl > 0) {
      let dailyVolumeRatio: number;
      if (tvl < 10_000) dailyVolumeRatio = 0.01;
      else if (tvl < 100_000) dailyVolumeRatio = 0.02;
      else if (tvl < 1_000_000) dailyVolumeRatio = 0.03;
      else dailyVolumeRatio = 0.04;

      vol24h = tvl * dailyVolumeRatio;
      const annualFees = vol24h * 365 * 0.003;
      aprNum = (annualFees / tvl) * 100;
    }

    if (aprNum > MAX_APR) aprNum = MAX_APR;

    const apr = aprNum > 0
      ? `${aprIsEstimated ? '~' : ''}${aprNum.toFixed(1)}%${aprIsEstimated ? ' (est.)' : ''}`
      : '–';

    let vol24hFormatted: string;
    const volPrefix = volIsEstimated ? '~' : '';
    const volSuffix = volIsEstimated ? ' (est.)' : '';
    if (vol24h >= 1_000_000) vol24hFormatted = `${volPrefix}$${(vol24h / 1_000_000).toFixed(2)}M${volSuffix}`;
    else if (vol24h >= 1_000) vol24hFormatted = `${volPrefix}$${(vol24h / 1_000).toFixed(1)}K${volSuffix}`;
    else if (vol24h > 0) vol24hFormatted = `${volPrefix}$${vol24h.toFixed(0)}${volSuffix}`;
    else vol24hFormatted = '–';

    return {
      tvl,
      tvlFormatted,
      toweliReserve,
      wethReserve,
      lpSupply,
      apr,
      aprNum,
      vol24hFormatted,
      aprIsEstimated,
      volIsEstimated,
      isLoaded: true,
    };
  }, [data, price.ethUsd, hasFeeRouter]);
}
