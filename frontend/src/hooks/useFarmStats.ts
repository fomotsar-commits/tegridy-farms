import { useReadContracts, useChainId } from 'wagmi';
import { TEGRIDY_STAKING_ABI } from '../lib/contracts';
import { TEGRIDY_STAKING_ADDRESS, CHAIN_ID, isDeployed as checkDeployed } from '../lib/constants';
import { useTOWELIPrice } from '../contexts/PriceContext';
import { formatCurrency, formatWei } from '../lib/formatting';

export function useFarmStats() {
  const addr = TEGRIDY_STAKING_ADDRESS;
  const isDeployed = checkDeployed(addr);
  const price = useTOWELIPrice();
  const chainId = useChainId();
  const onMainnet = chainId === CHAIN_ID;

  const effectivePrice = price.priceInUsd;

  // R043 H-062-02: chainId pin on every entry, gate on onMainnet.
  const { data, isLoading } = useReadContracts({
    contracts: [
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalStaked', chainId: CHAIN_ID },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalRewardsFunded', chainId: CHAIN_ID },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'rewardRate', chainId: CHAIN_ID },
    ],
    query: { enabled: isDeployed && onMainnet, refetchInterval: 60_000, refetchOnWindowFocus: true },
  });

  // F72: distinguish a real on-chain zero from a disabled/failed read. The
  // per-call status is the only honest signal — totalStaked defaults to 0n on
  // a wrong-network/failed read, which must render "–", not a confident
  // "0 TOWELI" (the "wall of zeros reads as a dead protocol" failure mode).
  const stakedReadOk = data?.[0]?.status === 'success';
  const totalStaked = (stakedReadOk ? data![0].result as bigint : 0n);
  const totalFunded = (data?.[1]?.status === 'success' ? data[1].result as bigint : 0n);
  const rewardRate = (data?.[2]?.status === 'success' ? data[2].result as bigint : 0n);

  const totalStakedStr = formatWei(totalStaked, 18, 4);
  const totalFundedStr = formatWei(totalFunded, 18, 4);
  // Daily emissions = rewardRate (TOWELI/sec) * 86400 s/day (fixed-rate emission).
  const dailyEmissionsStr = formatWei(rewardRate * 86400n, 18, 0);

  // F85: USD-denominated TVL (additive). Surface USD as primary with the TOWELI
  // count secondary when a price is available; fall back to TOWELI-only on a
  // price outage so we never print a misleading "$0". priceInUsd is already in
  // PriceContext (effectivePrice above).
  const stakedToweliNum = Number(totalStakedStr);
  const tvlUsdNum = effectivePrice > 0 ? stakedToweliNum * effectivePrice : 0;

  return {
    tvl: !stakedReadOk ? '–' : (totalStaked > 0n ? `${stakedToweliNum.toLocaleString()} TOWELI` : '0 TOWELI'),
    /** USD value of staked TOWELI; '' when no price (caller shows TOWELI-only). */
    tvlUsd: tvlUsdNum > 0 ? formatCurrency(tvlUsdNum, tvlUsdNum >= 1000 ? 1 : 2) : '',
    toweliPrice: effectivePrice > 0 ? formatCurrency(effectivePrice, 6) : '–',
    rewardsDistributed: isDeployed ? `${Number(totalFundedStr).toLocaleString()} TOWELI` : '–',
    // Incentive headline figures surfaced via <IncentivesStrip/>.
    rewardPool: isDeployed && totalFunded > 0n ? `${Number(totalFundedStr).toLocaleString()} TOWELI` : '–',
    dailyEmissions: isDeployed && rewardRate > 0n ? `${Number(dailyEmissionsStr).toLocaleString()} TOWELI` : '–',
    isDeployed,
    isLoading,
  };
}
