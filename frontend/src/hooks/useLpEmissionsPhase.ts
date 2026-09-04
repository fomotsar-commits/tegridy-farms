import { useReadContract } from 'wagmi';
import { LP_FARMING_ABI } from '../lib/contracts';
import { LP_FARMING_ADDRESS, CHAIN_ID, isDeployed } from '../lib/constants';
import { lpEmissionsPhase, type LpEmissionsPhase } from '../lib/lpEmissions';

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
  const { data } = useReadContract({
    address: LP_FARMING_ADDRESS,
    abi: LP_FARMING_ABI,
    functionName: 'periodFinish',
    chainId: CHAIN_ID,
    query: { enabled: isDeployed(LP_FARMING_ADDRESS), staleTime: 300_000 },
  });
  return lpEmissionsPhase(typeof data === 'bigint' ? Number(data) : 0);
}
