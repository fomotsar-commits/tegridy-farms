import { useReadContracts } from 'wagmi';
import { formatEther } from 'viem';
import { TEGRIDY_FARM_ABI } from '../lib/contracts';
import { TEGRIDY_FARM_ADDRESS, LP_POOL_ID, TOWELI_POOL_ID, isDeployed as checkDeployed } from '../lib/constants';

export function useFarmStats() {
  const farmAddr = TEGRIDY_FARM_ADDRESS;
  const isDeployed = checkDeployed(farmAddr);

  const { data } = useReadContracts({
    contracts: [
      {
        address: farmAddr,
        abi: TEGRIDY_FARM_ABI,
        functionName: 'poolInfo',
        args: [LP_POOL_ID],
      },
      {
        address: farmAddr,
        abi: TEGRIDY_FARM_ABI,
        functionName: 'poolInfo',
        args: [TOWELI_POOL_ID],
      },
      {
        address: farmAddr,
        abi: TEGRIDY_FARM_ABI,
        functionName: 'totalRewardsRemaining',
      },
      {
        address: farmAddr,
        abi: TEGRIDY_FARM_ABI,
        functionName: 'rewardPerSecond',
      },
    ],
    query: { enabled: isDeployed, refetchInterval: 30_000 },
  });

  if (!isDeployed || !data) {
    return {
      tvl: '–',
      toweliPrice: '–',
      rewardsDistributed: '–',
      isDeployed,
    };
  }

  const lpPool = data[0].result;
  const toweliPool = data[1].result;
  const remaining = data[2].result;

  const lpStaked = lpPool ? lpPool[4] : 0n;
  const toweliStaked = toweliPool ? toweliPool[4] : 0n;

  // For now, show raw token amounts. In production, multiply by price oracle.
  const totalStakedTokens = Number(formatEther(lpStaked + toweliStaked));

  // Rough rewards distributed = initial fund - remaining
  const initialFund = 26_000_000; // 26M TOWELI initial fund
  const remainingNum = remaining ? Number(formatEther(remaining)) : initialFund;
  const distributed = Math.max(0, initialFund - remainingNum);

  return {
    tvl: totalStakedTokens > 0 ? `${totalStakedTokens.toLocaleString()} TOWELI` : '0 TOWELI',
    toweliPrice: '–',
    rewardsDistributed: `${distributed.toLocaleString()} TOWELI`,
    isDeployed,
  };
}
