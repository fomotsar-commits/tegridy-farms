import { useReadContracts } from 'wagmi';
import { formatEther } from 'viem';
import { TEGRIDY_STAKING_ABI } from '../lib/contracts';
import { TEGRIDY_STAKING_ADDRESS, isDeployed as checkDeployed } from '../lib/constants';
import { useTOWELIPrice } from '../contexts/PriceContext';
import { formatCurrency } from '../lib/formatting';

export function useFarmStats() {
  const addr = TEGRIDY_STAKING_ADDRESS;
  const isDeployed = checkDeployed(addr);
  const price = useTOWELIPrice();

  const effectivePrice = price.priceInUsd;

  const { data, isLoading } = useReadContracts({
    contracts: [
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalStaked' },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalRewardsFunded' },
    ],
    query: { enabled: isDeployed, refetchInterval: 60_000, refetchOnWindowFocus: true },
  });

  const totalStaked = (data?.[0]?.status === 'success' ? data[0].result as bigint : 0n);
  const totalFunded = (data?.[1]?.status === 'success' ? data[1].result as bigint : 0n);

  const totalStakedNum = Number(formatEther(totalStaked));
  const totalFundedNum = Number(formatEther(totalFunded));

  return {
    tvl: isDeployed ? (totalStakedNum > 0 ? `${totalStakedNum.toLocaleString()} TOWELI` : '0 TOWELI') : '–',
    toweliPrice: effectivePrice > 0 ? formatCurrency(effectivePrice, 6) : '–',
    rewardsDistributed: isDeployed ? `${totalFundedNum.toLocaleString()} TOWELI` : '–',
    isDeployed,
    isLoading,
  };
}
