import { useMemo } from 'react';
import { useReadContract } from 'wagmi';
import { LP_FARMING_ABI } from '../lib/contracts';
import { LP_FARMING_ADDRESS, CHAIN_ID, isDeployed } from '../lib/constants';
import {
  lpEmissionsPhase,
  lpFarmDeposit,
  LP_FARM_CHECKING_LINE,
  type LpEmissionsPhase,
  type LpFarmDeposit,
} from '../lib/lpEmissions';

/** One read of `periodFinish`, shared by every caller below (same query key). */
function usePeriodFinishRead() {
  return useReadContract({
    address: LP_FARMING_ADDRESS,
    abi: LP_FARMING_ABI,
    functionName: 'periodFinish',
    chainId: CHAIN_ID,
    query: { enabled: isDeployed(LP_FARMING_ADDRESS), staleTime: 300_000 },
  });
}

/**
 * Does the LP farm have a funded emissions period right now?
 *
 * This lived inside LaunchPage while /launch was the only surface making a day-2
 * claim about it. The Home "Farm" card makes the same claim, so the read is shared
 * rather than re-declared — two copies of a chain read are two chances to disagree
 * with each other and with the chain.
 *
 * `periodFinish` ONLY. The Synthetix `rewardRate` residual survives the period and
 * would report emissions nobody is paid (see lib/lpEmissions.ts). A failed read
 * degrades to 'unknown', never to 'running'.
 */
export function useLpEmissionsPhase(): LpEmissionsPhase {
  const { data } = usePeriodFinishRead();
  return lpEmissionsPhase(typeof data === 'bigint' ? Number(data) : 0);
}

/**
 * Whether a surface other than the farm card (the zap) may offer a new LP farm stake.
 * Memoised on the read, so a plan built on it keeps its identity between renders.
 */
export function useLpFarmDeposit(): LpFarmDeposit {
  const { data, isLoading } = usePeriodFinishRead();
  const periodFinish = typeof data === 'bigint' ? Number(data) : null;
  return useMemo<LpFarmDeposit>(
    () => (isLoading
      ? { open: false, reason: 'checking', line: LP_FARM_CHECKING_LINE }
      : lpFarmDeposit(periodFinish)),
    [isLoading, periodFinish],
  );
}
