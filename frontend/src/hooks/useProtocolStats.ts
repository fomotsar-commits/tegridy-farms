import { useReadContracts } from 'wagmi';
import { formatEther } from 'viem';
import { TEGRIDY_STAKING_ABI, SWAP_FEE_ROUTER_ABI } from '../lib/contracts';
import {
  TEGRIDY_STAKING_ADDRESS, SWAP_FEE_ROUTER_ADDRESS, CHAIN_ID,
  isDeployed as checkDeployed,
} from '../lib/constants';
import { useTOWELIPrice } from '../contexts/PriceContext';

/**
 * Public protocol-analytics aggregate, read straight from chain (no wallet, no
 * indexer required). Cumulative figures: trading volume (derived from collected
 * fees ÷ fee rate), real-yield/fees generated, staking reward pool + emission,
 * total staked. All chainId-pinned so it works pre-connect. Swap count is NOT
 * read here: the deployed router has no totalSwaps() (removed by gas fix G-23);
 * it becomes available once the indexer counts SwapExecuted events.
 *
 * NOTE: volume is an on-chain *approximation* (fees ÷ feeRate). Exact historical
 * volume + revenue distributed-per-epoch come from the Ponder indexer / Dune once
 * those are live against the relaunch addresses.
 */
export function useProtocolStats() {
  const stakingDeployed = checkDeployed(TEGRIDY_STAKING_ADDRESS);
  const sfrDeployed = checkDeployed(SWAP_FEE_ROUTER_ADDRESS);
  const price = useTOWELIPrice();

  const { data, isLoading } = useReadContracts({
    contracts: [
      { address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'totalETHFees', chainId: CHAIN_ID },
      { address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'feeBps', chainId: CHAIN_ID },
      { address: TEGRIDY_STAKING_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'totalStaked', chainId: CHAIN_ID },
      { address: TEGRIDY_STAKING_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'totalRewardsFunded', chainId: CHAIN_ID },
      { address: TEGRIDY_STAKING_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'rewardRate', chainId: CHAIN_ID },
    ],
    query: { enabled: sfrDeployed && stakingDeployed, refetchInterval: 60_000, refetchOnWindowFocus: true },
  });

  const totalETHFees = data?.[0]?.status === 'success' ? data[0].result as bigint : 0n;
  const feeBps = data?.[1]?.status === 'success' ? data[1].result as bigint : 0n;
  const totalStaked = data?.[2]?.status === 'success' ? data[2].result as bigint : 0n;
  const totalRewardsFunded = data?.[3]?.status === 'success' ? data[3].result as bigint : 0n;
  const rewardRate = data?.[4]?.status === 'success' ? data[4].result as bigint : 0n;

  const ethUsd = price.ethUsd;
  const toweliUsd = price.priceInUsd;

  const feesEth = Number(formatEther(totalETHFees));
  const feesUsd = feesEth * ethUsd;
  const feeRate = feeBps > 0n ? Number(feeBps) / 10000 : 0; // e.g. 50 bps -> 0.005
  const volumeEth = feeRate > 0 ? feesEth / feeRate : 0;
  const volumeUsd = volumeEth * ethUsd;

  const rewardPoolToweli = Number(formatEther(totalRewardsFunded));
  const dailyEmissionToweli = Number(formatEther(rewardRate)) * 86400;
  const stakedToweli = Number(formatEther(totalStaked));
  const stakedUsd = stakedToweli * toweliUsd;

  return {
    volumeUsd,
    feesUsd,
    feesEth,
    rewardPoolToweli,
    dailyEmissionToweli,
    stakedToweli,
    stakedUsd,
    isDeployed: sfrDeployed && stakingDeployed,
    isLoading,
  };
}
