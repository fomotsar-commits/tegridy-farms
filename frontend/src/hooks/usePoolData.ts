import { useReadContracts } from 'wagmi';
import { formatEther } from 'viem';
import { TEGRIDY_STAKING_ABI } from '../lib/contracts';
import { TEGRIDY_STAKING_ADDRESS, isDeployed as checkDeployed } from '../lib/constants';

export function usePoolData() {
  const addr = TEGRIDY_STAKING_ADDRESS;
  const isDeployed = checkDeployed(addr);

  const { data } = useReadContracts({
    contracts: [
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalStaked' },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalBoostedStake' },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalLocked' },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'rewardPerSecond' },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalRewardsFunded' },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalPenaltiesCollected' },
    ],
    query: { enabled: isDeployed, refetchInterval: 30_000 },
  });

  // Safely extract results — if contract call fails, use 0n
  const totalStaked = (data?.[0]?.status === 'success' ? data[0].result as bigint : 0n);
  const totalBoostedStake = (data?.[1]?.status === 'success' ? data[1].result as bigint : 0n);
  const totalLocked = (data?.[2]?.status === 'success' ? data[2].result as bigint : 0n);
  const rewardPerSecond = (data?.[3]?.status === 'success' ? data[3].result as bigint : 0n);
  const totalRewardsFunded = (data?.[4]?.status === 'success' ? data[4].result as bigint : 0n);
  const totalPenalties = (data?.[5]?.status === 'success' ? data[5].result as bigint : 0n);

  let apr = '0';
  let aprCapped = false;
  if (rewardPerSecond > 0n && totalBoostedStake > 0n) {
    const secondsPerYear = 365n * 24n * 60n * 60n;
    const rewardsPerYear = rewardPerSecond * secondsPerYear;
    const aprBps = (rewardsPerYear * 10000n) / totalBoostedStake;
    const aprNum = Number(aprBps);
    if (aprNum > 999999) {
      apr = '>9999';
      aprCapped = true;
    } else {
      apr = (aprNum / 100).toFixed(2);
    }
  }

  return {
    totalStaked: formatEther(totalStaked),
    totalStakedRaw: totalStaked,
    totalBoostedStake: formatEther(totalBoostedStake),
    totalLocked: formatEther(totalLocked),
    rewardPerSecond: formatEther(rewardPerSecond),
    totalRewardsFunded: formatEther(totalRewardsFunded),
    totalPenalties: formatEther(totalPenalties),
    apr,
    aprCapped,
    isDeployed,
  };
}
