import { useReadContracts } from 'wagmi';
import { formatEther } from 'viem';
import { TEGRIDY_STAKING_ABI } from '../lib/contracts';
import { TEGRIDY_STAKING_ADDRESS, isDeployed as checkDeployed } from '../lib/constants';

export function usePoolData() {
  const addr = TEGRIDY_STAKING_ADDRESS;
  const isDeployed = checkDeployed(addr);

  const { data, isLoading } = useReadContracts({
    contracts: [
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalStaked' },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalBoostedStake' },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalLocked' },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'rewardRate' },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalRewardsFunded' },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalPenaltiesCollected' },
    ],
    query: { enabled: isDeployed, refetchInterval: 60_000, refetchOnWindowFocus: true },
  });

  // Safely extract results — if contract call fails, use 0n
  const totalStaked = (data?.[0]?.status === 'success' ? data[0].result as bigint : 0n);
  const totalBoostedStake = (data?.[1]?.status === 'success' ? data[1].result as bigint : 0n);
  const totalLocked = (data?.[2]?.status === 'success' ? data[2].result as bigint : 0n);
  const rewardRate = (data?.[3]?.status === 'success' ? data[3].result as bigint : 0n);
  const totalRewardsFunded = (data?.[4]?.status === 'success' ? data[4].result as bigint : 0n);
  const totalPenalties = (data?.[5]?.status === 'success' ? data[5].result as bigint : 0n);

  let apr = '0';
  let aprCapped = false;
  if (rewardRate > 0n && totalBoostedStake > 0n) {
    // Scale up before dividing to preserve precision for low APRs
    const aprScaled = rewardRate * 31536000n * 10000n * 10n ** 18n;
    const aprBps = aprScaled / totalBoostedStake;
    const aprNum = Number(aprBps) / 1e18;
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
    rewardRate: formatEther(rewardRate),
    totalRewardsFunded: formatEther(totalRewardsFunded),
    totalPenalties: formatEther(totalPenalties),
    apr,
    aprCapped,
    /** Display alongside APR values */
    aprDisclaimer: 'Current rate, subject to change',
    isDeployed,
    isLoading,
  };
}
