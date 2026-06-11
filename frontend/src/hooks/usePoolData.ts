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
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'periodFinish' },
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
  const periodFinish = (data?.[6]?.status === 'success' ? data[6].result as bigint : 0n);

  // HONESTY PASS 2026-06-11: totalRewardsFunded is CUMULATIVE (never decreases),
  // so it must not be displayed as "rewards remaining". The true remaining pool
  // for the current emission period is rewardRate × time-until-periodFinish —
  // the standard Synthetix StakingRewards accounting.
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const secondsRemaining = periodFinish > nowSec ? periodFinish - nowSec : 0n;
  const rewardsRemaining = rewardRate * secondsRemaining;

  let apr = '0';
  // Numeric APR % for any math. Consumers MUST use this, not parseFloat(apr): once
  // apr >= 10000 the display string is comma-formatted ("28,567") and parseFloat
  // would silently truncate it to 28, breaking every projection ~1000x low.
  let aprNum = 0;
  const aprCapped = false;
  if (rewardRate > 0n && totalBoostedStake > 0n) {
    // Scale up before dividing to preserve precision for low APRs
    const aprScaled = rewardRate * 31536000n * 10000n * 10n ** 18n;
    const aprBps = aprScaled / totalBoostedStake;
    const aprPct = Number(aprBps) / 1e18 / 100; // REAL APR in %
    aprNum = aprPct;
    // Operator decision (2026-06-07): show the REAL APR — no ">9,999%" ceiling.
    // At bootstrap TVL this is very large and falls toward the steady-state as
    // stake grows. >=10,000% rendered as comma integers; smaller keeps 2 decimals.
    apr = aprPct >= 10000 ? Math.round(aprPct).toLocaleString() : aprPct.toFixed(2);
  }

  return {
    totalStaked: formatEther(totalStaked),
    totalStakedRaw: totalStaked,
    totalBoostedStake: formatEther(totalBoostedStake),
    totalLocked: formatEther(totalLocked),
    rewardRate: formatEther(rewardRate),
    totalRewardsFunded: formatEther(totalRewardsFunded),
    totalPenalties: formatEther(totalPenalties),
    /** Unix seconds when the current emission period ends (0 if unread). */
    periodFinish: Number(periodFinish),
    /** Seconds left in the current emission period (0 once it has ended). */
    secondsRemaining: Number(secondsRemaining),
    /** TOWELI still to be emitted this period — the honest "remaining" figure. */
    rewardsRemaining: formatEther(rewardsRemaining),
    apr,
    aprNum,
    aprCapped,
    /** Display alongside APR values */
    aprDisclaimer: 'Bootstrap rate — falls as staking grows',
    isDeployed,
    isLoading,
  };
}
