import { useReadContract } from 'wagmi';
import { formatEther } from 'viem';
import { TEGRIDY_FARM_ABI } from '../lib/contracts';
import { TEGRIDY_FARM_ADDRESS, isDeployed as checkDeployed } from '../lib/constants';

export function usePoolData(pid: bigint) {
  const farmAddr = TEGRIDY_FARM_ADDRESS;
  const isDeployed = checkDeployed(farmAddr);

  const { data: poolInfo } = useReadContract({
    address: farmAddr,
    abi: TEGRIDY_FARM_ABI,
    functionName: 'poolInfo',
    args: [pid],
    query: { enabled: isDeployed },
  });

  const { data: totalAllocPoint } = useReadContract({
    address: farmAddr,
    abi: TEGRIDY_FARM_ABI,
    functionName: 'totalAllocPoint',
    query: { enabled: isDeployed },
  });

  const { data: rewardPerSecond } = useReadContract({
    address: farmAddr,
    abi: TEGRIDY_FARM_ABI,
    functionName: 'rewardPerSecond',
    query: { enabled: isDeployed },
  });

  const { data: totalRewardsRemaining } = useReadContract({
    address: farmAddr,
    abi: TEGRIDY_FARM_ABI,
    functionName: 'totalRewardsRemaining',
    query: { enabled: isDeployed },
  });

  const { data: effectiveRate } = useReadContract({
    address: farmAddr,
    abi: TEGRIDY_FARM_ABI,
    functionName: 'effectiveRewardPerSecond',
    query: { enabled: isDeployed },
  });

  // Derive values
  const totalStaked = poolInfo ? poolInfo[4] : 0n;
  const allocPoint = poolInfo ? poolInfo[1] : 0n;

  // Calculate APR: (rewardPerSecond * poolShare * secondsPerYear) / totalStaked * 100
  let apr = '0';
  if (rewardPerSecond && totalAllocPoint && totalAllocPoint > 0n && totalStaked > 0n && allocPoint > 0n) {
    const secondsPerYear = 365n * 24n * 60n * 60n;
    const poolRewardPerYear = (rewardPerSecond * allocPoint * secondsPerYear) / totalAllocPoint;
    // APR as percentage (reward/staked * 100)
    const aprBps = (poolRewardPerYear * 10000n) / totalStaked;
    apr = (Number(aprBps) / 100).toFixed(2);
  }

  // Check if rewards are running low (< 7 days worth at current rate)
  const rewardsLow = rewardPerSecond && totalRewardsRemaining
    ? totalRewardsRemaining < rewardPerSecond * 604800n // 7 days in seconds
    : false;

  // Days of rewards remaining
  const daysRemaining = rewardPerSecond && rewardPerSecond > 0n && totalRewardsRemaining
    ? Number(totalRewardsRemaining / (rewardPerSecond * 86400n))
    : 0;

  return {
    totalStaked: formatEther(totalStaked),
    allocPoint: allocPoint,
    apr,
    totalRewardsRemaining: totalRewardsRemaining ? formatEther(totalRewardsRemaining) : '0',
    rewardPerSecond: rewardPerSecond ? formatEther(rewardPerSecond) : '0',
    effectiveRewardPerSecond: effectiveRate ? formatEther(effectiveRate) : '0',
    rewardsLow,
    daysRemaining,
    isDeployed,
  };
}
