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
    ],
    query: { enabled: isDeployed && onMainnet, refetchInterval: 60_000, refetchOnWindowFocus: true },
  });

  const totalStaked = (data?.[0]?.status === 'success' ? data[0].result as bigint : 0n);
  const totalFunded = (data?.[1]?.status === 'success' ? data[1].result as bigint : 0n);

  const totalStakedStr = formatWei(totalStaked, 18, 4);
  const totalFundedStr = formatWei(totalFunded, 18, 4);

  return {
    tvl: isDeployed ? (totalStaked > 0n ? `${Number(totalStakedStr).toLocaleString()} TOWELI` : '0 TOWELI') : '–',
    toweliPrice: effectivePrice > 0 ? formatCurrency(effectivePrice, 6) : '–',
    rewardsDistributed: isDeployed ? `${Number(totalFundedStr).toLocaleString()} TOWELI` : '–',
    isDeployed,
    isLoading,
  };
}
